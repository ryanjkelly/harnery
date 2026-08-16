import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import { buildEventV2 } from "../builder.ts";
import { canonicalJsonV2, sha256V2 } from "../canonical.ts";
import { adapterCapabilityProfileDigestV2 } from "../capabilities.ts";
import {
  type CandidateGenesisManifestV2,
  type CandidateProfileV2,
  candidateProfileDigestV2,
  EVENT_V2_GENESIS_MANIFEST,
  repairEventV2ControlPair,
} from "../control.ts";
import { loadOrCreateFingerprintKeyStoreV2 } from "../fingerprint-keys.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "../generated.ts";
import { readActiveLedgerV2 } from "../reader.ts";
import { eventV2Paths } from "../writer.ts";
import { recordCommandSignalV2 } from "./command-recorder.ts";
import { recordHookSignalV2 } from "./recorder.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V2 persistent session-tee recorder", () => {
  test("is inert until an exact gate and hook generation are both available", () => {
    const result = recordCommandSignalV2(commandInput(temporaryRoot(), "command-start"));
    expect(result).toEqual({ state: "gate_closed", reason: "closed" });
  });

  test("joins the exact hook turn and records a private, paired command span", () => {
    const root = startedTurnRoot();
    const secret = "TOKEN=private-command-secret";
    const start = recordCommandSignalV2({
      ...commandInput(root, "command-start"),
      observation: {
        native_command_id: "cmd-native-1",
        argv: ["toolkit", "deploy", secret],
        intent: `deploy ${secret}`,
        executable: "toolkit",
        intent_kind: "deploy",
        sensitive_argument_count: 1,
      },
    });
    const output = recordCommandSignalV2({
      ...commandInput(root, "command-output"),
      observation: {
        native_command_id: "cmd-native-1",
        native_observation_id: "cmd-native-1:output:1",
        stream: "stdout",
        output: `rendered ${secret}`,
        output_lines: 1,
      },
    });
    const duplicateOutput = recordCommandSignalV2({
      ...commandInput(root, "command-output"),
      observation: {
        native_command_id: "cmd-native-1",
        native_observation_id: "cmd-native-1:output:1",
        stream: "stdout",
        output: `rendered ${secret}`,
        output_lines: 1,
      },
    });
    const completed = recordCommandSignalV2({
      ...commandInput(root, "command-completed"),
      observation: { native_command_id: "cmd-native-1", exit_code: 0, duration_ms: 25 },
    });

    expect([start.state, output.state, duplicateOutput.state, completed.state]).toEqual([
      "recorded",
      "recorded",
      "already_recorded",
      "recorded",
    ]);
    const events = readActiveLedgerV2(root).events.map(({ event }) => event);
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
    expect(commandLinks[2]?.caused_by).toEqual([commandEvents[1]?.event_id]);
    const allPrivateAndDurable = `${readFileSync(eventV2Paths(root).active, "utf8")}\n${readPrivateProducerFiles(root)}`;
    expect(allPrivateAndDurable).not.toContain(secret);
    expect(allPrivateAndDurable).not.toContain("cmd-native-1");
    expect(allPrivateAndDurable).not.toContain("rendered");
  });

  test("replays the exact pending output event after a producer crash", () => {
    const root = startedTurnRoot();
    expect(recordCommandSignalV2(commandInput(root, "command-start")).state).toBe("recorded");
    const outputInput = {
      ...commandInput(root, "command-output"),
      observation: {
        native_command_id: "cmd-native-1",
        native_observation_id: "output-retry-1",
        output: "private output",
      },
    };
    expect(() =>
      recordCommandSignalV2({
        ...outputInput,
        writerOptions: {
          onStep: (step) => {
            if (step === "ready_published") throw new Error("simulated command producer kill");
          },
        },
      }),
    ).toThrow("simulated command producer kill");

    const recovered = recordCommandSignalV2(outputInput);
    expect(recovered.state).toBe("recorded");
    if (recovered.state === "recorded") expect(recovered.recovered).toBe(true);
    const commandEvents = readActiveLedgerV2(root).events.filter(
      ({ event }) => event.producer.component === "session-tee",
    );
    expect(commandEvents).toHaveLength(2);
    expect(commandEvents[1]?.event.producer.sequence).toBe(2);
  });

  test("replays a pending command start instead of mistaking its state file for a commit", () => {
    const root = startedTurnRoot();
    const startInput = commandInput(root, "command-start");
    expect(() =>
      recordCommandSignalV2({
        ...startInput,
        writerOptions: {
          onStep: (step) => {
            if (step === "ready_published") throw new Error("simulated start producer kill");
          },
        },
      }),
    ).toThrow("simulated start producer kill");

    const recovered = recordCommandSignalV2(startInput);
    expect(recovered.state).toBe("recorded");
    if (recovered.state === "recorded") expect(recovered.recovered).toBe(true);
    const commandEvents = readActiveLedgerV2(root).events.filter(
      ({ event }) => event.producer.component === "session-tee",
    );
    expect(commandEvents).toHaveLength(1);
    expect(commandEvents[0]?.event.event_type).toBe("command.started");
  });
});

