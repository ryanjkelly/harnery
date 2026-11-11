import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeDir } from "../../../../../tests/helpers/remove-dir.ts";
import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import {
  COMMAND_ACROSS_TURNS_V3,
  COMMAND_TURN_SESSION_ID,
  COMMAND_WITHOUT_TURN_V3,
  type CommandTurnStepV3,
  commandObservationV3,
} from "../__fixtures__/command-turns.ts";
import { adjacentAdditiveDigestsV3 } from "../__fixtures__/ledger-replay.ts";
import { restampStoredEventDigestsV3 } from "../__fixtures__/stored-event-digest.ts";
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
import { EVENT_V3_SCHEMA_DIGEST, EVENT_V3_SCHEMA_LINEAGE } from "../generated.ts";
import { projectLatencyV3 } from "../latency.ts";
import { listLiveDisplayV3 } from "../live-feed.ts";
import {
  eventV3ControlCheckpointPathV3,
  eventV3ControlWitnessPathV3,
  readLedgerV3,
} from "../reader.ts";
import { eventV3Paths } from "../writer.ts";
import { closeAbandonedCommandSpansV3, recordCommandSignalV3 } from "./command-recorder.ts";
import { readHookProducerStateByInstanceV3, recordHookSignalV3 } from "./recorder.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
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

  test("F3 replays a pending command event stamped with the previous additive digest after an upgrade", () => {
    const root = startedTurnRoot();
    const startInput = commandInput(root, "command.started");
    expect(() =>
      recordCommandSignalV3({
        ...startInput,
        writerOptions: {
          onStep: (step) => {
            if (step === "ready_temp_flushed") throw new Error("simulated start producer kill");
          },
        },
      }),
    ).toThrow("simulated start producer kill");
    const { older } = adjacentAdditiveDigestsV3();
    expect(restampStoredEventDigestsV3(root, older)).toBe(1);

    const recovered = recordCommandSignalV3(startInput);
    expect(recovered.state).toBe("recorded");
    if (recovered.state === "recorded") {
      expect(recovered.recovered).toBe(true);
      expect(recovered.durability.state).toBe("committed");
    }
    const read = readLedgerV3(root);
    expect(read).toMatchObject({ complete: true, diagnostics: [] });
    const commandEvents = read.events.filter(
      ({ event }) => event.producer.component === "session-tee",
    );
    expect(commandEvents.map(({ event }) => event.contract.schema_digest)).toEqual([older]);
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

describe("event ledger V3 commands outside an open turn (d)", () => {
  test("a command with no open turn records its start, output and completion with its session and no turn", () => {
    const root = candidateRoot();
    expect(runCommandTurnSteps(root, COMMAND_WITHOUT_TURN_V3)).toEqual([
      "recorded",
      "recorded",
      "recorded",
      "recorded",
    ]);
    const read = readLedgerV3(root);
    expect(read.diagnostics).toEqual([]);
    const session = read.events.find(({ event }) => event.event_type === "session.started")?.event;
    if (!session || !("generation_id" in session.scope)) throw new Error("session start missing");
    const commands = sessionTeeEvents(root);
    expect(commands.map((event) => event.event_type)).toEqual([
      "command.started",
      "command.output_observed",
      "command.completed",
    ]);
    for (const event of commands) {
      expect(event.scope).toMatchObject({
        session_id: session.scope.session_id,
        generation_id: session.scope.generation_id,
      });
      expect("turn_id" in event.scope).toBeFalse();
    }
    expect(new Set(commands.map((event) => eventLinks(event).span_id)).size).toBe(1);
  });

  test("a command with no open turn takes the session span as its parent", () => {
    const root = candidateRoot();
    runCommandTurnSteps(root, COMMAND_WITHOUT_TURN_V3);
    const hook = readHookProducerStateByInstanceV3(root, "inst_fixture");
    if (!hook) throw new Error("hook state missing");
    for (const event of sessionTeeEvents(root)) {
      expect(eventLinks(event).parent_span_id).toBe(hook.session_span.span_id);
    }
  });

  test("a command with no open turn writes no command_emit_unjoinable diagnostic", () => {
    const root = candidateRoot();
    runCommandTurnSteps(root, COMMAND_WITHOUT_TURN_V3);
    const diagnostics = join(root, ".harnery/ledgers/v3/diagnostics");
    const names = existsSync(diagnostics) ? readdirSync(diagnostics) : [];
    expect(names.filter((name) => name.startsWith("command_emit_unjoinable-"))).toEqual([]);
  });

  test("a command whose completion crosses a turn end and the next turn start keeps one span and its original turn", () => {
    const root = candidateRoot();
    expect(runCommandTurnSteps(root, COMMAND_ACROSS_TURNS_V3)).toEqual([
      "recorded",
      "recorded",
      "recorded",
      "recorded",
      "recorded",
      "recorded",
    ]);
    const read = readLedgerV3(root);
    expect(read.diagnostics).toEqual([]);
    const turns = read.events
      .map(({ event }) => event)
      .filter((event) => event.event_type === "turn.started")
      .map((event) => (event.scope as { turn_id: string }).turn_id);
    expect(turns).toHaveLength(2);
    const commands = sessionTeeEvents(root);
    expect(commands.map((event) => event.event_type)).toEqual([
      "command.started",
      "command.completed",
    ]);
    expect(commands.map((event) => (event.scope as { turn_id?: string }).turn_id)).toEqual([
      turns[0],
      turns[0],
    ]);
    expect(new Set(commands.map((event) => eventLinks(event).span_id)).size).toBe(1);
  });

  test("a command started outside a turn completes without a turn after the first prompt", () => {
    const root = candidateRoot();
    const steps: CommandTurnStepV3[] = [
      { kind: "hook", signal: "session-start" },
      { kind: "command", signal: "command.started", native_command_id: "cmd-into-turn" },
      { kind: "hook", signal: "user-prompt-submit", turn_id: "turn-after" },
      { kind: "command", signal: "command.completed", native_command_id: "cmd-into-turn" },
    ];
    expect(runCommandTurnSteps(root, steps)).toEqual([
      "recorded",
      "recorded",
      "recorded",
      "recorded",
    ]);
    expect(readLedgerV3(root).diagnostics).toEqual([]);
    for (const event of sessionTeeEvents(root)) expect("turn_id" in event.scope).toBeFalse();
  });

  test("one epoch holding command rows of the previous digest and the current one reads complete", () => {
    const previous = EVENT_V3_SCHEMA_LINEAGE.groups.at(-1)?.at(-2);
    if (!previous) throw new Error("expected an earlier digest in the runtime's additive group");
    const root = candidateRoot();
    const steps: CommandTurnStepV3[] = [
      { kind: "hook", signal: "session-start" },
      { kind: "hook", signal: "user-prompt-submit", turn_id: "turn-before" },
      { kind: "command", signal: "command.started", native_command_id: "cmd-before" },
      { kind: "command", signal: "command.completed", native_command_id: "cmd-before" },
      { kind: "hook", signal: "stop", turn_id: "turn-before" },
      { kind: "command", signal: "command.started", native_command_id: "cmd-between" },
      { kind: "command", signal: "command.completed", native_command_id: "cmd-between" },
      { kind: "hook", signal: "user-prompt-submit", turn_id: "turn-after" },
      { kind: "command", signal: "command.started", native_command_id: "cmd-after" },
      { kind: "command", signal: "command.completed", native_command_id: "cmd-after" },
      { kind: "hook", signal: "stop", turn_id: "turn-after" },
    ];
    expect(runCommandTurnSteps(root, steps).every((state) => state === "recorded")).toBeTrue();
    const before = readLedgerV3(root);
    expect(before.diagnostics).toEqual([]);
    const firstTurn = sessionTeeEvents(root)[0]?.scope as { turn_id?: string } | undefined;
    if (!firstTurn?.turn_id) throw new Error("expected the first command inside a turn");

    // Rewrite the first turn's command rows as a runtime on the previous
    // digest wrote them: with turn_id, which that schema required.
    const restamped = restampRows(
      root,
      (event) =>
        event.producer.component === "session-tee" &&
        (event.scope as { turn_id?: string }).turn_id === firstTurn.turn_id,
      previous,
    );
    expect(restamped).toBe(2);

    const after = readLedgerV3(root);
    expect(after.complete).toBeTrue();
    expect(after.diagnostics).toEqual([]);
    const commands = after.events
      .map(({ event }) => event)
      .filter((event) => event.producer.component === "session-tee");
    const shapes = commands.map((event) => ({
      digest: event.contract.schema_digest,
      turn: "turn_id" in event.scope,
    }));
    expect(shapes).toEqual([
      { digest: previous, turn: true },
      { digest: previous, turn: true },
      { digest: EVENT_V3_SCHEMA_DIGEST, turn: false },
      { digest: EVENT_V3_SCHEMA_DIGEST, turn: false },
      { digest: EVENT_V3_SCHEMA_DIGEST, turn: true },
      { digest: EVENT_V3_SCHEMA_DIGEST, turn: true },
    ]);

    const latency = projectLatencyV3(after);
    expect(latency).toEqual(projectLatencyV3(before));
    expect(latency.diagnostics).toEqual([]);
    expect(latency.turns.map((turn) => turn.span_counts.command)).toEqual([1, 1]);
    // Turn telemetry lives on each turn terminal; the restamp leaves it as recorded.
    expect(turnTelemetry(after)).toEqual(turnTelemetry(before));
  });

  test("turn rollups skip a command with no turn and session totals count it", () => {
    const root = candidateRoot();
    const steps: CommandTurnStepV3[] = [
      ...COMMAND_WITHOUT_TURN_V3,
      { kind: "hook", signal: "user-prompt-submit", turn_id: "turn-rollup" },
      { kind: "command", signal: "command.started", native_command_id: "cmd-in-turn" },
      { kind: "command", signal: "command.completed", native_command_id: "cmd-in-turn" },
      { kind: "hook", signal: "stop", turn_id: "turn-rollup" },
    ];
    expect(runCommandTurnSteps(root, steps).every((state) => state === "recorded")).toBeTrue();
    const read = readLedgerV3(root);
    expect(read.diagnostics).toEqual([]);
    const completions = sessionTeeEvents(root).filter(
      (event) => event.event_type === "command.completed",
    );
    expect(completions).toHaveLength(2);
    const latency = projectLatencyV3(read);
    expect(latency.diagnostics).toEqual([]);
    expect(latency.turns).toHaveLength(1);
    expect(latency.turns[0]?.span_counts.command).toBe(1);
  });
});

/** Drive one signal script; hooks report their state, commands their whole result. */
function runCommandTurnSteps(root: string, steps: readonly CommandTurnStepV3[]): unknown[] {
  return steps.map((step) => {
    if (step.kind === "hook") {
      const payload = parsed({
        session_id: COMMAND_TURN_SESSION_ID,
        ...(step.turn_id ? { turn_id: step.turn_id, prompt: "private prompt" } : {}),
      });
      return recordHookSignalV3(hookInput(root, step.signal, payload)).state;
    }
    const result = recordCommandSignalV3({
      ...commandInput(root, step.signal),
      observation: commandObservationV3(step),
    });
    return result.state === "generation_unavailable" ? result : result.state;
  });
}

/**
 * Restamp matching rows of the active file with another schema digest, as a
 * runtime on that digest would have written them. Digests have one length, so
 * every row keeps its byte length; the witness and checkpoint are removed so
 * the next read starts from the rows.
 */
function restampRows(root: string, match: (event: EventV3) => boolean, digest: string): number {
  const active = eventV3Paths(root).active;
  let count = 0;
  const rows = readFileSync(active, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const event = JSON.parse(row) as EventV3;
      if (!match(event)) return row;
      count += 1;
      (event.contract as { schema_digest: string }).schema_digest = digest;
      return canonicalJsonV3(event);
    });
  writeFileSync(active, rows.map((row) => `${row}\n`).join(""));
  rmSync(eventV3ControlWitnessPathV3(root), { force: true });
  rmSync(eventV3ControlCheckpointPathV3(root), { force: true });
  return count;
}

function turnTelemetry(read: ReturnType<typeof readLedgerV3>): unknown[] {
  return read.events
    .map(({ event }) => event)
    .filter((event) => event.event_type === "turn.completed")
    .map((event) => {
      const payload = event.payload as Record<string, unknown>;
      return { usage: payload.usage, inference: payload.inference, harness: payload.harness };
    });
}

function sessionTeeEvents(root: string): EventV3[] {
  return readLedgerV3(root)
    .events.map(({ event }) => event)
    .filter((event) => event.producer.component === "session-tee");
}

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
