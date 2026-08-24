import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import { buildEventV3 } from "../builder.ts";
import { canonicalJsonV3, sha256V3 } from "../canonical.ts";
import { adapterCapabilityProfileDigestV3 } from "../capabilities.ts";
import type { EventV3 } from "../contract.ts";
import {
  type CandidateGenesisManifestV3,
  type CandidateProfileV3,
  candidateProfileDigestV3,
  EVENT_V3_GENESIS_MANIFEST,
} from "../control.ts";
import { repairEventV3ControlPair } from "../control-writer.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "../fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "../generated.ts";
import { listLiveDisplayV3 } from "../live-feed.ts";
import { readLedgerV3 } from "../reader.ts";
import { eventV3Paths } from "../writer.ts";
import { closeAbandonedCommandSpansV3, recordCommandSignalV3 } from "./command-recorder.ts";
import { recordHookSignalV3 } from "./recorder.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V3 persistent session-tee recorder", () => {
  test("is inert until an exact gate and hook generation are both available", () => {
    const result = recordCommandSignalV3(commandInput(temporaryRoot(), "command.started"));
    expect(result).toEqual({ state: "gate_closed", reason: "closed" });
  });

  test("joins the exact hook turn and records a private, paired command span", () => {
    const root = startedTurnRoot();
    const secret = "TOKEN=private-command-secret";
    const start = recordCommandSignalV3({
      ...commandInput(root, "command.started"),
      observation: {
        native_command_id: "cmd-native-1",
        argv: ["toolkit", "deploy", secret],
        intent: `deploy ${secret}`,
        executable: "toolkit",
        intent_kind: "deploy",
        sensitive_argument_count: 1,
      },
    });
    const output = recordCommandSignalV3({
      ...commandInput(root, "command.output_observed"),
      observation: {
        native_command_id: "cmd-native-1",
        native_observation_id: "cmd-native-1:output:1",
        stream: "stdout",
        output: `rendered ${secret}`,
        output_lines: 1,
      },
    });
    const duplicateOutput = recordCommandSignalV3({
      ...commandInput(root, "command.output_observed"),
      observation: {
        native_command_id: "cmd-native-1",
        native_observation_id: "cmd-native-1:output:1",
        stream: "stdout",
        output: `rendered ${secret}`,
        output_lines: 1,
      },
    });
    const completed = recordCommandSignalV3({
      ...commandInput(root, "command.completed"),
      observation: { native_command_id: "cmd-native-1", exit_code: 0, duration_ms: 25 },
    });

    expect([start.state, output.state, duplicateOutput.state, completed.state]).toEqual([
      "recorded",
      "recorded",
      "already_recorded",
      "recorded",
    ]);
    const events = readLedgerV3(root).events.map(({ event }) => event);
    const commandEvents = events.filter((event) => event.producer.component === "session-tee");
    expect(commandEvents.map((event) => event.event_type)).toEqual([
      "command.started",
      "command.output_observed",
      "command.completed",
    ]);
    expect(commandEvents.map((event) => event.producer.sequence)).toEqual([1, 2, 3]);
    const commandLinks = commandEvents.map(
      (event) => event.links as { span_id: string; caused_by: string[] },
    );
    expect(new Set(commandLinks.map((links) => links.span_id)).size).toBe(1);
    expect(commandLinks[1]?.caused_by).toEqual([commandEvents[0]?.event_id]);
    expect(commandLinks[2]?.caused_by).toEqual([
      commandEvents[1]?.event_id,
      commandEvents[0]?.event_id,
    ]);
    const allPrivateAndDurable = `${readFileSync(eventV3Paths(root).active, "utf8")}\n${readPrivateProducerFiles(root)}`;
    expect(allPrivateAndDurable).not.toContain(secret);
    expect(allPrivateAndDurable).not.toContain("cmd-native-1");
    expect(allPrivateAndDurable).not.toContain("rendered");
    expect(JSON.stringify(listLiveDisplayV3(root))).not.toContain(secret);
  });

  test("completes a command span that straddles a mid-generation re-attestation", () => {
    const root = startedTurnRoot();
    const start = recordCommandSignalV3({
      ...commandInput(root, "command.started"),
      observation: {
        native_command_id: "cmd-native-1",
        argv: ["toolkit", "status"],
        intent: "check status",
        executable: "toolkit",
        intent_kind: "research",
        sensitive_argument_count: 0,
      },
    });
    expect(start.state).toBe("recorded");

    // The hook re-attests within the same generation and turn (runtime
    // tuning moved between command.started and command.completed).
    recordHookSignalV3(
      hookInput(
        root,
        "pre-tool-use",
        parsed({
          session_id: "native-session",
          tool_use_id: "call-1",
          tool_name: "Bash",
          effort: "high",
        }),
      ),
    );
    const change = readLedgerV3(root)
      .events.map(({ event }) => event)
      .find((event) => event.event_type === "session.attestation_changed");
    if (!change) throw new Error("expected a re-attestation within the generation");

    // The straddling span keeps its identity and completes; it used to throw
    // "V3 command producer state does not match the joined hook generation".
    const completed = recordCommandSignalV3({
      ...commandInput(root, "command.completed"),
      observation: { native_command_id: "cmd-native-1", exit_code: 0, duration_ms: 5 },
    });
    expect(completed.state).toBe("recorded");

    const commandEvents = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.producer.component === "session-tee");
    expect(commandEvents.map((event) => event.event_type)).toEqual([
      "command.started",
      "command.completed",
    ]);
    expect(commandEvents.map((event) => event.producer.sequence)).toEqual([1, 2]);
    const spans = commandEvents.map((event) => (event.links as { span_id: string }).span_id);
    expect(new Set(spans).size).toBe(1);
    expect(commandEvents[0]?.attestation_id).not.toBe(change.attestation_id);
    expect(commandEvents[1]?.attestation_id).toBe(change.attestation_id);
  });

  test("writes scrubbed command intent to the live-display overlay", () => {
    const root = startedTurnRoot();
    const start = recordCommandSignalV3({
      ...commandInput(root, "command.started"),
      observation: {
        native_command_id: "cmd-native-1",
        argv: ["rg", "ledger"],
        intent: "Inspect current ledger activity",
        executable: "rg",
        intent_kind: "research",
        sensitive_argument_count: 0,
      },
    });
    expect(start.state).toBe("recorded");
    const overlay = listLiveDisplayV3(root);
    expect(overlay).toHaveLength(1);
    expect(overlay[0]?.intent_display).toBe("Inspect current ledger activity");
    expect(overlay[0]?.executable).toBe("rg");
    if (start.state === "recorded") {
      expect(overlay[0]?.event_id).toBe(start.event.event_id);
    }
  });

  test("stamps the only open tool span as the command parent", () => {
    const root = startedTurnRoot();
    expect(
      recordHookSignalV3(
        hookInput(
          root,
          "pre-tool-use",
          parsed({ session_id: "native-session", tool_use_id: "shell-1", tool_name: "Bash" }),
        ),
      ).state,
    ).toBe("recorded");
    const tool = readLedgerV3(root).events.find(
      ({ event }) =>
        event.event_type === "tool.requested" && event.producer.component === "agent-hook",
    )?.event;
    const command = recordCommandSignalV3(commandInput(root, "command.started"));
    expect(command.state).toBe("recorded");
    if (command.state === "recorded") {
      expect(eventLinks(command.event).parent_span_id).toBe(tool && eventLinks(tool).span_id);
    }
  });

  test("selects one shell parent among parallel tools and refuses two shells", () => {
    const oneShell = startedTurnRoot();
    openTool(oneShell, "read-1", "Read");
    openTool(oneShell, "shell-1", "Bash");
    const shellSpan = readLedgerV3(oneShell).events.find(
      ({ event }) => event.event_type === "tool.requested" && toolName(event) === "Bash",
    )?.event;
    const selected = recordCommandSignalV3(commandInput(oneShell, "command.started"));
    expect(selected.state).toBe("recorded");
    if (selected.state === "recorded") {
      expect(eventLinks(selected.event).parent_span_id).toBe(
        shellSpan && eventLinks(shellSpan).span_id,
      );
    }

    const ambiguous = startedTurnRoot();
    openTool(ambiguous, "shell-1", "Bash");
    openTool(ambiguous, "shell-2", "Shell");
    const unstamped = recordCommandSignalV3(commandInput(ambiguous, "command.started"));
    expect(unstamped.state).toBe("recorded");
    if (unstamped.state === "recorded") {
      expect(eventLinks(unstamped.event).parent_span_id).toBeUndefined();
    }
  });

  test("replays the exact pending output event after a producer crash", () => {
    const root = startedTurnRoot();
    expect(recordCommandSignalV3(commandInput(root, "command.started")).state).toBe("recorded");
    const outputInput = {
      ...commandInput(root, "command.output_observed"),
      observation: {
        native_command_id: "cmd-native-1",
        native_observation_id: "output-retry-1",
        output: "private output",
      },
    };
    expect(() =>
      recordCommandSignalV3({
        ...outputInput,
        writerOptions: {
          onStep: (step) => {
            if (step === "ready_published") throw new Error("simulated command producer kill");
          },
        },
      }),
    ).toThrow("simulated command producer kill");

    const recovered = recordCommandSignalV3(outputInput);
    expect(recovered.state).toBe("recorded");
    if (recovered.state === "recorded") expect(recovered.recovered).toBe(true);
    const commandEvents = readLedgerV3(root).events.filter(
      ({ event }) => event.producer.component === "session-tee",
    );
    expect(commandEvents).toHaveLength(2);
    expect(commandEvents[1]?.event.producer.sequence).toBe(2);
  });

  test("replays a pending command start instead of mistaking its state file for a commit", () => {
    const root = startedTurnRoot();
    const startInput = commandInput(root, "command.started");
    expect(() =>
      recordCommandSignalV3({
        ...startInput,
        writerOptions: {
          onStep: (step) => {
            if (step === "ready_published") throw new Error("simulated start producer kill");
          },
        },
      }),
    ).toThrow("simulated start producer kill");

    const recovered = recordCommandSignalV3(startInput);
    expect(recovered.state).toBe("recorded");
    if (recovered.state === "recorded") expect(recovered.recovered).toBe(true);
    const commandEvents = readLedgerV3(root).events.filter(
      ({ event }) => event.producer.component === "session-tee",
    );
    expect(commandEvents).toHaveLength(1);
    expect(commandEvents[0]?.event.event_type).toBe("command.started");
  });

  test("recovers an abandoned command without reusing process-local monotonic time", () => {
    const root = startedTurnRoot();
    expect(
      recordCommandSignalV3({
        ...commandInput(root, "command.started"),
        monotonic_ns: "999999999999",
      }).state,
    ).toBe("recorded");
    const observedAt = new Date(Date.now() + 1_000).toISOString();

    expect(
      closeAbandonedCommandSpansV3({
        coordRoot: root,
        mode: "candidate",
        generation_id: commandGeneration(root),
        build_id: "build_fixture",
        platform: "linux",
        observed_at: observedAt,
      }),
    ).toEqual({ closed: 1, skipped: 0 });

    const ledger = readLedgerV3(root);
    expect(ledger.diagnostics).toEqual([]);
    const completion = ledger.events.find(
      ({ event }) =>
        event.event_type === "command.completed" && event.payload.outcome === "unknown",
    )?.event;
    expect(completion?.time.observed_at).toBe(observedAt);
    expect(completion?.time.monotonic_ns).toBeUndefined();
  });
});