function startedTurnRoot(): string {
  const root = candidateRoot();
  expect(
    recordHookSignalV2(hookInput(root, "session-start", parsed({ session_id: "native-session" })))
      .state,
  ).toBe("recorded");
  expect(
    recordHookSignalV2(
      hookInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: "native-session", turn_id: "turn-native", prompt: "private prompt" }),
      ),
    ).state,
  ).toBe("recorded");
  return root;
}

function commandInput(root: string, signal: Parameters<typeof recordCommandSignalV2>[0]["signal"]) {
  return {
    coordRoot: root,
    mode: "candidate" as const,
    signal,
    observation: { native_command_id: "cmd-native-1" },
    adapter: "claude-code" as const,
    native_session_id: "native-session",
    instance_id: "inst_fixture" as const,
    producer_id: "prd_session-tee" as const,
    build_id: "build_fixture" as const,
    platform: "linux" as const,
  };
}

function hookInput(
  root: string,
  signal: Parameters<typeof recordHookSignalV2>[0]["signal"],
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
  const keyStore = loadOrCreateFingerprintKeyStoreV2(
    root,
    () => new Date("2026-08-16T17:00:00.000Z"),
  );
  const profile: CandidateProfileV2 = {
    initial_schema_digest: EVENT_V2_SCHEMA_DIGEST,
    contract_source_digest: sha256V2("contract"),
    harnery_commit: "fixture",
    host_repository_commit: "fixture",
    producer_build_ids: ["build_fixture"],
    adapter_capability_profile_digests: [
      `sha256:${adapterCapabilityProfileDigestV2("claude-code").slice(4)}`,
    ],
    config_digest: sha256V2("config"),
    canonicalizer_version: "harnery-jcs-nfc-v1",
    fingerprint_version: "hmac-sha256-v1",
    privacy_key_epoch: keyStore.active_epoch_id,
    v1_terminal_digest: sha256V2("v1"),
    v1_terminal_bytes: 1,
    v1_terminal_rows: 1,
    candidate_created_at: "2026-08-16T18:00:00.000Z",
  };
  const event = buildEventV2("ledger.genesis", {
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
      genesis_profile_digest: candidateProfileDigestV2(profile),
      contract_digest: profile.contract_source_digest,
      generated_schema_digest: EVENT_V2_SCHEMA_DIGEST,
      v1_terminal_segment_digest: profile.v1_terminal_digest,
      canonicalizer: "harnery-jcs-nfc-v1",
      privacy_epoch_id: profile.privacy_key_epoch,
      candidate_created_at: profile.candidate_created_at,
    },
  });
  const manifest: CandidateGenesisManifestV2 = {
    manifest_version: 1,
    kind: "candidate_genesis",
    profile,
    event,
  };
  const path = join(root, EVENT_V2_GENESIS_MANIFEST);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${canonicalJsonV2(manifest)}\n`, { mode: 0o600 });
  expect(repairEventV2ControlPair(root).state).toBe("candidate");
  return root;
}

function readPrivateProducerFiles(root: string): string {
  const directory = join(root, ".harnery/ledgers/v2/private-producers/session-tee");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("\n");
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v2-command-recorder-"));
  roots.push(root);
  return root;
}