function commandGeneration(root: string): `gen_${string}` {
  const started = readLedgerV3(root).events.find(
    ({ event }) => event.event_type === "command.started",
  )?.event;
  if (!started || !("generation_id" in started.scope)) throw new Error("command start missing");
  return started.scope.generation_id as `gen_${string}`;
}

function openTool(root: string, toolUseId: string, toolName: string): void {
  expect(
    recordHookSignalV3(
      hookInput(
        root,
        "pre-tool-use",
        parsed({ session_id: "native-session", tool_use_id: toolUseId, tool_name: toolName }),
      ),
    ).state,
  ).toBe("recorded");
}

function eventLinks(event: EventV3): { span_id?: string; parent_span_id?: string } {
  return event.links as { span_id?: string; parent_span_id?: string };
}

function toolName(event: EventV3): string | undefined {
  const payload = event.payload as { tool?: { name?: unknown } };
  return typeof payload.tool?.name === "string" ? payload.tool.name : undefined;
}

function startedTurnRoot(): string {
  const root = candidateRoot();
  expect(
    recordHookSignalV3(hookInput(root, "session-start", parsed({ session_id: "native-session" })))
      .state,
  ).toBe("recorded");
  expect(
    recordHookSignalV3(
      hookInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: "native-session", turn_id: "turn-native", prompt: "private prompt" }),
      ),
    ).state,
  ).toBe("recorded");
  return root;
}

function commandInput(root: string, signal: Parameters<typeof recordCommandSignalV3>[0]["signal"]) {
  return {
    coordRoot: root,
    mode: "candidate" as const,
    signal,
    observation: { native_command_id: "cmd-native-1" },
    adapter: "claude-code" as const,
    instance_id: "inst_fixture" as const,
    producer_id: "prd_session-tee" as const,
    build_id: "build_fixture" as const,
    platform: "linux" as const,
  };
}

function hookInput(
  root: string,
  signal: Parameters<typeof recordHookSignalV3>[0]["signal"],
  payload: ParsedPayload,
) {
  return {
    coordRoot: root,
    mode: "candidate" as const,
    signal,
    payload,
    adapter: "claude-code" as const,
    instance_id: "inst_fixture" as const,
    producer_id: "prd_hook" as const,
    build_id: "build_fixture" as const,
    platform: "linux" as const,
  };
}

function parsed(values: Partial<ParsedPayload>): ParsedPayload {
  return { raw: {}, ...values };
}

function candidateRoot(): string {
  const root = temporaryRoot();
  const keyStore = loadOrCreateFingerprintKeyStoreV3(
    root,
    () => new Date("2026-08-16T17:00:00.000Z"),
  );
  const profile: CandidateProfileV3 = {
    initial_schema_digest: EVENT_V3_SCHEMA_DIGEST,
    contract_source_digest: sha256V3("contract"),
    harnery_commit: "fixture",
    host_repository_commit: "fixture",
    producer_build_ids: ["build_fixture"],
    adapter_capability_profile_digests: [
      `sha256:${adapterCapabilityProfileDigestV3("claude-code").slice(4)}`,
    ],
    config_digest: sha256V3("config"),
    canonicalizer_version: "harnery-jcs-nfc-v1",
    fingerprint_version: "hmac-sha256-v1",
    privacy_key_epoch: keyStore.active_epoch_id,
    candidate_created_at: "2026-08-16T18:00:00.000Z",
  };
  const event = buildEventV3("ledger.genesis", {
    producer: {
      producer_id: "prd_cutover",
      boot_id: "boot_cutover",
      sequence: 1,
      component: "recovery",
      build_id: "build_fixture",
      platform: "linux",
    },
    scope: { root_id: "root_fixture", instance_id: "inst_cutover" },
    links: { caused_by: [] },
    provenance: {
      source_event: "cutover.genesis",
      attestation: "operator",
      confidence: "exact",
      attribution: {
        method: "explicit_argument",
        state: "verified",
        subject_instance_id: "inst_cutover",
      },
    },
    payload: {
      genesis_id: "gex_00000000-0000-0000-0000-000000000001",
      genesis_profile_digest: candidateProfileDigestV3(profile),
      contract_digest: profile.contract_source_digest,
      generated_schema_digest: EVENT_V3_SCHEMA_DIGEST,
      canonicalizer: "harnery-jcs-nfc-v1",
      privacy_epoch_id: profile.privacy_key_epoch,
      candidate_created_at: profile.candidate_created_at,
    },
  });
  const manifest: CandidateGenesisManifestV3 = {
    manifest_version: 1,
    kind: "candidate_genesis",
    profile,
    event,
  };
  const path = join(root, EVENT_V3_GENESIS_MANIFEST);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${canonicalJsonV3(manifest)}\n`, { mode: 0o600 });
  const repaired = repairEventV3ControlPair(root);
  if (repaired.state !== "candidate") throw new Error(JSON.stringify(repaired));
  return root;
}

function readPrivateProducerFiles(root: string): string {
  const directory = join(root, ".harnery/ledgers/v3/private-producers/session-tee");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("\n");
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-command-recorder-"));
  roots.push(root);
  return root;
}
