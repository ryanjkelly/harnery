import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
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
import type { Adapter } from "../../../adapter.ts";
import { readCodexArchiveObservationsV3 } from "../../../agents/codex-archive-v3.ts";
import {
  listSessionFinalizationRequestsV3,
  observeHostDisappearedV3,
  reconcileSessionFinalizationV3,
  requestSessionEndExplicitV3,
} from "../../../agents/session-finalizer-v3.ts";
import { type ParsedPayload, parsePayload } from "../../../hooks/adapter/parse.ts";
import { clearRuntimeTelemetryCachesForTest } from "../../../hooks/adapter/runtime-telemetry.ts";
import { acquireNoClobberLease } from "../../../workflow/workspaces/leases.ts";
import { buildEventV3 } from "../builder.ts";
import { canonicalJsonV3, sha256V3 } from "../canonical.ts";
import { adapterCapabilityProfileDigestV3 } from "../capabilities.ts";
import {
  type CandidateGenesisManifestV3,
  type CandidateProfileV3,
  candidateProfileDigestV3,
  EVENT_V3_GENESIS_MANIFEST,
} from "../control.ts";
import { repairEventV3ControlPair } from "../control-writer.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "../fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "../generated.ts";
import { projectLatencyV3 } from "../latency.ts";
import { readLedgerV3 } from "../reader.ts";
import { eventV3Paths } from "../writer.ts";
import {
  drainHookIntakeSpoolV3,
  readHookProducerStateV3,
  reconcilePendingRuntimeContextV3,
  recordApprovedSessionEndV3,
  recordHookSignalV3,
} from "./recorder.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V3 persistent hook recorder", () => {
  test("is inert without an exact candidate or active gate", () => {
    const result = recordHookSignalV3({
      ...baseInput(temporaryRoot(), "session-start", parsed({ session_id: "native" })),
      mode: "active",
    });
    expect(result).toEqual({ state: "gate_closed", reason: "closed" });
  });

  test("preserves generation, sequence, turn, span, timing, and privacy across hook processes", () => {
    const root = candidateRoot();
    const nativeSession = "native-account-session";
    const start = recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession, model: "sonnet" })),
    );
    const turn = recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "turn-secret", prompt: "patient secret" }),
      ),
    );
    const requested = recordHookSignalV3({
      ...baseInput(
        root,
        "pre-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "tool-secret",
          tool_name: "Read",
          tool_input: { file_path: "/workspace/project/src/index.ts", token: "API_SECRET_123" },
        }),
      ),
      monotonic_ns: "1000000000",
    });
    const completed = recordHookSignalV3({
      ...baseInput(
        root,
        "post-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "tool-secret",
          tool_name: "Read",
          tool_response: "private output",
        }),
      ),
      monotonic_ns: "1250000000",
    });

    expect([start.state, turn.state, requested.state, completed.state]).toEqual([
      "recorded",
      "recorded",
      "recorded",
      "recorded",
    ]);
    expect(existsSync(join(root, ".harnery/private/v3-producers"))).toBeFalse();
    expect(
      readdirSync(join(root, ".harnery/ledgers/v3/private-producers/claude-code")).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(1);
    const events = readLedgerV3(root).events.map(({ event }) => event);
    const hookEvents = events.filter((event) => event.producer.producer_id === "prd_hook");
    expect(hookEvents.map((event) => event.producer.sequence)).toEqual([1, 2, 3, 4]);
    expect(
      new Set(hookEvents.map((event) => (event.scope as { generation_id: string }).generation_id))
        .size,
    ).toBe(1);
    expect((hookEvents[0]?.links as { caused_by: string[] }).caused_by).toEqual([
      events[0]?.event_id,
    ]);
    const toolEvents = hookEvents.filter(
      (event) => event.event_type === "tool.requested" || event.event_type === "tool.completed",
    );
    expect(
      new Set(toolEvents.map((event) => (event.links as { span_id: string }).span_id)).size,
    ).toBe(1);
    const completion = hookEvents.find((event) => event.event_type === "tool.completed");
    expect(completion?.payload.duration_ms).toEqual({
      state: "observed",
      value: 250,
      attestation: "native",
      confidence: "exact",
    });
    const durable = readFileSync(eventV3Paths(root).active, "utf8");
    const state = readHookProducerStateV3(root, "claude-code", nativeSession);
    expect(`${durable}${JSON.stringify(state)}`).not.toContain("patient secret");
    expect(`${durable}${JSON.stringify(state)}`).not.toContain("API_SECRET_123");
    expect(`${durable}${JSON.stringify(state)}`).not.toContain("private output");
    expect(`${durable}${JSON.stringify(state)}`).not.toContain(nativeSession);
  });

  test("keeps mid-flight tool counts in their original turn scope", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-mid-flight-tool-scope";
    const recordTool = (turnId: string, toolId: string) => {
      const payload = parsed({
        session_id: nativeSession,
        turn_id: turnId,
        tool_use_id: toolId,
        tool_name: "Bash",
      });
      expect(recordHookSignalV3(baseInput(root, "pre-tool-use", payload, "codex")).state).toBe(
        "recorded",
      );
      expect(recordHookSignalV3(baseInput(root, "post-tool-use", payload, "codex")).state).toBe(
        "recorded",
      );
    };

    for (let index = 0; index < 9; index += 1) {
      recordTool("pre-boundary", `pre-boundary-${index}`);
    }
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "native-turn-one" }),
        "codex",
      ),
    );
    for (let index = 0; index < 4; index += 1) {
      recordTool("native-turn-one", `native-one-${index}`);
    }
    recordHookSignalV3(
      baseInput(
        root,
        "stop",
        parsed({ session_id: nativeSession, turn_id: "native-turn-one" }),
        "codex",
      ),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "native-turn-two" }),
        "codex",
      ),
    );
    for (let index = 0; index < 2; index += 1) {
      recordTool("native-turn-two", `native-two-${index}`);
    }
    recordHookSignalV3(
      baseInput(
        root,
        "stop",
        parsed({ session_id: nativeSession, turn_id: "native-turn-two" }),
        "codex",
      ),
    );

    const ledger = readLedgerV3(root);
    const events = ledger.events.map(({ event }) => event);
    const requests = events.filter((event) => event.event_type === "tool.requested");
    const toolTerminals = events.filter((event) => event.event_type === "tool.completed");
    const turnTerminals = events.filter((event) => event.event_type === "turn.completed");
    expect(requests).toHaveLength(15);
    expect(toolTerminals).toHaveLength(15);
    expect(turnTerminals).toHaveLength(2);

    for (const terminal of turnTerminals) {
      if (terminal.event_type !== "turn.completed") continue;
      const turnId = (terminal.scope as { turn_id: string }).turn_id;
      const scopedRequests = requests.filter(
        (event) => (event.scope as { turn_id?: string }).turn_id === turnId,
      );
      expect(terminal.payload.tool_call_count).toEqual({
        state: "observed",
        value: scopedRequests.length,
        attestation: "derived",
        confidence: "exact",
      });
    }
    expect(
      turnTerminals.map((terminal) =>
        terminal.event_type === "turn.completed" &&
        terminal.payload.tool_call_count.state === "observed"
          ? terminal.payload.tool_call_count.value
          : undefined,
      ),
    ).toEqual([4, 2]);
    for (const turn of projectLatencyV3(ledger).turns) {
      if (turn.tool_ms.state === "unknown") {
        expect(turn.tool_ms.reasons).not.toContain("tool_terminal_count_mismatch");
      }
    }
  }, 30_000);

  test("keeps one canonical start when Codex repeats a prompt inside an open turn", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-repeated-prompt";
    const nativeTurn = "native-turn";
    const recordTool = (toolId: string, opened: string, closed: string) => {
      const payload = parsed({
        session_id: nativeSession,
        turn_id: nativeTurn,
        tool_use_id: toolId,
        tool_name: "Bash",
        tool_input: { command: `private-${toolId}` },
      });
      recordHookSignalV3({
        ...baseInput(root, "pre-tool-use", payload, "codex"),
        monotonic_ns: opened,
      });
      recordHookSignalV3({
        ...baseInput(
          root,
          "post-tool-use",
          parsed({ ...payload, tool_response: `private-response-${toolId}` }),
          "codex",
        ),
        monotonic_ns: closed,
      });
    };

    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    const firstObservedAt = new Date().toISOString();
    const firstStart = recordHookSignalV3({
      ...baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: nativeTurn, prompt: "private prompt one" }),
        "codex",
      ),
      observed_at: firstObservedAt,
      monotonic_ns: "1000000000",
      hook_name: "UserPromptSubmit",
      hook_duration_ms: 5,
    });
    recordTool("tool-one", "2000000000", "3000000000");
    const secondStart = recordHookSignalV3({
      ...baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: nativeTurn, prompt: "private prompt two" }),
        "codex",
      ),
      monotonic_ns: "4000000000",
      hook_name: "UserPromptSubmit",
      hook_duration_ms: 6,
    });
    recordTool("tool-two", "5000000000", "6000000000");
    const thirdStart = recordHookSignalV3({
      ...baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: nativeTurn, prompt: "private prompt three" }),
        "codex",
      ),
      monotonic_ns: "7000000000",
      hook_name: "UserPromptSubmit",
      hook_duration_ms: 7,
    });
    recordTool("tool-three", "8000000000", "9000000000");
    recordHookSignalV3({
      ...baseInput(
        root,
        "stop",
        parsed({ session_id: nativeSession, turn_id: nativeTurn }),
        "codex",
      ),
      monotonic_ns: "10000000000",
    });

    expect(firstStart.state).toBe("recorded");
    expect(secondStart).toEqual({ state: "ignored" });
    expect(thirdStart).toEqual({ state: "ignored" });
    const ledger = readLedgerV3(root);
    const events = ledger.events.map(({ event }) => event);
    const starts = events.filter((event) => event.event_type === "turn.started");
    const requests = events.filter((event) => event.event_type === "tool.requested");
    const toolTerminals = events.filter((event) => event.event_type === "tool.completed");
    const terminal = events.find((event) => event.event_type === "turn.completed");
    expect(starts).toHaveLength(1);
    expect(requests).toHaveLength(3);
    expect(toolTerminals).toHaveLength(3);
    if (starts[0]?.event_type !== "turn.started" || terminal?.event_type !== "turn.completed") {
      throw new Error("turn boundary fixture did not close");
    }
    expect(terminal.payload.span.open_event_id).toBe(starts[0].event_id);
    expect(terminal.payload.span.opened_at).toBe(starts[0].time.observed_at);
    expect(terminal.payload.tool_call_count).toMatchObject({ state: "observed", value: 3 });
    expect(terminal.payload.harness).toMatchObject({
      state: "observed",
      value: {
        hook_time_ms: 18,
        hook_count: 3,
        slowest_hook: "UserPromptSubmit",
        slowest_hook_ms: 7,
      },
    });
    expect(
      new Set(
        [...requests, ...toolTerminals, terminal].map(
          (event) => (event.scope as { turn_id: string }).turn_id,
        ),
      ).size,
    ).toBe(1);
    expect(readHookProducerStateV3(root, "codex", nativeSession)?.turn_ordinal).toBe(1);

    const diagnosticsDir = join(root, ".harnery/ledgers/v3/diagnostics");
    const diagnostics = readdirSync(diagnosticsDir)
      .filter((name) => name.startsWith("duplicate_turn_start_suppressed-"))
      .map((name) => readFileSync(join(diagnosticsDir, name), "utf8"));
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.join("\n")).not.toContain("private prompt");
    const durable = readFileSync(eventV3Paths(root).active, "utf8");
    expect(`${durable}\n${diagnostics.join("\n")}`).not.toContain("private-tool");
    expect(`${durable}\n${diagnostics.join("\n")}`).not.toContain("private-response");
  });

  test("keeps Claude post-stop tools out of the next native turn", () => {
    const root = candidateRoot("claude-code");
    const nativeSession = "claude-post-stop-tools";
    const postStopRequestIds: string[] = [];
    const recordTool = (turnId: string, toolId: string, collect = false) => {
      const payload = parsed({
        session_id: nativeSession,
        turn_id: turnId,
        tool_use_id: toolId,
        tool_name: "Bash",
      });
      const request = recordHookSignalV3(baseInput(root, "pre-tool-use", payload, "claude-code"));
      expect(request.state).toBe("recorded");
      if (collect && request.state === "recorded") {
        postStopRequestIds.push(request.event.event_id);
      }
      expect(
        recordHookSignalV3(baseInput(root, "post-tool-use", payload, "claude-code")).state,
      ).toBe("recorded");
    };

    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "claude-code"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "claude-turn-one" }),
        "claude-code",
      ),
    );
    recordTool("claude-turn-one", "first-turn-tool");

    // The first Stop is lost. A different native prompt must close turn one
    // before opening a fresh canonical span for turn two.
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "claude-turn-two" }),
        "claude-code",
      ),
    );
    recordTool("claude-turn-two", "second-turn-tool");
    recordHookSignalV3(
      baseInput(
        root,
        "stop",
        parsed({ session_id: nativeSession, turn_id: "claude-turn-two" }),
        "claude-code",
      ),
    );

    for (let index = 0; index < 34; index += 1) {
      recordTool("claude-turn-two", `post-stop-${index}`, true);
    }

    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "claude-turn-three" }),
        "claude-code",
      ),
    );
    for (let index = 0; index < 6; index += 1) {
      recordTool("claude-turn-three", `third-turn-${index}`);
    }
    recordHookSignalV3(
      baseInput(
        root,
        "stop",
        parsed({ session_id: nativeSession, turn_id: "claude-turn-three" }),
        "claude-code",
      ),
    );

    const ledger = readLedgerV3(root);
    const events = ledger.events.map(({ event }) => event);
    const starts = events.filter((event) => event.event_type === "turn.started");
    const turnTerminals = events.filter((event) => event.event_type === "turn.completed");
    const requests = events.filter((event) => event.event_type === "tool.requested");
    const toolTerminals = events.filter((event) => event.event_type === "tool.completed");
    expect(starts).toHaveLength(4);
    expect(turnTerminals).toHaveLength(4);
    expect(requests).toHaveLength(42);
    expect(toolTerminals).toHaveLength(42);

    for (const terminal of turnTerminals) {
      if (terminal.event_type !== "turn.completed") continue;
      const turnId = (terminal.scope as { turn_id: string }).turn_id;
      const start = starts.find(
        (candidate) => (candidate.scope as { turn_id?: string }).turn_id === turnId,
      );
      if (start?.event_type !== "turn.started") throw new Error("turn start missing");
      expect(terminal.payload.span.open_event_id).toBe(start.event_id);
      expect(terminal.payload.span.opened_at).toBe(start.time.observed_at);
    }

    const exactCounts = turnTerminals.map((terminal) =>
      terminal.event_type === "turn.completed" &&
      terminal.payload.tool_call_count.state === "observed"
        ? terminal.payload.tool_call_count.value
        : undefined,
    );
    expect(exactCounts).toEqual([1, 1, 34, 6]);

    const closedNativeTurnId = (starts[1]?.scope as { turn_id: string }).turn_id;
    const recoveryTurnId = (starts[2]?.scope as { turn_id: string }).turn_id;
    const postStopRequests = events.filter((event) => postStopRequestIds.includes(event.event_id));
    expect(postStopRequests).toHaveLength(34);
    expect(
      new Set(postStopRequests.map((event) => (event.scope as { turn_id: string }).turn_id)),
    ).toEqual(new Set([recoveryTurnId]));
    expect(recoveryTurnId).not.toBe(closedNativeTurnId);

    for (const turn of projectLatencyV3(ledger).turns) {
      if (turn.tool_ms.state === "unknown") {
        expect(turn.tool_ms.reasons).not.toContain("tool_terminal_count_mismatch");
      }
    }
  }, 30_000);

  test("keeps different Cursor prompt ids inside one canonical turn", () => {
    const root = candidateRoot("cursor");
    const nativeSession = "cursor-steering-prompts";
    const epochMs = Date.parse("2026-08-19T12:00:00.000Z");
    const at = (monotonicNs: string) =>
      new Date(epochMs + Number(BigInt(monotonicNs) / 1_000_000n)).toISOString();
    const prompt = (turnId: string, monotonicNs: string, body: string) =>
      recordHookSignalV3({
        ...baseInput(
          root,
          "user-prompt-submit",
          parsed({
            conversation_id: nativeSession,
            turn_id: turnId,
            prompt: body,
          }),
          "cursor",
        ),
        observed_at: at(monotonicNs),
        monotonic_ns: monotonicNs,
      });
    const stop = (turnId: string, monotonicNs: string) =>
      recordHookSignalV3({
        ...baseInput(
          root,
          "stop",
          parsed({ conversation_id: nativeSession, turn_id: turnId }),
          "cursor",
        ),
        observed_at: at(monotonicNs),
        monotonic_ns: monotonicNs,
      });

    recordHookSignalV3({
      ...baseInput(root, "session-start", parsed({ conversation_id: nativeSession }), "cursor"),
      observed_at: at("0"),
      monotonic_ns: "0",
    });

    expect(prompt("cursor-turn-one", "1000000000", "private first prompt").state).toBe("recorded");
    expect(prompt("cursor-steering-one", "1239040000000", "private steering prompt one")).toEqual({
      state: "ignored",
    });
    expect(stop("cursor-steering-one", "1800020000000").state).toBe("recorded");

    expect(prompt("cursor-turn-two", "1801021000000", "private second prompt").state).toBe(
      "recorded",
    );
    expect(stop("cursor-turn-two", "1802021000000").state).toBe("recorded");

    expect(prompt("cursor-turn-three", "2000000000000", "private third prompt").state).toBe(
      "recorded",
    );
    expect(
      prompt("cursor-steering-three", "2131120000000", "private steering prompt three"),
    ).toEqual({ state: "ignored" });
    expect(stop("cursor-steering-three", "4690740000000").state).toBe("recorded");

    expect(prompt("cursor-turn-four", "4691000000000", "private fourth prompt").state).toBe(
      "recorded",
    );
    expect(stop("cursor-turn-four", "4692000000000").state).toBe("recorded");

    const ledger = readLedgerV3(root);
    const events = ledger.events.map(({ event }) => event);
    const starts = events.filter((event) => event.event_type === "turn.started");
    const terminals = events.filter((event) => event.event_type === "turn.completed");
    expect(starts).toHaveLength(4);
    expect(terminals).toHaveLength(4);
    expect(
      terminals.map((event) =>
        event.event_type === "turn.completed" && event.payload.span.duration_ms.state === "observed"
          ? event.payload.span.duration_ms.value
          : undefined,
      ),
    ).toEqual([1_799_020, 1_000, 2_690_740, 1_000]);

    for (const terminal of terminals) {
      if (terminal.event_type !== "turn.completed") continue;
      const turnId = (terminal.scope as { turn_id: string }).turn_id;
      const start = starts.find(
        (candidate) => (candidate.scope as { turn_id?: string }).turn_id === turnId,
      );
      if (start?.event_type !== "turn.started") throw new Error("Cursor turn start missing");
      expect(terminal.payload.span.open_event_id).toBe(start.event_id);
      expect(terminal.payload.span.opened_at).toBe(start.time.observed_at);
      expect((terminal.links as { span_id?: string }).span_id).toBe(
        (start.links as { span_id?: string }).span_id,
      );
      if (terminal.payload.span.duration_ms.state !== "observed") {
        throw new Error("Cursor turn duration missing");
      }
      expect(terminal.payload.span.duration_ms.value).toBe(
        Date.parse(terminal.time.observed_at) - Date.parse(start.time.observed_at),
      );
    }

    const latency = projectLatencyV3(ledger);
    expect(latency.turns).toHaveLength(4);
    expect(latency.diagnostics.map(({ code }) => code)).not.toContain("span_outside_turn");
    expect(readHookProducerStateV3(root, "cursor", nativeSession)?.turn_ordinal).toBe(4);

    const diagnosticsDir = join(root, ".harnery/ledgers/v3/diagnostics");
    const diagnostics = readdirSync(diagnosticsDir)
      .filter((name) => name.startsWith("duplicate_turn_start_suppressed-"))
      .map((name) => readFileSync(join(diagnosticsDir, name), "utf8"));
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.join("\n")).toContain("cursor_prompt_while_turn_open");
    expect(diagnostics.join("\n")).not.toContain("private steering prompt");
    expect(readFileSync(eventV3Paths(root).active, "utf8")).not.toContain("private");
  }, 15_000);

  test("accumulates bounded hook CLI time inside the active turn", () => {
    const root = candidateRoot();
    const nativeSession = "hook-timing-session";
    recordHookSignalV3({
      ...baseInput(root, "session-start", parsed({ session_id: nativeSession })),
      hook_name: "SessionStart",
      hook_duration_ms: 40,
    });
    recordHookSignalV3({
      ...baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "turn-timing" }),
      ),
      hook_name: "UserPromptSubmit",
      hook_duration_ms: 12.8,
    });
    recordHookSignalV3({
      ...baseInput(
        root,
        "pre-tool-use",
        parsed({
          session_id: nativeSession,
          turn_id: "turn-timing",
          tool_use_id: "timed-tool",
          tool_name: "Bash",
        }),
      ),
      hook_name: "PreToolUse",
      hook_duration_ms: 30.4,
    });
    recordHookSignalV3({
      ...baseInput(
        root,
        "post-tool-use",
        parsed({
          session_id: nativeSession,
          turn_id: "turn-timing",
          tool_use_id: "timed-tool",
          tool_name: "Bash",
        }),
      ),
      hook_name: "Post Tool Use",
      hook_duration_ms: 5.9,
    });

    expect(readHookProducerStateV3(root, "claude-code", nativeSession)?.turn_harness).toEqual({
      hook_time_ms: 47,
      hook_count: 3,
      slowest_hook: "PreToolUse",
      slowest_hook_ms: 30,
    });

    recordHookSignalV3({
      ...baseInput(root, "stop", parsed({ session_id: nativeSession, turn_id: "turn-timing" })),
      hook_name: "Stop",
      hook_duration_ms: 9.2,
    });
    const terminal = readLedgerV3(root)
      .events.map(({ event }) => event)
      .find((event) => event.event_type === "turn.completed");
    expect(terminal?.event_type === "turn.completed" && terminal.payload.harness).toMatchObject({
      state: "observed",
      value: {
        hook_time_ms: 56,
        hook_count: 4,
        slowest_hook: "PreToolUse",
        slowest_hook_ms: 30,
      },
    });
  });

  test("omits a concurrently reordered event clock without losing raw span timing", () => {
    const root = candidateRoot();
    const nativeSession = "reordered-clock-session";
    recordHookSignalV3(baseInput(root, "session-start", parsed({ session_id: nativeSession })));
    recordHookSignalV3(
      baseInput(root, "user-prompt-submit", parsed({ session_id: nativeSession })),
    );
    recordHookSignalV3({
      ...baseInput(
        root,
        "pre-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "captured-first",
          tool_name: "Read",
        }),
      ),
      monotonic_ns: "200",
    });
    recordHookSignalV3({
      ...baseInput(
        root,
        "pre-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "captured-earlier-but-committed-later",
          tool_name: "Grep",
        }),
      ),
      monotonic_ns: "100",
    });

    const ledger = readLedgerV3(root);
    const tools = ledger.events
      .map(({ event }) => event)
      .filter((event) => event.event_type === "tool.requested");
    expect(ledger.complete).toBeTrue();
    expect(tools.map((event) => event.time.monotonic_ns)).toEqual(["200", undefined]);
    expect(
      readHookProducerStateV3(root, "claude-code", nativeSession)?.spans.map(
        (span) => span.opened_monotonic_ns,
      ),
    ).toEqual(["200", "100"]);
  });

  test("replays the exact pending event after a producer crash", () => {
    const root = candidateRoot();
    const input = baseInput(root, "session-start", parsed({ session_id: "retry-session" }));
    expect(() =>
      recordHookSignalV3({
        ...input,
        writerOptions: {
          onStep: (step) => {
            if (step === "ready_published") throw new Error("simulated producer kill");
          },
        },
      }),
    ).toThrow("simulated producer kill");

    const recovered = recordHookSignalV3(input);
    expect(recovered.state).toBe("recorded");
    if (recovered.state === "recorded") expect(recovered.recovered).toBeTrue();
    const events = readLedgerV3(root).events.map(({ event }) => event);
    expect(events).toHaveLength(2);
    expect(events[0]?.event_type).toBe("ledger.genesis");
    expect(events[1]?.event_type).toBe("session.started");
    expect(events[1]?.producer.sequence).toBe(1);
  });

  test("pairs child-agent start and completion without persisting the native child identity", () => {
    const root = candidateRoot();
    const nativeSession = "parent-session";
    const nativeChild = "child-account-secret";
    expect(
      recordHookSignalV3(baseInput(root, "session-start", parsed({ session_id: nativeSession })))
        .state,
    ).toBe("recorded");
    expect(
      recordHookSignalV3(
        baseInput(
          root,
          "sub-agent-start",
          parsed({
            session_id: nativeSession,
            subagent_id: nativeChild,
            raw: { agent_type: "reviewer" },
          }),
        ),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV3(
        baseInput(
          root,
          "sub-agent-stop",
          parsed({ session_id: nativeSession, subagent_id: nativeChild, exit_status: "ok" }),
        ),
      ).state,
    ).toBe("recorded");

    const events = readLedgerV3(root).events.map(({ event }) => event);
    const delegated = events.find((event) => event.event_type === "agent.delegated");
    const started = events.find((event) => event.event_type === "agent.started");
    const completed = events.find((event) => event.event_type === "agent.completed");
    expect(delegated?.payload.delegation_id).toBe(started?.payload.delegation_id);
    expect(delegated?.payload.child_generation_id).toBe(started?.payload.child_generation_id);
    expect(started?.payload.delegation_id).toBe(completed?.payload.delegation_id);
    expect(started?.payload.child_generation_id).toBe(completed?.payload.child_generation_id);
    expect(readHookProducerStateV3(root, "claude-code", nativeSession)?.delegations).toEqual([]);
    expect(readFileSync(eventV3Paths(root).active, "utf8")).not.toContain(nativeChild);
  });

  test("derives operator-input waits and high-confidence semantic progress", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-semantic-events";
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "turn-semantic" }),
        "codex",
      ),
    );
    const tool = (tool_use_id: string, tool_name: string) =>
      parsed({ session_id: nativeSession, turn_id: "turn-semantic", tool_use_id, tool_name });
    recordHookSignalV3(
      baseInput(root, "pre-tool-use", tool("ask-1", "request_user_input"), "codex"),
    );
    recordHookSignalV3(
      baseInput(root, "post-tool-use", tool("ask-1", "request_user_input"), "codex"),
    );
    recordHookSignalV3(baseInput(root, "pre-tool-use", tool("write-1", "apply_patch"), "codex"));
    recordHookSignalV3(baseInput(root, "post-tool-use", tool("write-1", "apply_patch"), "codex"));

    const events = readLedgerV3(root).events.map(({ event }) => event);
    const waitStarted = events.find((event) => event.event_type === "wait.started");
    const waitEnded = events.find((event) => event.event_type === "wait.ended");
    expect(waitStarted?.payload.kind).toBe("needs_input");
    expect(waitStarted?.payload.wait_id).toBe(waitEnded?.payload.wait_id);
    const progress = events.find((event) => event.event_type === "progress.observed");
    const writeTerminal = events.find(
      (event) => event.event_type === "tool.completed" && event.payload.tool.name === "apply_patch",
    );
    if (!writeTerminal) throw new Error("write terminal missing");
    expect(progress?.payload.kind).toBe("write");
    expect(progress?.payload.evidence_event_ids).toEqual([writeTerminal.event_id]);
    expect(progress?.provenance).toMatchObject({ attestation: "derived", confidence: "high" });
  });

  test("accepts explicit native typed waits without reading tool input", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-typed-waits";
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "turn-waits" }),
        "codex",
      ),
    );
    const kinds = ["rate_limit", "approval", "scheduled"] as const;
    for (const [index, kind] of kinds.entries()) {
      const common = {
        session_id: nativeSession,
        turn_id: "turn-waits",
        tool_use_id: `wait-${index}`,
        tool_name: "native_wait",
      };
      recordHookSignalV3(
        baseInput(
          root,
          "pre-tool-use",
          parsed({
            ...common,
            tool_input: { wait_kind: "must-not-be-read" },
            raw: {
              harnery_wait_kind: kind,
              harnery_wake_at: "2026-08-22T10:00:00.000Z",
              harnery_authority_reference: "decision:fixture",
            },
          }),
          "codex",
        ),
      );
      recordHookSignalV3(baseInput(root, "post-tool-use", parsed(common), "codex"));
    }

    const waits = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "wait.started");
    expect(waits.map((event) => event.payload.kind)).toEqual([...kinds]);
    expect(waits.every((event) => event.payload.wake_at === "2026-08-22T10:00:00.000Z")).toBe(true);
    expect(waits.every((event) => event.payload.authority_reference === "decision:fixture")).toBe(
      true,
    );
  });

  test("maps exact structured tools and explicit native fields to semantic progress", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-progress-kinds";
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "turn-progress" }),
        "codex",
      ),
    );
    const cases = [
      ["run_tests", "test"],
      ["build", "artifact"],
      ["publish", "publication"],
      ["deploy", "deploy"],
      ["git_commit", "commit"],
    ] as const;
    for (const [index, [tool_name]] of cases.entries()) {
      const payload = parsed({
        session_id: nativeSession,
        turn_id: "turn-progress",
        tool_use_id: `progress-${index}`,
        tool_name,
      });
      recordHookSignalV3(baseInput(root, "pre-tool-use", payload, "codex"));
      recordHookSignalV3(baseInput(root, "post-tool-use", payload, "codex"));
    }
    const explicitPayload = parsed({
      session_id: nativeSession,
      turn_id: "turn-progress",
      tool_use_id: "progress-explicit",
      tool_name: "adapter_native_action",
      raw: { harnery_progress_kind: "deploy" },
    });
    recordHookSignalV3(baseInput(root, "pre-tool-use", explicitPayload, "codex"));
    recordHookSignalV3(baseInput(root, "post-tool-use", explicitPayload, "codex"));

    const progress = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "progress.observed");
    expect(progress.map((event) => event.payload.kind)).toEqual([
      ...cases.map(([, kind]) => kind),
      "deploy",
    ]);
  }, 15_000);

  test("routes child-process tool hooks through the native session owner", () => {
    const root = candidateRoot();
    const nativeSession = "shared-parent-session";
    const parentInstance = "inst_parent" as const;
    const childInstance = "inst_child" as const;
    expect(
      recordHookSignalV3({
        ...baseInput(root, "session-start", parsed({ session_id: nativeSession })),
        instance_id: parentInstance,
      }).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV3({
        ...baseInput(
          root,
          "user-prompt-submit",
          parsed({ session_id: nativeSession, turn_id: "turn-1", prompt: "delegate" }),
        ),
        instance_id: parentInstance,
      }).state,
    ).toBe("recorded");

    const requested = recordHookSignalV3({
      ...baseInput(
        root,
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "child-tool", tool_name: "Read" }),
      ),
      instance_id: childInstance,
    });
    const completed = recordHookSignalV3({
      ...baseInput(
        root,
        "post-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "child-tool",
          tool_name: "Read",
          tool_response: "done",
        }),
      ),
      instance_id: childInstance,
    });

    expect([requested.state, completed.state]).toEqual(["recorded", "recorded"]);
    const toolEvents = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter(
        (event) => event.event_type === "tool.requested" || event.event_type === "tool.completed",
      );
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents.every((event) => event.scope.instance_id === parentInstance)).toBeTrue();
    expect(toolEvents.some((event) => event.scope.instance_id === childInstance)).toBeFalse();
  });

  test("routes identity-less Cursor hooks through their live instance authority", () => {
    const root = candidateRoot("cursor");
    const start = recordHookSignalV3(
      baseInput(
        root,
        "session-start",
        parsed({ conversation_id: "cursor-conversation" }),
        "cursor",
      ),
    );
    const turn = recordHookSignalV3(
      baseInput(root, "user-prompt-submit", parsed({ turn_id: "cursor-turn" }), "cursor"),
    );
    const requested = recordHookSignalV3(
      baseInput(
        root,
        "pre-tool-use",
        parsed({ tool_use_id: "cursor-tool", tool_name: "Read" }),
        "cursor",
      ),
    );
    const completed = recordHookSignalV3(
      baseInput(
        root,
        "post-tool-use",
        parsed({ tool_use_id: "cursor-tool", tool_name: "Read", tool_response: "done" }),
        "cursor",
      ),
    );

    expect([start.state, turn.state, requested.state, completed.state]).toEqual([
      "recorded",
      "recorded",
      "recorded",
      "recorded",
    ]);
    expect(
      readdirSync(join(root, ".harnery/ledgers/v3/private-producers/cursor")).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(1);
    const events = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.producer.producer_id === "prd_hook");
    expect(
      new Set(events.map((event) => (event.scope as { generation_id: string }).generation_id)).size,
    ).toBe(1);
    expect(events.every((event) => event.scope.instance_id === "inst_fixture")).toBeTrue();
  });

  test("bootstraps Cursor without a recovery warning when its first prompt precedes sessionStart", () => {
    const root = candidateRoot("cursor");
    const nativeSession = "cursor-prompt-first";
    const prompt = recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({
          conversation_id: nativeSession,
          turn_id: "cursor-turn-one",
          prompt: "pick one item",
        }),
        "cursor",
      ),
    );
    const lateStart = recordHookSignalV3(
      baseInput(root, "session-start", parsed({ conversation_id: nativeSession }), "cursor"),
    );

    expect(prompt.state).toBe("recorded");
    expect(lateStart.state).toBe("already_started");
    const events = readLedgerV3(root).events.map(({ event }) => event);
    expect(events.map((event) => event.event_type)).toEqual([
      "ledger.genesis",
      "session.started",
      "turn.started",
    ]);
    const started = events.find((event) => event.event_type === "session.started");
    expect(started?.provenance).toMatchObject({
      attestation: "derived",
      confidence: "high",
    });
    if (started?.event_type !== "session.started") {
      throw new Error("Cursor prompt bootstrap session.started missing");
    }
    expect(started.payload.resume).toEqual({
      state: "unknown",
      reason: "cursor_prompt_bootstrap",
    });
    const diagnostics = join(root, ".harnery/ledgers/v3/diagnostics");
    expect(existsSync(diagnostics) ? readdirSync(diagnostics) : []).toHaveLength(0);
  });

  test("does not turn an unattested Cursor tool channel into an exact zero", () => {
    const root = candidateRoot("cursor");
    const nativeSession = "cursor-unattested-tools";
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ conversation_id: nativeSession, turn_id: "cursor-turn" }),
        "cursor",
      ),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "stop",
        parsed({ conversation_id: nativeSession, turn_id: "cursor-turn" }),
        "cursor",
      ),
    );

    const terminal = readLedgerV3(root)
      .events.map(({ event }) => event)
      .find((event) => event.event_type === "turn.completed");
    expect(terminal?.event_type === "turn.completed" && terminal.payload.tool_call_count).toEqual({
      state: "expected_but_missing",
      capability: "turn_tool_call_count",
      reason: "tool_channel_unattested",
    });
  });

  test("records current Claude and Codex Stop schemas with honest missing telemetry", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "../../../../../tests/fixtures/adapters/inference/current-stop-hooks.json",
        ),
        "utf8",
      ),
    ) as {
      cases: Array<{
        adapter: "claude-code" | "codex";
        version: string;
        terminal_keys: string[];
        payload: Record<string, unknown>;
      }>;
    };

    for (const item of fixture.cases) {
      expect(Object.keys(item.payload).sort()).toEqual([...item.terminal_keys].sort());
      const terminalPayload = parsePayload(JSON.stringify(item.payload), item.adapter);
      if (!terminalPayload?.session_id) throw new Error("current Stop fixture did not parse");
      const root = candidateRoot(item.adapter);
      const turnId = terminalPayload.turn_id ?? `${item.adapter}-turn`;
      const version = item.version.match(/\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.]+)?/)?.[0];
      if (!version) throw new Error("current Stop fixture version did not parse");
      const versioned = (
        signal: Parameters<typeof recordHookSignalV3>[0]["signal"],
        payload: ParsedPayload,
      ) => ({ ...baseInput(root, signal, payload, item.adapter), adapterVersion: version });

      expect(
        recordHookSignalV3(
          versioned(
            "session-start",
            parsed({ session_id: terminalPayload.session_id, model: "fixture-model" }),
          ),
        ).state,
      ).toBe("recorded");
      expect(
        recordHookSignalV3(
          versioned(
            "user-prompt-submit",
            parsed({
              session_id: terminalPayload.session_id,
              turn_id: turnId,
              prompt: "PRIVATE_PROMPT_BODY",
            }),
          ),
        ).state,
      ).toBe("recorded");
      expect(recordHookSignalV3(versioned("stop", terminalPayload)).state).toBe("recorded");

      const terminal = readLedgerV3(root)
        .events.map(({ event }) => event)
        .find((event) => event.event_type === "turn.completed");
      expect(terminal?.event_type === "turn.completed" && terminal.payload.inference).toEqual({
        state: "unsupported",
        capability: "inference_timing",
      });
      const context = readLedgerV3(root)
        .events.map(({ event }) => event)
        .find((event) => event.event_type === "context.observed");
      expect(context?.event_type === "context.observed" && context.payload.measurement).toEqual({
        state: "expected_but_missing",
        capability: "context_usage",
        reason:
          item.adapter === "claude-code"
            ? "conditional_signal_not_reported"
            : "promised_signal_not_reported",
      });
      const durable = readFileSync(eventV3Paths(root).active, "utf8");
      expect(durable).not.toContain("PRIVATE_ASSISTANT_BODY");
      expect(durable).not.toContain("PRIVATE_PROMPT_BODY");
      expect(durable).not.toContain("/private/");
    }
  });

  test("retains Claude prompt identity until Stop can attribute transcript usage", () => {
    const root = candidateRoot("claude-code");
    const nativeSession = "claude-runtime-context-session";
    const nativePrompt = "claude-runtime-context-prompt";
    const transcript = join(root, "claude-runtime-context.jsonl");
    writeFileSync(
      transcript,
      `${[
        {
          timestamp: "2026-08-21T20:24:13.000Z",
          type: "user",
          uuid: "user-turn",
          promptId: nativePrompt,
          sessionId: nativeSession,
          message: { role: "user", content: "PRIVATE_CONTEXT_PROMPT" },
        },
        {
          timestamp: "2026-08-21T20:24:14.000Z",
          type: "assistant",
          uuid: "assistant-turn",
          parentUuid: "user-turn",
          sessionId: nativeSession,
          message: {
            model: "claude-opus-fixture",
            content: "PRIVATE_CONTEXT_RESPONSE",
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 30,
            },
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );

    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "claude-code"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: nativePrompt, prompt: "PRIVATE_PROMPT" }),
        "claude-code",
      ),
    );
    recordHookSignalV3({
      ...baseInput(
        root,
        "stop",
        parsed({ session_id: nativeSession, transcript_path: transcript }),
        "claude-code",
      ),
      adapterVersion: "2.1.233",
    });

    const events = readLedgerV3(root).events.map(({ event }) => event);
    const context = events.find((event) => event.event_type === "context.observed");
    expect(context?.event_type === "context.observed" && context.payload.measurement).toEqual({
      state: "expected_but_missing",
      capability: "context_usage",
      reason: "claude_context_limit_tokens_not_reported",
    });
    expect(context?.provenance).toMatchObject({
      source_event: "claude-code.runtime_context.2.1.233",
      attestation: "derived",
      confidence: "high",
    });
    const telemetryChange = events.find(
      (event) =>
        event.event_type === "session.attestation_changed" &&
        event.payload.reason === "runtime_telemetry_changed",
    );
    expect(
      telemetryChange?.event_type === "session.attestation_changed" &&
        telemetryChange.payload.runtime_attestation.telemetry.context_usage,
    ).toEqual({
      state: "expected_but_missing",
      capability: "context_usage",
      reason: "claude_context_limit_tokens_not_reported",
    });
    expect(
      telemetryChange?.event_type === "session.attestation_changed" &&
        telemetryChange.payload.runtime_attestation.tuning,
    ).toEqual({
      state: "expected_but_missing",
      capability: "effort_selection",
      reason: "not_reported",
    });
    expect(
      readHookProducerStateV3(root, "claude-code", nativeSession)?.current_native_turn_id,
    ).toBe(undefined);
    appendFileSync(
      transcript,
      `${[
        {
          timestamp: "2026-08-21T20:25:13.000Z",
          type: "user",
          uuid: "user-turn-two",
          parentUuid: "assistant-turn",
          promptId: "claude-runtime-context-prompt-two",
          sessionId: nativeSession,
          message: { role: "user", content: "PRIVATE_SECOND_PROMPT" },
        },
        {
          timestamp: "2026-08-21T20:25:14.000Z",
          type: "assistant",
          uuid: "assistant-turn-two",
          parentUuid: "user-turn-two",
          sessionId: nativeSession,
          message: {
            model: "claude-opus-fixture",
            content: "PRIVATE_SECOND_RESPONSE",
            usage: { input_tokens: 70 },
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({
          session_id: nativeSession,
          turn_id: "claude-runtime-context-prompt-two",
          prompt: "PRIVATE_SECOND_PROMPT",
        }),
        "claude-code",
      ),
    );
    recordHookSignalV3({
      ...baseInput(
        root,
        "stop",
        parsed({ session_id: nativeSession, transcript_path: transcript }),
        "claude-code",
      ),
      adapterVersion: "2.1.233",
    });
    expect(
      readLedgerV3(root).events.filter(
        ({ event }) =>
          event.event_type === "session.attestation_changed" &&
          event.payload.reason === "runtime_telemetry_changed",
      ),
    ).toHaveLength(1);
    const durable = readFileSync(eventV3Paths(root).active, "utf8");
    expect(durable).not.toContain("PRIVATE_CONTEXT_PROMPT");
    expect(durable).not.toContain("PRIVATE_CONTEXT_RESPONSE");
    expect(durable).not.toContain("PRIVATE_SECOND_PROMPT");
    expect(durable).not.toContain("PRIVATE_SECOND_RESPONSE");
    expect(durable).not.toContain(nativePrompt);
    expect(durable).not.toContain(transcript);
  });

  test("records Claude used tokens with an inferred authoritative model limit", () => {
    const root = candidateRoot("claude-code");
    const nativeSession = "claude-authoritative-model-limit";
    const nativePrompt = "claude-authoritative-prompt";
    const transcript = join(root, "claude-authoritative-model.jsonl");
    writeFileSync(
      transcript,
      `${[
        {
          type: "user",
          uuid: "claude-user",
          promptId: nativePrompt,
          sessionId: nativeSession,
          message: { role: "user", content: "PRIVATE_CLAUDE_PROMPT" },
        },
        {
          type: "assistant",
          uuid: "claude-assistant",
          parentUuid: "claude-user",
          sessionId: nativeSession,
          timestamp: "2026-08-23T20:24:14.000Z",
          message: {
            model: "claude-opus-5",
            content: "PRIVATE_CLAUDE_RESPONSE",
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 30,
            },
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    recordHookSignalV3(
      baseInput(
        root,
        "session-start",
        parsed({ session_id: nativeSession, model: "claude-opus-5" }),
        "claude-code",
      ),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: nativePrompt }),
        "claude-code",
      ),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "stop",
        parsed({ session_id: nativeSession, transcript_path: transcript }),
        "claude-code",
      ),
    );

    const events = readLedgerV3(root).events.map(({ event }) => event);
    const context = events.find((event) => event.event_type === "context.observed");
    expect(context?.event_type === "context.observed" && context.payload.measurement).toEqual({
      state: "observed",
      value: {
        used_tokens: 60,
        limit_tokens: 1_000_000,
        remaining_tokens: 999_940,
        measured_at: "2026-08-23T20:24:14.000Z",
        method: "claude_transcript_usage_model_capability",
      },
      attestation: "inferred",
      confidence: "high",
    });
    expect(context?.provenance).toMatchObject({
      source_event: "claude.transcript_usage_model_capability.1.0.0",
      attestation: "inferred",
      confidence: "high",
    });
    const durable = readFileSync(eventV3Paths(root).active, "utf8");
    expect(durable).not.toContain("PRIVATE_CLAUDE_PROMPT");
    expect(durable).not.toContain("PRIVATE_CLAUDE_RESPONSE");
    expect(durable).not.toContain(transcript);
  });

  test("records Cursor's first-party context percentage without synthetic token counts", () => {
    const root = candidateRoot("cursor");
    const nativeSession = "cursor-first-party-context";
    const nativeTurn = "cursor-context-turn";
    const observedAt = new Date().toISOString();
    const cursorRoot = join(root, "cursor-workspace-storage");
    const workspace = join(cursorRoot, "workspace-a");
    mkdirSync(workspace, { recursive: true });
    const databasePath = join(workspace, "state.vscdb");
    const database = new Database(databasePath);
    database.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    database.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [
      "composer.composerData",
      JSON.stringify({
        allComposers: [
          {
            composerId: nativeSession,
            contextUsagePercent: 41.25,
            lastUpdatedAt: Date.parse(observedAt),
          },
        ],
      }),
    ]);
    database.close();
    const input = (
      signal: Parameters<typeof recordHookSignalV3>[0]["signal"],
      payload: ParsedPayload,
    ) => ({
      ...baseInput(root, signal, payload, "cursor"),
      observed_at: observedAt,
      runtimeTelemetryOptions: { cursorRoots: [cursorRoot] },
    });
    recordHookSignalV3(input("session-start", parsed({ conversation_id: nativeSession })));
    recordHookSignalV3(
      input("user-prompt-submit", parsed({ conversation_id: nativeSession, turn_id: nativeTurn })),
    );
    recordHookSignalV3(
      input("stop", parsed({ conversation_id: nativeSession, turn_id: nativeTurn })),
    );

    const events = readLedgerV3(root).events.map(({ event }) => event);
    const contexts = events.filter((event) => event.event_type === "context.observed");
    expect(contexts).toHaveLength(1);
    const context = contexts[0];
    expect(context?.event_type === "context.observed" && context.payload.measurement).toEqual({
      state: "observed",
      value: {
        used_percent: 41.25,
        remaining_percent: 58.75,
        measured_at: observedAt,
        method: "cursor_composer_context_percent",
      },
      attestation: "derived",
      confidence: "high",
    });
    const durable = readFileSync(eventV3Paths(root).active, "utf8");
    expect(durable).not.toContain(databasePath);
    expect(durable).not.toContain(nativeSession);
    expect(durable).not.toContain("limit_tokens");
  });

  test("enriches a completed Codex turn from an attributable bounded rollout sample", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-runtime-context-session";
    const nativeTurn = "codex-runtime-context-turn";
    const transcript = join(root, `rollout-fixture-${nativeSession}.jsonl`);
    writeFileSync(
      transcript,
      `${[
        {
          timestamp: "2026-08-21T20:24:00.000Z",
          ordinal: 1,
          type: "event_msg",
          payload: { type: "task_started", turn_id: nativeTurn },
        },
        {
          timestamp: "2026-08-21T20:24:14.000Z",
          ordinal: 2,
          type: "response_item",
          payload: {
            type: "message",
            prompt: "PRIVATE_CONTEXT_PROMPT",
            reasoning: "PRIVATE_CONTEXT_REASONING",
            command: "PRIVATE_CONTEXT_COMMAND",
            result: "PRIVATE_CONTEXT_RESULT",
          },
        },
        {
          timestamp: "2026-08-21T20:24:14.100Z",
          ordinal: 3,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 120_000 },
              model_context_window: 258_400,
            },
          },
        },
        {
          timestamp: "2026-08-21T20:24:15.200Z",
          ordinal: 4,
          type: "event_msg",
          payload: { type: "task_complete", turn_id: nativeTurn },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );

    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: nativeTurn, prompt: "PRIVATE_PROMPT" }),
        "codex",
      ),
    );
    const stopPayload = parsed({
      session_id: nativeSession,
      turn_id: nativeTurn,
      transcript_path: transcript,
    });
    stopPayload.raw.last_assistant_message = "PRIVATE_ASSISTANT_BODY";
    recordHookSignalV3({
      ...baseInput(root, "stop", stopPayload, "codex"),
      adapterVersion: "0.149.0-alpha.4.1",
    });

    const events = readLedgerV3(root).events.map(({ event }) => event);
    const terminal = events.find((event) => event.event_type === "turn.completed");
    const context = events.find((event) => event.event_type === "context.observed");
    expect(context?.event_type === "context.observed" && context.payload.measurement).toEqual({
      state: "observed",
      value: {
        used_tokens: 120_000,
        limit_tokens: 258_400,
        remaining_tokens: 138_400,
        measured_at: "2026-08-21T20:24:14.100Z",
        method: "codex_transcript_token_count",
      },
      attestation: "derived",
      confidence: "exact",
    });
    expect(context?.provenance).toMatchObject({
      source_event: "codex.rollout_token_count.0.149.0-alpha.4.1",
      attestation: "derived",
      confidence: "exact",
      source_record_id: expect.stringMatching(/^hid_[a-f0-9]{64}$/),
    });
    expect(context?.time.observed_at).toBe(terminal?.time.observed_at);
    const telemetryChange = events.find(
      (event) =>
        event.event_type === "session.attestation_changed" &&
        event.payload.reason === "runtime_telemetry_changed",
    );
    expect(
      telemetryChange?.event_type === "session.attestation_changed" &&
        telemetryChange.payload.runtime_attestation.telemetry.context_usage,
    ).toEqual({
      state: "observed",
      value: {
        support: "derived",
        source: "codex.rollout_token_count",
        completeness: "exact",
      },
      attestation: "derived",
      confidence: "exact",
    });
    expect(telemetryChange).toMatchObject({ links: { caused_by: [context?.event_id] } });
    const projection = projectLatencyV3(readLedgerV3(root)).turns[0];
    expect(projection?.context_percent).toBeCloseTo((120_000 / 258_400) * 100);
    expect(projection?.context_coverage.state).toBe("observed");
    const durable = readFileSync(eventV3Paths(root).active, "utf8");
    for (const sentinel of [
      "PRIVATE_CONTEXT_PROMPT",
      "PRIVATE_CONTEXT_REASONING",
      "PRIVATE_CONTEXT_COMMAND",
      "PRIVATE_CONTEXT_RESULT",
      "PRIVATE_ASSISTANT_BODY",
      transcript,
    ]) {
      expect(durable).not.toContain(sentinel);
    }
  });

  test("discovers and retains a session-safe Codex rollout when Stop omits transcript_path", () => {
    const root = candidateRoot("codex");
    const nativeSession = "01a030b0-0000-7000-8000-000000000001";
    const firstTurn = "codex-context-turn-one";
    const secondTurn = "codex-context-turn-two";
    const linuxRoot = join(root, "linux", ".codex", "sessions");
    const windowsRoot = join(root, "mnt", "c", "Users", "maya", ".codex", "sessions");
    const rolloutDirectory = join(linuxRoot, "2026", "08", "23");
    mkdirSync(rolloutDirectory, { recursive: true });
    const transcript = join(rolloutDirectory, `rollout-fixture-${nativeSession}.jsonl`);
    const rowsForTurn = (turn: string, minute: string, used: number) => [
      {
        timestamp: `2026-08-23T20:${minute}:00.000Z`,
        type: "event_msg",
        payload: { type: "task_started", turn_id: turn },
      },
      {
        timestamp: `2026-08-23T20:${minute}:14.100Z`,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: used },
            model_context_window: 258_400,
          },
        },
      },
      {
        timestamp: `2026-08-23T20:${minute}:15.200Z`,
        type: "event_msg",
        payload: { type: "task_complete", turn_id: turn },
      },
    ];
    writeFileSync(
      transcript,
      `${rowsForTurn(firstTurn, "24", 120_000)
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    const runtimeTelemetryOptions = { codexRoots: [linuxRoot, windowsRoot] };

    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: firstTurn }),
        "codex",
      ),
    );
    recordHookSignalV3({
      ...baseInput(
        root,
        "stop",
        parsed({ session_id: nativeSession, turn_id: firstTurn }),
        "codex",
      ),
      runtimeTelemetryOptions,
    });

    expect(readHookProducerStateV3(root, "codex", nativeSession)?.runtime_transcript_path).toBe(
      transcript,
    );

    // Simulate the next short-lived hook process, then add a duplicate that
    // would make a new recursive discovery ambiguous. Owner-only producer
    // state must keep the second turn on the already verified rollout.
    clearRuntimeTelemetryCachesForTest();
    const duplicateDirectory = join(windowsRoot, "2026", "08", "23");
    mkdirSync(duplicateDirectory, { recursive: true });
    const duplicate = join(duplicateDirectory, `rollout-duplicate-${nativeSession}.jsonl`);
    writeFileSync(duplicate, `${JSON.stringify(rowsForTurn(firstTurn, "24", 200_000)[0])}\n`);
    appendFileSync(
      transcript,
      `${rowsForTurn(secondTurn, "25", 130_000)
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: secondTurn }),
        "codex",
      ),
    );
    recordHookSignalV3({
      ...baseInput(
        root,
        "stop",
        parsed({ session_id: nativeSession, turn_id: secondTurn }),
        "codex",
      ),
      runtimeTelemetryOptions,
    });

    const contexts = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "context.observed");
    expect(contexts).toHaveLength(2);
    expect(
      contexts.map((event) =>
        event.event_type === "context.observed" ? event.payload.measurement : undefined,
      ),
    ).toMatchObject([
      { state: "observed", value: { used_tokens: 120_000, limit_tokens: 258_400 } },
      { state: "observed", value: { used_tokens: 130_000, limit_tokens: 258_400 } },
    ]);
    const durable = readFileSync(eventV3Paths(root).active, "utf8");
    expect(durable).not.toContain(transcript);
    expect(durable).not.toContain(duplicate);
    clearRuntimeTelemetryCachesForTest();
  });

  test("covers Codex's terminal-row flush race inside the bounded Stop grace", async () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-stop-context-flush";
    const nativeTurn = "codex-stop-context-turn";
    const transcript = join(root, `rollout-fixture-${nativeSession}.jsonl`);
    writeFileSync(
      transcript,
      `${JSON.stringify({
        timestamp: "2026-08-21T20:24:00.000Z",
        ordinal: 1,
        type: "event_msg",
        payload: { type: "task_started", turn_id: nativeTurn },
      })}\n`,
    );
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: nativeTurn }),
        "codex",
      ),
    );

    const writerScript = join(root, "delayed-stop-transcript-append.mjs");
    writeFileSync(
      writerScript,
      [
        'import { appendFileSync } from "node:fs";',
        "await new Promise((resolve) => setTimeout(resolve, Number(process.argv[2])));",
        "appendFileSync(process.argv[3], process.argv[4]);",
      ].join("\n"),
    );
    const terminalRows = `${[
      {
        timestamp: "2026-08-21T20:24:14.100Z",
        ordinal: 2,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 120_000 },
            model_context_window: 258_400,
          },
        },
      },
      {
        timestamp: "2026-08-21T20:24:15.200Z",
        ordinal: 3,
        type: "event_msg",
        payload: { type: "task_complete", turn_id: nativeTurn },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`;
    const writer = Bun.spawn([process.execPath, writerScript, "50", transcript, terminalRows], {
      stdout: "ignore",
      stderr: "inherit",
    });
    const startedAt = performance.now();
    expect(
      recordHookSignalV3(
        baseInput(
          root,
          "stop",
          parsed({ session_id: nativeSession, turn_id: nativeTurn, transcript_path: transcript }),
          "codex",
        ),
      ).state,
    ).toBe("recorded");
    const elapsedMs = performance.now() - startedAt;
    expect(await writer.exited).toBe(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(50);
    expect(elapsedMs).toBeLessThan(1_000);

    const contexts = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "context.observed");
    expect(contexts).toHaveLength(1);
    expect(
      contexts[0]?.event_type === "context.observed" && contexts[0].payload.measurement,
    ).toMatchObject({
      state: "observed",
      value: { used_tokens: 120_000, limit_tokens: 258_400 },
      attestation: "derived",
      confidence: "exact",
    });
    expect(
      readHookProducerStateV3(root, "codex", nativeSession)?.pending_runtime_contexts,
    ).toBeUndefined();
    const durable = readFileSync(eventV3Paths(root).active, "utf8");
    expect(durable).not.toContain(transcript);
    expect(durable).not.toContain(nativeSession);
    expect(durable).not.toContain(nativeTurn);
  });

  test("reconciles a Codex terminal written only after Stop returns", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-post-stop-context-flush";
    const nativeTurn = "codex-post-stop-context-turn";
    const transcript = join(root, `rollout-fixture-${nativeSession}.jsonl`);
    writeFileSync(
      transcript,
      `${JSON.stringify({
        timestamp: "2026-08-21T20:24:00.000Z",
        ordinal: 1,
        type: "event_msg",
        payload: { type: "task_started", turn_id: nativeTurn },
      })}\n`,
    );
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: nativeTurn }),
        "codex",
      ),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "stop",
        parsed({ session_id: nativeSession, turn_id: nativeTurn, transcript_path: transcript }),
        "codex",
      ),
    );
    expect(
      readHookProducerStateV3(root, "codex", nativeSession)?.pending_runtime_contexts,
    ).toHaveLength(1);

    appendFileSync(
      transcript,
      `${[
        {
          timestamp: "2026-08-21T20:24:14.100Z",
          ordinal: 2,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 120_000 },
              model_context_window: 258_400,
            },
          },
        },
        {
          timestamp: "2026-08-21T20:24:15.200Z",
          ordinal: 3,
          type: "event_msg",
          payload: { type: "task_complete", turn_id: nativeTurn },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );

    expect(
      reconcilePendingRuntimeContextV3({
        coordRoot: root,
        mode: "candidate",
        nativeSessionId: nativeSession,
        producer_id: "prd_fixture",
        build_id: "build_fixture",
        platform: "linux",
      }),
    ).toEqual({ state: "settled" });
    const contexts = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "context.observed");
    expect(contexts).toHaveLength(2);
    expect(
      contexts.at(-1)?.event_type === "context.observed" && contexts.at(-1)?.payload.measurement,
    ).toMatchObject({
      state: "observed",
      value: { used_tokens: 120_000, limit_tokens: 258_400 },
      attestation: "derived",
      confidence: "exact",
    });
    expect(
      readHookProducerStateV3(root, "codex", nativeSession)?.pending_runtime_contexts,
    ).toBeUndefined();
    const durable = readFileSync(eventV3Paths(root).active, "utf8");
    expect(durable).not.toContain(transcript);
    expect(durable).not.toContain(nativeSession);
    expect(durable).not.toContain(nativeTurn);
  });

  test("records fresh Codex context during an open turn with bounded cadence and deduplication", () => {
    const root = candidateRoot("codex");
    const nativeSession = "01a030b0-9de1-70f2-bda0-933d26e3c2c0";
    const nativeTurn = "active-context-turn";
    const transcript = join(root, `rollout-${nativeSession}.jsonl`);
    writeFileSync(
      transcript,
      `${[
        {
          timestamp: "2026-08-21T20:24:00.000Z",
          ordinal: 1,
          type: "event_msg",
          payload: { type: "task_started", turn_id: nativeTurn },
        },
        {
          timestamp: "2026-08-21T20:24:14.100Z",
          ordinal: 2,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 120_000 },
              model_context_window: 258_400,
            },
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: nativeTurn }),
        "codex",
      ),
    );
    const requestTool = (
      toolId: string,
      observedAt: string,
      activeContextProbeIntervalMs?: number,
    ) => {
      const payload = parsed({
        session_id: nativeSession,
        turn_id: nativeTurn,
        transcript_path: transcript,
        tool_use_id: toolId,
        tool_name: "Bash",
      });
      expect(
        recordHookSignalV3({
          ...baseInput(root, "pre-tool-use", payload, "codex"),
          observed_at: observedAt,
        }).state,
      ).toBe("recorded");
      return recordHookSignalV3({
        ...baseInput(root, "post-tool-use", payload, "codex"),
        observed_at: observedAt,
        ...(activeContextProbeIntervalMs !== undefined
          ? { runtimeTelemetryOptions: { activeContextProbeIntervalMs } }
          : {}),
      });
    };

    expect(requestTool("tool-one", "2026-08-21T20:24:15.200Z").state).toBe("recorded");
    let contexts = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "context.observed");
    expect(contexts).toHaveLength(1);
    expect(
      contexts[0]?.event_type === "context.observed" && contexts[0].payload.measurement,
    ).toEqual({
      state: "observed",
      value: {
        used_tokens: 120_000,
        limit_tokens: 258_400,
        remaining_tokens: 138_400,
        measured_at: "2026-08-21T20:24:14.100Z",
        method: "codex_transcript_token_count",
      },
      attestation: "derived",
      confidence: "exact",
    });

    appendFileSync(
      transcript,
      `${JSON.stringify({
        timestamp: "2026-08-21T20:24:16.000Z",
        ordinal: 3,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 140_000 },
            model_context_window: 258_400,
          },
        },
      })}\n`,
    );
    expect(requestTool("tool-two", "2026-08-21T20:24:17.000Z").state).toBe("recorded");
    contexts = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "context.observed");
    expect(contexts).toHaveLength(1);

    expect(requestTool("tool-three", "2026-08-21T20:24:18.000Z", 0).state).toBe("recorded");
    expect(requestTool("tool-four", "2026-08-21T20:24:19.000Z", 0).state).toBe("recorded");
    contexts = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "context.observed");
    expect(contexts).toHaveLength(2);
    expect(
      contexts.at(-1)?.event_type === "context.observed" && contexts.at(-1)?.payload.measurement,
    ).toMatchObject({
      state: "observed",
      value: { used_tokens: 140_000, limit_tokens: 258_400, remaining_tokens: 118_400 },
    });
    appendFileSync(
      transcript,
      `${JSON.stringify({
        timestamp: "2026-08-21T20:24:20.000Z",
        ordinal: 4,
        type: "event_msg",
        payload: { type: "task_complete", turn_id: nativeTurn },
      })}\n`,
    );
    expect(
      recordHookSignalV3({
        ...baseInput(
          root,
          "stop",
          parsed({ session_id: nativeSession, turn_id: nativeTurn, transcript_path: transcript }),
          "codex",
        ),
        observed_at: "2026-08-21T20:24:20.100Z",
      }).state,
    ).toBe("recorded");
    expect(
      readLedgerV3(root)
        .events.map(({ event }) => event)
        .filter((event) => event.event_type === "context.observed"),
    ).toHaveLength(2);
    const durable = readFileSync(eventV3Paths(root).active, "utf8");
    expect(durable).not.toContain(transcript);
    expect(durable).not.toContain(nativeSession);
    expect(durable).not.toContain(nativeTurn);
  });

  test("records fresh turn-matched Claude context during an open turn", () => {
    const root = candidateRoot("claude-code");
    const nativeSession = "claude-active-context-session";
    const nativeTurn = "claude-active-context-turn";
    const transcript = join(root, "claude-active-context.jsonl");
    writeFileSync(
      transcript,
      `${[
        {
          type: "user",
          uuid: "claude-active-user",
          promptId: nativeTurn,
          sessionId: nativeSession,
          message: { role: "user", content: "PRIVATE_CLAUDE_PROMPT" },
        },
        {
          type: "assistant",
          uuid: "claude-active-assistant",
          parentUuid: "claude-active-user",
          sessionId: nativeSession,
          timestamp: "2026-08-21T20:24:14.100Z",
          message: {
            model: "claude-opus-5",
            usage: {
              input_tokens: 68_000,
              cache_creation_input_tokens: 320,
              cache_read_input_tokens: 300,
            },
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "claude-code"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: nativeTurn, transcript_path: transcript }),
        "claude-code",
      ),
    );
    const toolPayload = parsed({
      session_id: nativeSession,
      turn_id: nativeTurn,
      transcript_path: transcript,
      tool_use_id: "claude-tool",
      tool_name: "Bash",
    });
    recordHookSignalV3({
      ...baseInput(root, "pre-tool-use", toolPayload, "claude-code"),
      observed_at: "2026-08-21T20:24:15.000Z",
    });
    expect(
      recordHookSignalV3({
        ...baseInput(root, "post-tool-use", toolPayload, "claude-code"),
        observed_at: "2026-08-21T20:24:15.200Z",
      }).state,
    ).toBe("recorded");

    const contexts = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "context.observed");
    expect(contexts).toHaveLength(1);
    expect(
      contexts[0]?.event_type === "context.observed" && contexts[0].payload.measurement,
    ).toEqual({
      state: "observed",
      value: {
        used_tokens: 68_620,
        limit_tokens: 1_000_000,
        remaining_tokens: 931_380,
        measured_at: "2026-08-21T20:24:14.100Z",
        method: "claude_transcript_usage_model_capability",
      },
      attestation: "inferred",
      confidence: "high",
    });
    const durable = readFileSync(eventV3Paths(root).active, "utf8");
    expect(durable).not.toContain(transcript);
    expect(durable).not.toContain(nativeSession);
    expect(durable).not.toContain(nativeTurn);
    expect(durable).not.toContain("PRIVATE_CLAUDE_PROMPT");
  });

  test("reconciles a late Codex terminal on the next hook or session end", () => {
    for (const retrySignal of ["user-prompt-submit", "session-end"] as const) {
      const root = candidateRoot("codex");
      const nativeSession = `codex-unflushed-context-${retrySignal}`;
      const nativeTurn = `codex-unflushed-turn-${retrySignal}`;
      const transcript = join(root, `rollout-fixture-${nativeSession}.jsonl`);
      writeFileSync(
        transcript,
        `${JSON.stringify({
          timestamp: "2026-08-21T20:24:00.000Z",
          ordinal: 1,
          type: "event_msg",
          payload: { type: "task_started", turn_id: nativeTurn },
        })}\n`,
      );
      recordHookSignalV3(
        baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
      );
      recordHookSignalV3(
        baseInput(
          root,
          "user-prompt-submit",
          parsed({ session_id: nativeSession, turn_id: nativeTurn }),
          "codex",
        ),
      );
      expect(
        recordHookSignalV3(
          baseInput(
            root,
            "stop",
            parsed({ session_id: nativeSession, turn_id: nativeTurn, transcript_path: transcript }),
            "codex",
          ),
        ).state,
      ).toBe("recorded");

      const partial = readLedgerV3(root)
        .events.map(({ event }) => event)
        .find((event) => event.event_type === "context.observed");
      expect(partial?.event_type === "context.observed" && partial.payload.measurement).toEqual({
        state: "expected_but_missing",
        capability: "context_usage",
        reason: "codex_transcript_turn_not_terminal",
      });
      expect(
        readHookProducerStateV3(root, "codex", nativeSession)?.pending_runtime_contexts,
      ).toHaveLength(1);

      appendFileSync(
        transcript,
        `${[
          {
            timestamp: "2026-08-21T20:24:14.100Z",
            ordinal: 2,
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                last_token_usage: { input_tokens: 120_000 },
                model_context_window: 258_400,
              },
            },
          },
          {
            timestamp: "2026-08-21T20:24:15.200Z",
            ordinal: 3,
            type: "event_msg",
            payload: { type: "task_complete", turn_id: nativeTurn },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n")}\n`,
      );

      const retryPayload =
        retrySignal === "user-prompt-submit"
          ? parsed({ session_id: nativeSession, turn_id: `${nativeTurn}-next` })
          : parsed({ session_id: nativeSession });
      expect(recordHookSignalV3(baseInput(root, retrySignal, retryPayload, "codex")).state).toBe(
        "recorded",
      );

      const events = readLedgerV3(root).events.map(({ event }) => event);
      const contexts = events.filter((event) => event.event_type === "context.observed");
      expect(contexts).toHaveLength(2);
      const exact = contexts.at(-1);
      expect(exact?.event_type === "context.observed" && exact.payload.measurement).toMatchObject({
        state: "observed",
        value: { used_tokens: 120_000, limit_tokens: 258_400 },
        attestation: "derived",
        confidence: "exact",
      });
      expect(exact?.time.observed_at).not.toBe(partial?.time.observed_at);
      expect(
        readHookProducerStateV3(root, "codex", nativeSession)?.pending_runtime_contexts,
      ).toBeUndefined();
      const producerStatePath = join(
        root,
        ".harnery/ledgers/v3/private-producers/codex",
        readdirSync(join(root, ".harnery/ledgers/v3/private-producers/codex")).find((name) =>
          name.endsWith(".json"),
        )!,
      );
      expect(readFileSync(producerStatePath, "utf8")).not.toContain("pending_runtime_contexts");
      const projection = projectLatencyV3(readLedgerV3(root)).turns.find(
        (turn) => turn.turn_id === (exact?.scope as { turn_id?: string } | undefined)?.turn_id,
      );
      expect(projection?.context_coverage.state).toBe("observed");
      expect(projection?.context_percent).toBeCloseTo((120_000 / 258_400) * 100);
      const durable = readFileSync(eventV3Paths(root).active, "utf8");
      expect(durable).not.toContain(transcript);
      expect(durable).not.toContain(nativeSession);
      expect(durable).not.toContain(nativeTurn);
    }
  }, 10_000);

  test("queues a late Codex terminal when Stop omits transcript and turn paths", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-pathless-stop-context";
    const nativeTurn = "codex-pathless-stop-turn";
    const transcript = join(root, `rollout-fixture-${nativeSession}.jsonl`);
    const runtimeTelemetryOptions = { codexRoots: [root] };
    writeFileSync(
      transcript,
      `${JSON.stringify({
        timestamp: "2026-08-21T20:24:00.000Z",
        ordinal: 1,
        type: "event_msg",
        payload: { type: "task_started", turn_id: nativeTurn },
      })}\n`,
    );
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: nativeTurn }),
        "codex",
      ),
    );

    expect(
      recordHookSignalV3({
        ...baseInput(root, "stop", parsed({ session_id: nativeSession }), "codex"),
        runtimeTelemetryOptions,
      }).state,
    ).toBe("recorded");
    expect(
      readHookProducerStateV3(root, "codex", nativeSession)?.pending_runtime_contexts,
    ).toMatchObject([{ native_turn_id: nativeTurn, attempts: 0 }]);

    appendFileSync(
      transcript,
      `${[
        {
          timestamp: "2026-08-21T20:24:14.100Z",
          ordinal: 2,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 120_000 },
              model_context_window: 258_400,
            },
          },
        },
        {
          timestamp: "2026-08-21T20:24:15.200Z",
          ordinal: 3,
          type: "event_msg",
          payload: { type: "task_complete", turn_id: nativeTurn },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    recordHookSignalV3({
      ...baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: `${nativeTurn}-next` }),
        "codex",
      ),
      runtimeTelemetryOptions,
    });

    const contexts = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "context.observed");
    expect(contexts).toHaveLength(2);
    expect(
      contexts.at(-1)?.event_type === "context.observed" && contexts.at(-1)?.payload.measurement,
    ).toMatchObject({
      state: "observed",
      value: { used_tokens: 120_000, limit_tokens: 258_400 },
      attestation: "derived",
      confidence: "exact",
    });
    expect(
      readHookProducerStateV3(root, "codex", nativeSession)?.pending_runtime_contexts,
    ).toBeUndefined();
    const durable = readFileSync(eventV3Paths(root).active, "utf8");
    expect(durable).not.toContain(transcript);
    expect(durable).not.toContain(nativeSession);
    expect(durable).not.toContain(nativeTurn);
  });

  test("waits briefly for a late Codex terminal before an approved session end", async () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-approved-end-context-flush";
    const nativeTurn = "codex-approved-end-context-turn";
    const transcript = join(root, `rollout-fixture-${nativeSession}.jsonl`);
    writeFileSync(
      transcript,
      `${JSON.stringify({
        timestamp: "2026-08-21T20:24:00.000Z",
        ordinal: 1,
        type: "event_msg",
        payload: { type: "task_started", turn_id: nativeTurn },
      })}\n`,
    );
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: nativeTurn }),
        "codex",
      ),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "stop",
        parsed({ session_id: nativeSession, turn_id: nativeTurn, transcript_path: transcript }),
        "codex",
      ),
    );
    const state = readHookProducerStateV3(root, "codex", nativeSession);
    if (!state) throw new Error("producer state missing");

    const writerScript = join(root, "delayed-transcript-append.mjs");
    writeFileSync(
      writerScript,
      [
        'import { appendFileSync } from "node:fs";',
        "await new Promise((resolve) => setTimeout(resolve, Number(process.argv[2])));",
        "appendFileSync(process.argv[3], process.argv[4]);",
      ].join("\n"),
    );
    const terminalRows = `${[
      {
        timestamp: "2026-08-21T20:24:14.100Z",
        ordinal: 2,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 120_000 },
            model_context_window: 258_400,
          },
        },
      },
      {
        timestamp: "2026-08-21T20:24:15.200Z",
        ordinal: 3,
        type: "event_msg",
        payload: { type: "task_complete", turn_id: nativeTurn },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`;
    const writer = Bun.spawn([process.execPath, writerScript, "300", transcript, terminalRows], {
      stdout: "ignore",
      stderr: "inherit",
    });
    const ended = recordApprovedSessionEndV3({
      coordRoot: root,
      mode: "candidate",
      instance_id: state.instance_id,
      generation_id: state.generation_id,
      build_id: "build_fixture",
      platform: "linux",
      reason: "approved_explicit_end",
      outcome: "succeeded",
      coordination_finalized: true,
    });
    expect(await writer.exited).toBe(0);
    expect(ended.state).toBe("recorded");

    const events = readLedgerV3(root).events.map(({ event }) => event);
    const contexts = events.filter((event) => event.event_type === "context.observed");
    expect(contexts).toHaveLength(2);
    expect(
      contexts.at(-1)?.event_type === "context.observed" && contexts.at(-1)?.payload.measurement,
    ).toMatchObject({
      state: "observed",
      value: { used_tokens: 120_000, limit_tokens: 258_400 },
    });
    expect(events.at(-1)?.event_type).toBe("session.ended");
    expect(
      readHookProducerStateV3(root, "codex", nativeSession)?.pending_runtime_contexts,
    ).toBeUndefined();
  });

  test("bounds an unresolved Codex context join at approved session end", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-approved-end-unresolved-context";
    const nativeTurn = "codex-approved-end-unresolved-turn";
    const transcript = join(root, `rollout-fixture-${nativeSession}.jsonl`);
    writeFileSync(
      transcript,
      `${JSON.stringify({
        timestamp: "2026-08-21T20:24:00.000Z",
        ordinal: 1,
        type: "event_msg",
        payload: { type: "task_started", turn_id: nativeTurn },
      })}\n`,
    );
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: nativeTurn }),
        "codex",
      ),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "stop",
        parsed({ session_id: nativeSession, turn_id: nativeTurn, transcript_path: transcript }),
        "codex",
      ),
    );
    const state = readHookProducerStateV3(root, "codex", nativeSession);
    if (!state) throw new Error("producer state missing");

    const startedAt = performance.now();
    expect(
      recordApprovedSessionEndV3({
        coordRoot: root,
        mode: "candidate",
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        build_id: "build_fixture",
        platform: "linux",
        reason: "approved_explicit_end",
        outcome: "succeeded",
        coordination_finalized: true,
      }).state,
    ).toBe("recorded");
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(450);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(
      readHookProducerStateV3(root, "codex", nativeSession)?.pending_runtime_contexts,
    ).toBeUndefined();
    const events = readLedgerV3(root).events.map(({ event }) => event);
    expect(events.filter((event) => event.event_type === "context.observed")).toHaveLength(1);
    expect(events.at(-1)?.event_type).toBe("session.ended");
  });

  test("treats a native Codex session end as the final pending-context attempt", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-native-end-unresolved-context";
    const nativeTurn = "codex-native-end-unresolved-turn";
    const transcript = join(root, `rollout-fixture-${nativeSession}.jsonl`);
    writeFileSync(
      transcript,
      `${JSON.stringify({
        timestamp: "2026-08-21T20:24:00.000Z",
        ordinal: 1,
        type: "event_msg",
        payload: { type: "task_started", turn_id: nativeTurn },
      })}\n`,
    );
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: nativeTurn }),
        "codex",
      ),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "stop",
        parsed({ session_id: nativeSession, turn_id: nativeTurn, transcript_path: transcript }),
        "codex",
      ),
    );
    expect(
      readHookProducerStateV3(root, "codex", nativeSession)?.pending_runtime_contexts,
    ).toHaveLength(1);

    recordHookSignalV3(
      baseInput(root, "session-end", parsed({ session_id: nativeSession }), "codex"),
    );

    expect(
      readHookProducerStateV3(root, "codex", nativeSession)?.pending_runtime_contexts,
    ).toBeUndefined();
    const events = readLedgerV3(root).events.map(({ event }) => event);
    expect(events.filter((event) => event.event_type === "context.observed")).toHaveLength(1);
    expect(events.some((event) => event.event_type === "session.ended")).toBeTrue();
  });

  test("bounds late Codex context retries when the transcript remains unflushed", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-bounded-context-retry";
    const nativeTurn = "codex-bounded-context-turn";
    const transcript = join(root, `rollout-fixture-${nativeSession}.jsonl`);
    writeFileSync(
      transcript,
      `${JSON.stringify({
        timestamp: "2026-08-21T20:24:00.000Z",
        ordinal: 1,
        type: "event_msg",
        payload: { type: "task_started", turn_id: nativeTurn },
      })}\n`,
    );
    for (const [signal, turn] of [
      ["session-start", undefined],
      ["user-prompt-submit", nativeTurn],
    ] as const) {
      recordHookSignalV3(
        baseInput(
          root,
          signal,
          parsed({ session_id: nativeSession, ...(turn ? { turn_id: turn } : {}) }),
          "codex",
        ),
      );
    }
    recordHookSignalV3(
      baseInput(
        root,
        "stop",
        parsed({ session_id: nativeSession, turn_id: nativeTurn, transcript_path: transcript }),
        "codex",
      ),
    );
    recordHookSignalV3(
      baseInput(root, "pre-compact", parsed({ session_id: nativeSession }), "codex"),
    );
    expect(
      readHookProducerStateV3(root, "codex", nativeSession)?.pending_runtime_contexts,
    ).toMatchObject([{ attempts: 1 }]);
    recordHookSignalV3(
      baseInput(root, "post-compact", parsed({ session_id: nativeSession }), "codex"),
    );
    expect(
      readHookProducerStateV3(root, "codex", nativeSession)?.pending_runtime_contexts,
    ).toBeUndefined();
  });

  test("records paired local Cursor tools with an exact terminal count and no bodies", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "../../../../../tests/fixtures/adapters/cursor/local-tool-hooks.json",
        ),
        "utf8",
      ),
    ) as {
      mode: "local";
      terminal_keys: string[];
      events: Array<{
        signal: Parameters<typeof recordHookSignalV3>[0]["signal"];
        observed_at: string;
        monotonic_ns: string;
        payload: Record<string, unknown>;
      }>;
    };
    const root = candidateRoot("cursor");

    const terminalFixture = fixture.events.find(({ signal }) => signal === "stop");
    expect(Object.keys(terminalFixture?.payload ?? {}).sort()).toEqual(
      [...fixture.terminal_keys].sort(),
    );

    for (const item of fixture.events) {
      const payload = parsePayload(JSON.stringify(item.payload), "cursor");
      if (!payload) throw new Error("Cursor local fixture did not parse");
      expect(payload.cursor_mode).toBe(fixture.mode);
      expect(
        recordHookSignalV3({
          ...baseInput(root, item.signal, payload, "cursor"),
          observed_at: item.observed_at,
          monotonic_ns: item.monotonic_ns,
          runtimeTelemetryOptions: { cursorRoots: [] },
        }).state,
      ).toBe("recorded");
    }

    const ledger = readLedgerV3(root);
    const events = ledger.events.map(({ event }) => event);
    expect(events.filter(({ event_type }) => event_type === "tool.requested")).toHaveLength(1);
    const tool = events.find(({ event_type }) => event_type === "tool.completed");
    expect(tool?.event_type === "tool.completed" && tool.payload.duration_ms).toMatchObject({
      state: "observed",
      value: 15_684,
    });
    const terminal = events.find(({ event_type }) => event_type === "turn.completed");
    expect(
      terminal?.event_type === "turn.completed" && terminal.payload.tool_call_count,
    ).toMatchObject({ state: "observed", value: 1 });
    const context = events.find(({ event_type }) => event_type === "context.observed");
    expect(context?.event_type === "context.observed" && context.payload.measurement).toEqual({
      state: "expected_but_missing",
      capability: "context_usage",
      reason: "cursor_context_database_unavailable",
    });
    const durable = readFileSync(eventV3Paths(root).active, "utf8");
    expect(durable).not.toContain("PRIVATE_PROMPT_BODY");
    expect(durable).not.toContain("PRIVATE_COMMAND_BODY");
    expect(durable).not.toContain("PRIVATE_RESULT_BODY");
  });

  test("marks the evidence-shaped seven-turn Cursor cloud channel unsupported", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "../../../../../tests/fixtures/adapters/cursor/cloud-private-worker.json",
        ),
        "utf8",
      ),
    ) as {
      mode: "cloud";
      cases: Array<{ conversation_id: string; completed_turn_ms: number[] }>;
    };
    let totalTurns = 0;
    let totalWallMs = 0;

    for (const [caseIndex, fixtureCase] of fixture.cases.entries()) {
      const root = candidateRoot("cursor");
      const baseEpochMs = Date.parse(`2026-08-19T${String(caseIndex).padStart(2, "0")}:00:00.000Z`);
      let elapsedMs = 0;
      for (const [turnIndex, durationMs] of fixtureCase.completed_turn_ms.entries()) {
        const nativeTurn = `cloud-turn-${caseIndex}-${turnIndex}`;
        const prompt = parsePayload(
          JSON.stringify({
            conversation_id: fixtureCase.conversation_id,
            generation_id: nativeTurn,
            hook_event_name: "beforeSubmitPrompt",
            prompt: "PRIVATE_PROMPT_BODY",
          }),
          "cursor",
        );
        const stop = parsePayload(
          JSON.stringify({
            conversation_id: fixtureCase.conversation_id,
            generation_id: nativeTurn,
            hook_event_name: "stop",
            status: "completed",
          }),
          "cursor",
        );
        if (!prompt || !stop) throw new Error("Cursor cloud fixture did not parse");
        expect(prompt.cursor_mode).toBe(fixture.mode);
        const promptNs = BigInt(elapsedMs) * 1_000_000n;
        expect(
          recordHookSignalV3({
            ...baseInput(root, "user-prompt-submit", prompt, "cursor"),
            observed_at: new Date(baseEpochMs + elapsedMs).toISOString(),
            monotonic_ns: promptNs.toString(),
          }).state,
        ).toBe("recorded");
        elapsedMs += durationMs;
        expect(
          recordHookSignalV3({
            ...baseInput(root, "stop", stop, "cursor"),
            observed_at: new Date(baseEpochMs + elapsedMs).toISOString(),
            monotonic_ns: (BigInt(elapsedMs) * 1_000_000n).toString(),
          }).state,
        ).toBe("recorded");
        elapsedMs += 1;
      }

      const ledger = readLedgerV3(root);
      const terminals = ledger.events
        .map(({ event }) => event)
        .filter(({ event_type }) => event_type === "turn.completed");
      expect(terminals).toHaveLength(fixtureCase.completed_turn_ms.length);
      for (const terminal of terminals) {
        expect(
          terminal.event_type === "turn.completed" && terminal.payload.tool_call_count,
        ).toEqual({ state: "unsupported", capability: "turn_tool_call_count" });
      }
      for (const turn of projectLatencyV3(ledger).turns) {
        expect(turn.tool_ms).toEqual({
          state: "unknown",
          known_ms: 0,
          reasons: ["tool_call_count_unsupported"],
        });
      }
      const durable = readFileSync(eventV3Paths(root).active, "utf8");
      expect(durable).not.toContain("PRIVATE_PROMPT_BODY");
      totalTurns += terminals.length;
      totalWallMs += fixtureCase.completed_turn_ms.reduce((sum, value) => sum + value, 0);
    }

    expect(totalTurns).toBe(7);
    expect(totalWallMs).toBe(5_669_140);
  }, 15_000);

  test("deduplicates Cursor generic and shell fallback hooks and counts repeated commands", () => {
    const root = candidateRoot("cursor");
    const nativeSession = "cursor-shell-fallback";
    const command = "harn agents status --end-turn";
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ conversation_id: nativeSession }), "cursor"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ conversation_id: nativeSession, turn_id: "cursor-turn" }),
        "cursor",
      ),
    );
    const shellPayload = parsed({
      conversation_id: nativeSession,
      turn_id: "cursor-turn",
      tool_name: "Shell",
      tool_input: { command },
      raw: { hook_event_name: "beforeShellExecution", command },
    });
    const genericPayload = parsed({
      conversation_id: nativeSession,
      turn_id: "cursor-turn",
      tool_use_id: "cursor-tool-one",
      tool_name: "Shell",
      tool_input: { command },
      raw: { hook_event_name: "preToolUse" },
    });

    expect(recordHookSignalV3(baseInput(root, "pre-tool-use", shellPayload, "cursor")).state).toBe(
      "recorded",
    );
    expect(recordHookSignalV3(baseInput(root, "pre-tool-use", genericPayload, "cursor"))).toEqual({
      state: "ignored",
    });
    expect(
      recordHookSignalV3(
        baseInput(
          root,
          "post-tool-use",
          parsed({
            ...shellPayload,
            tool_response: "ok",
            raw: { hook_event_name: "afterShellExecution", command, output: "ok" },
          }),
          "cursor",
        ),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV3(
        baseInput(
          root,
          "post-tool-use",
          parsed({ ...genericPayload, tool_response: "ok" }),
          "cursor",
        ),
      ),
    ).toEqual({ state: "ignored" });

    // The same command in the same turn is a new call after the first closes.
    expect(recordHookSignalV3(baseInput(root, "pre-tool-use", shellPayload, "cursor")).state).toBe(
      "recorded",
    );
    expect(
      recordHookSignalV3(
        baseInput(
          root,
          "post-tool-use",
          parsed({ ...shellPayload, tool_response: "ok" }),
          "cursor",
        ),
      ).state,
    ).toBe("recorded");
    recordHookSignalV3(
      baseInput(
        root,
        "stop",
        parsed({ conversation_id: nativeSession, turn_id: "cursor-turn" }),
        "cursor",
      ),
    );

    const events = readLedgerV3(root).events.map(({ event }) => event);
    expect(events.filter((event) => event.event_type === "tool.requested")).toHaveLength(2);
    expect(events.filter((event) => event.event_type === "tool.completed")).toHaveLength(2);
    const stopped = events.find((event) => event.event_type === "turn.completed");
    expect(
      stopped?.event_type === "turn.completed" && stopped.payload.tool_call_count,
    ).toMatchObject({ state: "observed", value: 2 });
  });

  test("records supported native Codex terminal authority", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-session";
    expect(
      recordHookSignalV3(
        baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV3(
        baseInput(
          root,
          "session-end",
          parsed({ session_id: nativeSession, clean_exit: true }),
          "codex",
        ),
      ).state,
    ).toBe("recorded");
    expect(readLedgerV3(root).events.map(({ event }) => event.event_type)).toEqual([
      "ledger.genesis",
      "session.started",
      "session.ended",
    ]);
  });

  test("records one approved terminal and prevents resurrection", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-approved-end";
    expect(
      recordHookSignalV3(
        baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
      ).state,
    ).toBe("recorded");
    const state = readHookProducerStateV3(root, "codex", nativeSession);
    expect(state).toBeDefined();
    if (!state) throw new Error("producer state missing");
    const input = {
      coordRoot: root,
      mode: "candidate" as const,
      instance_id: state.instance_id,
      generation_id: state.generation_id,
      build_id: "build_fixture" as const,
      platform: "linux" as const,
      reason: "approved_explicit_end" as const,
      outcome: "succeeded" as const,
      coordination_finalized: true,
    };
    expect(recordApprovedSessionEndV3(input).state).toBe("recorded");
    expect(recordApprovedSessionEndV3(input).state).toBe("already_ended");
    expect(
      recordHookSignalV3(
        baseInput(root, "user-prompt-submit", parsed({ session_id: nativeSession }), "codex"),
      ).state,
    ).not.toBe("recorded");
    const terminal = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "session.ended");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.payload).toMatchObject({
      authority: "approved",
      reason: "approved_explicit_end",
    });
  });

  test("queues an explicit end inside a live turn and finalizes after that turn closes", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-deferred-end";
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(root, "user-prompt-submit", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "end-command", tool_name: "Bash" }),
        "codex",
      ),
    );
    const state = readHookProducerStateV3(root, "codex", nativeSession);
    if (!state) throw new Error("producer state missing");
    expect(
      requestSessionEndExplicitV3({
        coordRoot: root,
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        outcome: "succeeded",
        coordination_finalized: true,
      }).state,
    ).toBe("queued");
    expect(reconcileSessionFinalizationV3(root, { archive_observations: [] })).toMatchObject({
      finalized: 0,
      pending: 1,
    });
    recordHookSignalV3(
      baseInput(
        root,
        "post-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "end-command", tool_name: "Bash" }),
        "codex",
      ),
    );
    recordHookSignalV3(baseInput(root, "stop", parsed({ session_id: nativeSession }), "codex"));
    expect(reconcileSessionFinalizationV3(root, { archive_observations: [] })).toMatchObject({
      finalized: 1,
      pending: 0,
      cancelled: 0,
    });
    expect(readHookProducerStateV3(root, "codex", nativeSession)?.terminal).toBeTrue();
    expect(listSessionFinalizationRequestsV3(root)[0]).toMatchObject({
      trigger: "explicit_end",
      status: "completed",
    });
  });

  test("cancels a deferred explicit end when new work starts", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-cancel-deferred-end";
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(root, "user-prompt-submit", parsed({ session_id: nativeSession }), "codex"),
    );
    const state = readHookProducerStateV3(root, "codex", nativeSession);
    if (!state) throw new Error("producer state missing");
    expect(
      requestSessionEndExplicitV3({
        coordRoot: root,
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        coordination_finalized: true,
      }).state,
    ).toBe("queued");
    recordHookSignalV3(baseInput(root, "stop", parsed({ session_id: nativeSession }), "codex"));
    recordHookSignalV3(
      baseInput(root, "user-prompt-submit", parsed({ session_id: nativeSession }), "codex"),
    );
    expect(reconcileSessionFinalizationV3(root, { archive_observations: [] })).toMatchObject({
      finalized: 0,
      cancelled: 1,
    });
    expect(readHookProducerStateV3(root, "codex", nativeSession)?.terminal).toBeFalse();
    expect(listSessionFinalizationRequestsV3(root)[0]?.status).toBe("cancelled");
  });

  test("gives verified archive a cancellation grace period before finalizing", () => {
    const root = candidateRoot("codex");
    writeFileSync(
      join(root, ".harnery/config.jsonc"),
      JSON.stringify({ coord: { finalization: { archive_grace_seconds: 60 } } }),
    );
    const nativeSession = "codex-archive-grace";
    expect(
      recordHookSignalV3(
        baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
      ).state,
    ).toBe("recorded");
    const observedAt = "2026-08-17T12:00:00.000Z";
    const first = reconcileSessionFinalizationV3(root, {
      now: new Date(observedAt),
      archive_observations: [
        {
          adapter: "codex",
          native_session_id: nativeSession,
          archived: true,
          observed_at: observedAt,
        },
      ],
    });
    expect(first).toMatchObject({ observed: 1, finalized: 0, pending: 1 });
    expect(listSessionFinalizationRequestsV3(root)[0]?.status).toBe("pending");
    const second = reconcileSessionFinalizationV3(root, {
      now: new Date("2026-08-17T12:01:01.000Z"),
      archive_observations: [],
    });
    expect(second.finalized).toBe(1);
    const terminal = readLedgerV3(root)
      .events.map(({ event }) => event)
      .find((event) => event.event_type === "session.ended");
    expect(terminal?.payload).toMatchObject({
      authority: "approved",
      reason: "approved_verified_archive",
    });
  });

  test("reads only known Codex archive identities from a private database snapshot", () => {
    const root = candidateRoot("codex");
    const nativeSession = "known-codex-thread";
    expect(
      recordHookSignalV3(
        baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
      ).state,
    ).toBe("recorded");
    const databasePath = join(root, "codex-state.sqlite");
    const database = new Database(databasePath);
    database.run(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL, archived_at INTEGER, updated_at_ms INTEGER NOT NULL)",
    );
    database.run("INSERT INTO threads VALUES (?, 1, ?, ?)", [
      nativeSession,
      1_776_668_400,
      1_776_668_400_000,
    ]);
    database.run("INSERT INTO threads VALUES (?, 1, ?, ?)", [
      "unrelated-private-thread",
      1_776_668_401,
      1_776_668_401_000,
    ]);
    database.close();
    expect(readCodexArchiveObservationsV3(root, { databasePath }).observations).toEqual([
      {
        adapter: "codex",
        native_session_id: nativeSession,
        archived: true,
        observed_at: "2026-04-20T07:00:00.000Z",
      },
    ]);
    expect(readFileSync(eventV3Paths(root).active, "utf8")).not.toContain(nativeSession);
  });

  test("keeps host loss provisional until the cascade grace expires", () => {
    const root = candidateRoot("codex");
    writeFileSync(
      join(root, ".harnery/config.jsonc"),
      JSON.stringify({ coord: { finalization: { cascade_grace_seconds: 30 } } }),
    );
    const nativeSession = "host-loss-session";
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    const state = readHookProducerStateV3(root, "codex", nativeSession);
    if (!state) throw new Error("producer state missing");
    expect(
      observeHostDisappearedV3({
        coordRoot: root,
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        observed_at: "2026-08-17T13:00:00.000Z",
      }).state,
    ).toBe("observed");
    expect(
      reconcileSessionFinalizationV3(root, {
        now: new Date("2026-08-17T13:00:29.000Z"),
        archive_observations: [],
      }).finalized,
    ).toBe(0);
    expect(
      reconcileSessionFinalizationV3(root, {
        now: new Date("2026-08-17T13:00:31.000Z"),
        archive_observations: [],
      }).finalized,
    ).toBe(1);
  });

  test("records exact Cursor pre-compaction context but refuses unsupported completion telemetry", () => {
    const root = candidateRoot("cursor");
    const nativeSession = "cursor-session";
    expect(
      recordHookSignalV3(
        baseInput(root, "session-start", parsed({ session_id: nativeSession }), "cursor"),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV3(
        baseInput(
          root,
          "user-prompt-submit",
          parsed({ session_id: nativeSession, turn_id: "cursor-turn" }),
          "cursor",
        ),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV3(
        baseInput(
          root,
          "pre-compact",
          parsed({
            session_id: nativeSession,
            raw: {
              context_tokens: 236_096,
              context_window_size: 256_000,
              context_usage_percent: 92.225,
            },
          }),
          "cursor",
        ),
      ).state,
    ).toBe("recorded");
    const events = readLedgerV3(root).events.map(({ event }) => event);
    const compaction = events.find((event) => event.event_type === "context.compaction_started");
    expect(
      compaction?.event_type === "context.compaction_started" && compaction.payload.before,
    ).toMatchObject({
      state: "observed",
      value: { used_tokens: 236_096, limit_tokens: 256_000, remaining_tokens: 19_904 },
      attestation: "native",
      confidence: "exact",
    });
    const context = events.find((event) => event.event_type === "context.observed");
    expect(context?.event_type === "context.observed" && context.payload.measurement).toMatchObject(
      {
        state: "observed",
        value: { used_tokens: 236_096, limit_tokens: 256_000, remaining_tokens: 19_904 },
        attestation: "native",
        confidence: "exact",
      },
    );
    expect(
      recordHookSignalV3(
        baseInput(
          root,
          "post-compact",
          parsed({ session_id: nativeSession, raw: { post_tokens: 20, context_window_size: 100 } }),
          "cursor",
        ),
      ),
    ).toEqual({ state: "gate_closed", reason: "signal_not_approved:post_compaction" });
  });

  test("records Cursor native percentage telemetry at an active tool boundary", () => {
    const root = candidateRoot("cursor");
    const nativeSession = "cursor-active-context";
    const nativeTurn = "cursor-active-turn";
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "cursor"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: nativeTurn }),
        "cursor",
      ),
    );
    const request = parsed({
      session_id: nativeSession,
      turn_id: nativeTurn,
      tool_use_id: "cursor-context-tool",
      tool_name: "Shell",
    });
    recordHookSignalV3(baseInput(root, "pre-tool-use", request, "cursor"));
    expect(
      recordHookSignalV3({
        ...baseInput(
          root,
          "post-tool-use",
          parsed({
            ...request,
            raw: { context_usage_percent: 41.25 },
          }),
          "cursor",
        ),
        observed_at: "2026-08-21T20:24:15.200Z",
      }).state,
    ).toBe("recorded");

    const contexts = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "context.observed");
    expect(contexts).toHaveLength(1);
    expect(
      contexts[0]?.event_type === "context.observed" && contexts[0].payload.measurement,
    ).toEqual({
      state: "observed",
      value: {
        used_percent: 41.25,
        remaining_percent: 58.75,
        measured_at: "2026-08-21T20:24:15.200Z",
        method: "cursor_hook",
      },
      attestation: "native",
      confidence: "exact",
    });

    for (const signal of ["pre-tool-use", "post-tool-use"] as const) {
      recordHookSignalV3({
        ...baseInput(
          root,
          signal,
          parsed({
            session_id: nativeSession,
            turn_id: nativeTurn,
            tool_use_id: "cursor-context-tool-two",
            tool_name: "Shell",
            raw: { context_usage_percent: 41.25 },
          }),
          "cursor",
        ),
        observed_at: "2026-08-21T20:24:16.200Z",
        runtimeTelemetryOptions: { activeContextProbeIntervalMs: 0 },
      });
    }
    expect(
      readLedgerV3(root)
        .events.map(({ event }) => event)
        .filter((event) => event.event_type === "context.observed"),
    ).toHaveLength(1);
  });

  test("marks a regressing wall clock instead of poisoning the authority", () => {
    const root = candidateRoot();
    const nativeSession = "regressing-clock-session";
    const signals: [Parameters<typeof recordHookSignalV3>[0]["signal"], ParsedPayload, string][] = [
      ["session-start", parsed({ session_id: nativeSession }), "2026-08-19T19:39:00.000Z"],
      [
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "regressing-turn" }),
        "2026-08-19T19:39:10.000Z",
      ],
      [
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "tool-one", tool_name: "Read" }),
        "2026-08-19T19:39:30.000Z",
      ],
      [
        "post-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "tool-one", tool_name: "Read" }),
        "2026-08-19T19:39:36.078Z",
      ],
      // One millisecond behind the tool terminal it was caused by. The reader
      // rejects that only when the row leaves it unmarked.
      [
        "stop",
        parsed({ session_id: nativeSession, turn_id: "regressing-turn" }),
        "2026-08-19T19:39:36.077Z",
      ],
    ];
    for (const [signal, payload, observedAt] of signals) {
      recordHookSignalV3({ ...baseInput(root, signal, payload), observed_at: observedAt });
    }

    const ledger = readLedgerV3(root);
    expect(ledger.diagnostics).toEqual([]);
    expect(ledger.complete).toBe(true);
    const events = ledger.events.map(({ event }) => event);
    const turnTerminal = events.find((event) => event.event_type === "turn.completed");
    const toolTerminal = events.find((event) => event.event_type === "tool.completed");
    expect(turnTerminal?.time.skew).toBe("regressed");
    expect(turnTerminal?.time.observed_at).toBe("2026-08-19T19:39:36.077Z");
    expect(toolTerminal?.time.skew).toBe("unknown");
  });
});

function candidateRoot(adapter: Adapter = "claude-code"): string {
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
      `sha256:${adapterCapabilityProfileDigestV3(adapter).slice(4)}`,
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
  expect(repairEventV3ControlPair(root).state).toBe("candidate");
  return root;
}

function baseInput(
  root: string,
  signal: Parameters<typeof recordHookSignalV3>[0]["signal"],
  payload: ParsedPayload,
  adapter: Adapter = "claude-code",
) {
  return {
    coordRoot: root,
    mode: "candidate" as const,
    signal,
    payload,
    adapter,
    instance_id: "inst_fixture" as const,
    producer_id: "prd_hook" as const,
    build_id: "build_fixture" as const,
    platform: "linux" as const,
    adapterVersion: "1.0.0",
    harnessVersion: "1.0.0",
  };
}

function parsed(values: Partial<ParsedPayload>): ParsedPayload {
  return { raw: {}, ...values };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-recorder-"));
  roots.push(root);
  return root;
}

describe("event ledger V3 runtime tuning attestation changes", () => {
  test("emits attestation_changed when CC effort moves, once, with refreshed state", () => {
    const root = candidateRoot();
    const nativeSession = "native-session-tuning";
    recordHookSignalV3(
      baseInput(
        root,
        "session-start",
        parsed({ session_id: nativeSession, model: "claude-fable-5" }),
      ),
    );
    recordHookSignalV3(
      baseInput(root, "user-prompt-submit", parsed({ session_id: nativeSession, turn_id: "t1" })),
    );
    // First observed effort: the session started expected_but_missing, so the
    // first native observation lands as a change.
    recordHookSignalV3(
      baseInput(
        root,
        "pre-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "call-1",
          tool_name: "Bash",
          effort: "high",
        }),
      ),
    );
    // Same effort again: no second event.
    recordHookSignalV3(
      baseInput(
        root,
        "post-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "call-1",
          tool_name: "Bash",
          effort: "high",
        }),
      ),
    );
    // Operator moves the slider: one more event.
    recordHookSignalV3(
      baseInput(
        root,
        "pre-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "call-2",
          tool_name: "Bash",
          effort: "xhigh",
        }),
      ),
    );

    const events = readLedgerV3(root).events.map(({ event }) => event);
    const changes = events.filter((event) => event.event_type === "session.attestation_changed");
    expect(changes.length).toBe(2);
    const started = events.find((event) => event.event_type === "session.started");
    if (started?.event_type !== "session.started") throw new Error("session start missing");
    const [first, second] = changes as [
      Extract<(typeof events)[number], { event_type: "session.attestation_changed" }>,
      Extract<(typeof events)[number], { event_type: "session.attestation_changed" }>,
    ];
    expect(first.payload.prior_attestation_id).toBe(started.attestation_id);
    expect(first.payload.runtime_attestation.tuning).toMatchObject({
      state: "observed",
      value: { effort: "high" },
      attestation: "native",
    });
    expect(second.payload.prior_attestation_id).toBe(first.attestation_id);
    expect(second.payload.runtime_attestation.tuning).toMatchObject({
      state: "observed",
      value: { effort: "xhigh" },
    });
    // The refreshed attestation keeps the session's observed model.
    expect(second.payload.runtime_attestation.model).toMatchObject({
      state: "observed",
      value: { provider: "anthropic", id: "claude-fable-5" },
    });
    // A tuning refresh must preserve effective telemetry evidence verbatim.
    expect(second.payload.runtime_attestation.telemetry).toEqual(
      started.payload.runtime_attestation.telemetry,
    );
    // Later events ride the new attestation id.
    const laterTool = [...events].reverse().find((event) => event.event_type === "tool.requested");
    expect(laterTool?.attestation_id).toBe(second.attestation_id);
  });

  test("probes Codex tuning once per turn on post-tool-use while effort is unknown", () => {
    const root = candidateRoot("codex");
    const nativeSession = "01a02cc5-0000-7000-8000-000000000001";
    const rolloutDir = join(root, "sessions", "2026", "08", "22");
    mkdirSync(rolloutDir, { recursive: true });
    const rolloutPath = join(rolloutDir, `rollout-fixture-${nativeSession}.jsonl`);
    writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        timestamp: "2026-08-23T02:00:00.000Z",
        type: "turn_context",
        payload: { turn_id: "t1", model: "gpt-5.6-sol", effort: "xhigh" },
      })}\n`,
    );
    recordHookSignalV3({
      ...baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    });
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "t1" }),
        "codex",
      ),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "post-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "c1",
          tool_name: "shell",
          transcript_path: rolloutPath,
        }),
        "codex",
      ),
    );
    const events = readLedgerV3(root).events.map(({ event }) => event);
    const changes = events.filter((event) => event.event_type === "session.attestation_changed");
    expect(changes.length).toBe(1);
    expect(
      (
        changes[0] as Extract<
          (typeof events)[number],
          { event_type: "session.attestation_changed" }
        >
      ).payload.runtime_attestation.tuning,
    ).toMatchObject({ state: "observed", value: { effort: "xhigh" } });
    // A second tool event in the same turn does not re-probe or re-emit.
    recordHookSignalV3(
      baseInput(
        root,
        "post-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "c2",
          tool_name: "shell",
          transcript_path: rolloutPath,
        }),
        "codex",
      ),
    );
    const after = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "session.attestation_changed");
    expect(after.length).toBe(1);
  });

  test("stays silent when effort never moves and for payloads without effort", () => {
    const root = candidateRoot();
    const nativeSession = "native-session-static";
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession, effort: "high" })),
    );
    recordHookSignalV3(
      baseInput(root, "user-prompt-submit", parsed({ session_id: nativeSession, turn_id: "t1" })),
    );
    for (const id of ["a", "b"]) {
      recordHookSignalV3(
        baseInput(
          root,
          "pre-tool-use",
          parsed({
            session_id: nativeSession,
            tool_use_id: id,
            tool_name: "Bash",
            effort: "high",
          }),
        ),
      );
    }
    // A no-dial payload (no effort) must not flap the baseline.
    recordHookSignalV3(
      baseInput(
        root,
        "post-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "b", tool_name: "Bash" }),
      ),
    );
    const events = readLedgerV3(root).events.map(({ event }) => event);
    expect(
      events.filter((event) => event.event_type === "session.attestation_changed").length,
    ).toBe(0);
  });
});

describe("event ledger V3 hook intake spool", () => {
  const LEDGER_ROOT = ".harnery/ledgers/v3";

  function statePathFor(root: string, adapter = "claude-code"): string {
    const directory = join(root, LEDGER_ROOT, "private-producers", adapter);
    const name = readdirSync(directory).find((entry) => entry.endsWith(".json"));
    if (!name) throw new Error("no producer state file");
    return join(directory, name);
  }

  function holdStateLease(root: string, statePath: string) {
    return acquireNoClobberLease({
      path: `${statePath}.lease`,
      scope: "event-v3-hook-producer",
      authoritySha256: createHash("sha256")
        .update(join(root))
        .update("\0")
        .update(statePath)
        .digest("hex"),
      staleAfterMs: 5_000,
    });
  }

  function intakeDir(root: string, adapter = "claude-code"): string {
    return join(root, LEDGER_ROOT, "intake", "hook", adapter);
  }

  function intakeEntryCount(root: string, adapter = "claude-code"): number {
    const directory = intakeDir(root, adapter);
    if (!existsSync(directory)) return 0;
    return readdirSync(directory)
      .map((group) => readdirSync(join(directory, group)).length)
      .reduce((sum, count) => sum + count, 0);
  }

  function diagnosticsFiles(root: string): string[] {
    const directory = join(root, LEDGER_ROOT, "diagnostics");
    return existsSync(directory) ? readdirSync(directory) : [];
  }

  test("a lease-contended signal spools durably and the next signal drains it in order", () => {
    const root = candidateRoot();
    const nativeSession = "spool-session";
    recordHookSignalV3(baseInput(root, "session-start", parsed({ session_id: nativeSession })));
    const statePath = statePathFor(root);
    const lease = holdStateLease(root, statePath);
    try {
      const contended = recordHookSignalV3(
        baseInput(
          root,
          "user-prompt-submit",
          parsed({ session_id: nativeSession, turn_id: "turn-a", prompt: "queued" }),
        ),
      );
      expect(contended).toEqual({ state: "spooled" });
      expect(intakeEntryCount(root)).toBe(1);
    } finally {
      lease.release();
    }
    const next = recordHookSignalV3(
      baseInput(
        root,
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "call-1", tool_name: "Bash" }),
      ),
    );
    expect(next.state).toBe("recorded");
    expect(intakeEntryCount(root)).toBe(0);
    const ledger = readLedgerV3(root);
    const types = ledger.events.map(({ event }) => event.event_type);
    expect(types).toContain("turn.started");
    const requested = ledger.events.find(({ event }) => event.event_type === "tool.requested");
    const turn = ledger.events.find(({ event }) => event.event_type === "turn.started");
    expect((requested?.event.scope as { turn_id?: string }).turn_id).toBe(
      (turn?.event.scope as { turn_id?: string }).turn_id,
    );
  });

  test("reconcile-style drain records a marooned final signal with no later hook", () => {
    const root = candidateRoot();
    const nativeSession = "marooned-session";
    recordHookSignalV3(baseInput(root, "session-start", parsed({ session_id: nativeSession })));
    const statePath = statePathFor(root);
    const lease = holdStateLease(root, statePath);
    try {
      const contended = recordHookSignalV3(
        baseInput(
          root,
          "user-prompt-submit",
          parsed({ session_id: nativeSession, turn_id: "turn-final", prompt: "last signal" }),
        ),
      );
      expect(contended).toEqual({ state: "spooled" });
    } finally {
      lease.release();
    }
    const drained = drainHookIntakeSpoolV3(root);
    expect(drained.groups_with_records).toBe(1);
    expect(drained.groups_drained).toBe(1);
    expect(intakeEntryCount(root)).toBe(0);
    const ledger = readLedgerV3(root);
    expect(ledger.events.map(({ event }) => event.event_type)).toContain("turn.started");
  });

  test("an unidentified Cursor post is preserved in diagnostics with content redacted", () => {
    const root = candidateRoot("cursor");
    const nativeSession = "unpairable-session";
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "cursor"),
    );
    const result = recordHookSignalV3(
      baseInput(
        root,
        "post-tool-use",
        parsed({
          session_id: nativeSession,
          tool_response: { output: "RAW_TOOL_OUTPUT_SECRET" },
        }),
        "cursor",
      ),
    );
    expect(result).toEqual({ state: "unpairable_tool", reason: "missing_tool_use_id" });
    const files = diagnosticsFiles(root).filter((name) => name.startsWith("unpairable_tool-"));
    expect(files.length).toBe(1);
    const contents = readFileSync(join(root, LEDGER_ROOT, "diagnostics", files[0]!), "utf8");
    expect(contents).not.toContain("RAW_TOOL_OUTPUT_SECRET");
    expect(contents).toContain("missing_tool_use_id");
    expect(contents).toContain("sha256");
  });

  test("an unmatched post on a recovery-enabled adapter mints a derived request and pairs the native completion", () => {
    const root = candidateRoot();
    const nativeSession = "recovered-post-session";
    recordHookSignalV3(baseInput(root, "session-start", parsed({ session_id: nativeSession })));
    const result = recordHookSignalV3(
      baseInput(
        root,
        "post-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "request-lost",
          tool_name: "Bash",
          tool_input: { command: "echo hi" },
          tool_response: { output: "RAW_TOOL_OUTPUT_SECRET" },
        }),
      ),
    );
    expect(result.state).toBe("recorded");
    if (result.state !== "recorded") throw new Error("expected recorded");
    expect(result.event.event_type).toBe("tool.completed");
    expect(result.event.provenance.attestation).toBe("native");

    const rows = readLedgerV3(root).events.map((entry) => entry.event);
    const derivedRequest = rows.find((event) => event.event_type === "tool.requested");
    if (derivedRequest?.event_type !== "tool.requested") {
      throw new Error("derived request missing");
    }
    expect(derivedRequest.provenance.attestation).toBe("derived");
    expect(derivedRequest.provenance.confidence).toBe("high");
    expect(derivedRequest.payload.recovery).toEqual({ reason: "request_not_observed" });
    expect((derivedRequest.links as { span_id: string }).span_id).toBe(
      (result.event.links as { span_id: string }).span_id,
    );
    // The pair closed the span: it lives in closed-span memory, not open spans.
    const state = readHookProducerStateV3(root, "claude-code", nativeSession);
    expect(state?.spans.length).toBe(0);
    expect(state?.closed_spans.length).toBe(1);
  });

  test("late signals for a closed span are suppressed, never re-opened", () => {
    const root = candidateRoot();
    const nativeSession = "late-signal-session";
    const base = { session_id: nativeSession, tool_use_id: "call-1", tool_name: "Read" };
    recordHookSignalV3(baseInput(root, "session-start", parsed({ session_id: nativeSession })));
    recordHookSignalV3(baseInput(root, "pre-tool-use", parsed(base)));
    recordHookSignalV3(baseInput(root, "post-tool-use", parsed(base)));

    const latePost = recordHookSignalV3(baseInput(root, "post-tool-use", parsed(base)));
    expect(latePost).toEqual({ state: "suppressed", reason: "closed_span" });
    const latePre = recordHookSignalV3(baseInput(root, "pre-tool-use", parsed(base)));
    expect(latePre).toEqual({ state: "suppressed", reason: "closed_span" });
    expect(readHookProducerStateV3(root, "claude-code", nativeSession)?.spans.length).toBe(0);
    expect(
      diagnosticsFiles(root).filter((name) => name.startsWith("late_pre_suppressed-")).length,
    ).toBe(1);
    expect(
      diagnosticsFiles(root).filter((name) => name.startsWith("late_post_suppressed-")).length,
    ).toBe(1);
  });

  test("closes permission waits on a matching tool signal and on turn interruption", () => {
    const resolvedRoot = candidateRoot();
    const resolvedSession = "resolved-wait-session";
    recordHookSignalV3(
      baseInput(resolvedRoot, "session-start", parsed({ session_id: resolvedSession })),
    );
    recordHookSignalV3(
      baseInput(
        resolvedRoot,
        "user-prompt-submit",
        parsed({ session_id: resolvedSession, turn_id: "turn-1", prompt: "go" }),
      ),
    );
    recordHookSignalV3(
      baseInput(
        resolvedRoot,
        "permission-request",
        parsed({ session_id: resolvedSession, tool_use_id: "permission-1" }),
      ),
    );
    recordHookSignalV3(
      baseInput(
        resolvedRoot,
        "pre-tool-use",
        parsed({
          session_id: resolvedSession,
          tool_use_id: "permission-1",
          tool_name: "Bash",
        }),
      ),
    );
    const resolved = readLedgerV3(resolvedRoot)
      .events.map(({ event }) => event)
      .filter(
        (event) =>
          event.event_type === "wait.started" ||
          event.event_type === "wait.ended" ||
          event.event_type === "tool.requested",
      );
    expect(resolved.map(({ event_type }) => event_type)).toEqual([
      "wait.started",
      "wait.ended",
      "tool.requested",
    ]);
    const started = resolved[0];
    const ended = resolved[1];
    expect(ended?.payload).toMatchObject({
      wait_id: (started?.payload as { wait_id: string }).wait_id,
      outcome: "succeeded",
      resolution_reference: "pre-tool-use",
    });
    expect(readHookProducerStateV3(resolvedRoot, "claude-code", resolvedSession)?.waits).toEqual(
      [],
    );

    const interruptedRoot = candidateRoot();
    const interruptedSession = "interrupted-wait-session";
    recordHookSignalV3(
      baseInput(interruptedRoot, "session-start", parsed({ session_id: interruptedSession })),
    );
    recordHookSignalV3(
      baseInput(
        interruptedRoot,
        "user-prompt-submit",
        parsed({ session_id: interruptedSession, turn_id: "turn-1", prompt: "go" }),
      ),
    );
    recordHookSignalV3(
      baseInput(
        interruptedRoot,
        "permission-request",
        parsed({ session_id: interruptedSession, tool_use_id: "permission-2" }),
      ),
    );
    recordHookSignalV3(
      baseInput(
        interruptedRoot,
        "stop-failure",
        parsed({ session_id: interruptedSession, turn_id: "turn-1" }),
      ),
    );
    const interrupted = readLedgerV3(interruptedRoot)
      .events.map(({ event }) => event)
      .filter(
        (event) => event.event_type === "wait.ended" || event.event_type === "turn.completed",
      );
    expect(interrupted.map(({ event_type }) => event_type)).toEqual([
      "wait.ended",
      "turn.completed",
    ]);
    expect(interrupted[0]?.payload).toMatchObject({
      outcome: "interrupted",
      resolution_reference: "turn_terminal",
    });
  });

  test("a stop boundary terminalizes the ending turn's stamped spans before turn.completed", () => {
    const root = candidateRoot();
    const nativeSession = "boundary-session";
    recordHookSignalV3({
      ...baseInput(root, "session-start", parsed({ session_id: nativeSession })),
      observed_at: "2026-08-19T21:47:15.000Z",
      monotonic_ns: "987000000000",
    });
    recordHookSignalV3({
      ...baseInput(root, "user-prompt-submit", parsed({ session_id: nativeSession, prompt: "go" })),
      observed_at: "2026-08-19T21:47:16.000Z",
      monotonic_ns: "988000000000",
    });
    recordHookSignalV3({
      ...baseInput(
        root,
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "lost-call", tool_name: "Bash" }),
      ),
      observed_at: "2026-08-19T21:47:16.307Z",
      monotonic_ns: "988307000000",
    });
    recordHookSignalV3({
      ...baseInput(root, "stop", parsed({ session_id: nativeSession })),
      observed_at: "2026-08-19T21:48:27.017Z",
      monotonic_ns: "1059017000000",
    });

    const rows = readLedgerV3(root).events.map((entry) => entry.event);
    const derived = rows.find(
      (event) =>
        event.event_type === "tool.completed" && event.provenance.attestation === "derived",
    );
    if (derived?.event_type !== "tool.completed") {
      throw new Error("derived terminal missing");
    }
    expect(derived.payload.outcome).toBe("unknown");
    expect(derived.payload.recovery?.reason).toBe("completion_not_observed_before_turn_end");
    expect(derived.payload.recovery?.requested_event_id).toBeDefined();
    expect(derived.payload.duration_ms).toEqual({
      state: "unknown",
      reason: "completion_not_observed_before_turn_end",
    });
    expect(derived.payload.recovery?.elapsed_upper_bound_ms).toEqual({
      state: "observed",
      value: 70_710,
      attestation: "derived",
      confidence: "exact",
    });
    expect(derived.payload.span.duration_ms).toEqual(derived.payload.duration_ms);
    const turnCompleted = rows.find((event) => event.event_type === "turn.completed");
    expect(rows.indexOf(derived)).toBeLessThan(rows.indexOf(turnCompleted as never));
    expect(readHookProducerStateV3(root, "claude-code", nativeSession)?.spans.length).toBe(0);
  });

  test("a boundary burst labels long orphan intervals as upper bounds", () => {
    const root = candidateRoot();
    const nativeSession = "boundary-burst-session";
    recordHookSignalV3({
      ...baseInput(root, "session-start", parsed({ session_id: nativeSession })),
      observed_at: "2026-08-19T21:29:59.000Z",
      monotonic_ns: "999000000000",
    });
    recordHookSignalV3({
      ...baseInput(root, "user-prompt-submit", parsed({ session_id: nativeSession, prompt: "go" })),
      observed_at: "2026-08-19T21:30:00.000Z",
      monotonic_ns: "1000000000000",
    });
    for (const [index, observed_at, monotonic_ns] of [
      [1, "2026-08-19T21:30:02.000Z", "1002000000000"],
      [2, "2026-08-19T21:35:02.000Z", "1302000000000"],
      [3, "2026-08-19T21:39:02.000Z", "1542000000000"],
    ] as const) {
      recordHookSignalV3({
        ...baseInput(
          root,
          "pre-tool-use",
          parsed({
            session_id: nativeSession,
            tool_use_id: `lost-call-${index}`,
            tool_name: "Bash",
          }),
        ),
        observed_at,
        monotonic_ns,
      });
    }
    recordHookSignalV3({
      ...baseInput(root, "stop", parsed({ session_id: nativeSession })),
      observed_at: "2026-08-19T21:40:02.000Z",
      monotonic_ns: "1602000000000",
    });

    const recovered = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter(
        (event) =>
          event.event_type === "tool.completed" &&
          event.payload.recovery?.reason === "completion_not_observed_before_turn_end",
      );
    expect(recovered).toHaveLength(3);
    expect(
      recovered.map((event) =>
        event.event_type === "tool.completed"
          ? event.payload.recovery?.elapsed_upper_bound_ms
          : undefined,
      ),
    ).toEqual([
      { state: "observed", value: 600_000, attestation: "derived", confidence: "exact" },
      { state: "observed", value: 300_000, attestation: "derived", confidence: "exact" },
      { state: "observed", value: 60_000, attestation: "derived", confidence: "exact" },
    ]);
    for (const event of recovered) {
      if (event.event_type !== "tool.completed") throw new Error("recovered terminal missing");
      expect(event.payload.duration_ms).toEqual({
        state: "unknown",
        reason: "completion_not_observed_before_turn_end",
      });
      expect(event.payload.outcome).toBe("unknown");
    }
  });

  test("a lost stop is recovered at the next turn start", () => {
    const root = candidateRoot("codex");
    const nativeSession = "lost-stop-session";
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "turn-1" }),
        "codex",
      ),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "pre-tool-use",
        parsed({
          session_id: nativeSession,
          turn_id: "turn-1",
          tool_use_id: "abandoned",
          tool_name: "shell",
        }),
        "codex",
      ),
    );
    // Stop hook lost; the next prompt starts turn-2.
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "turn-2" }),
        "codex",
      ),
    );
    const rows = readLedgerV3(root).events.map((entry) => entry.event);
    const derived = rows.find(
      (event) =>
        event.event_type === "tool.completed" && event.provenance.attestation === "derived",
    );
    if (derived?.event_type !== "tool.completed") {
      throw new Error("derived terminal missing");
    }
    expect(derived.payload.recovery?.reason).toBe("completion_not_observed_before_next_turn");
    expect(derived.provenance.confidence).toBe("low");
    expect(readHookProducerStateV3(root, "codex", nativeSession)?.spans.length).toBe(0);
  });

  test("a mid-flight session onboards with a derived session.started; a terminal one never resurrects", () => {
    const root = candidateRoot();
    const nativeSession = "mid-flight-session";
    const result = recordHookSignalV3(
      baseInput(
        root,
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "first-signal", tool_name: "Bash" }),
      ),
    );
    expect(result.state).toBe("recorded");
    const rows = readLedgerV3(root).events.map((entry) => entry.event);
    const started = rows.find((event) => event.event_type === "session.started");
    if (started?.event_type !== "session.started") {
      throw new Error("derived session.started missing");
    }
    expect(started.provenance.attestation).toBe("derived");
    expect(started.payload.resume).toEqual({
      state: "unknown",
      reason: "mid_flight_onboarding",
    });

    // Authoritative termination still refuses later signals.
    const state = readHookProducerStateV3(root, "claude-code", nativeSession);
    if (!state) throw new Error("missing state");
    recordHookSignalV3(baseInput(root, "stop", parsed({ session_id: nativeSession })));
    expect(
      recordApprovedSessionEndV3({
        coordRoot: root,
        mode: "candidate",
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        build_id: "build_fixture",
        platform: "linux",
        reason: "approved_explicit_end",
        outcome: "succeeded",
        coordination_finalized: true,
      }).state,
    ).toBe("recorded");
    const afterEnd = recordHookSignalV3(
      baseInput(
        root,
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "zombie", tool_name: "Bash" }),
      ),
    );
    expect(afterEnd.state).toBe("missing_session_start");
  });

  test("a poison intake record is quarantined and the drain continues", () => {
    const root = candidateRoot();
    const nativeSession = "poison-session";
    recordHookSignalV3(baseInput(root, "session-start", parsed({ session_id: nativeSession })));
    const adapterDir = intakeDir(root);
    const group = readdirSync(adapterDir)[0]!;
    writeFileSync(join(adapterDir, group, "0000000000000-poison.json"), "not json", {
      mode: 0o600,
    });
    const next = recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "turn-b", prompt: "after poison" }),
      ),
    );
    expect(next.state).toBe("recorded");
    expect(intakeEntryCount(root)).toBe(0);
    const files = diagnosticsFiles(root).filter((name) => name.startsWith("intake_unreadable-"));
    expect(files.length).toBe(1);
  });
});

describe("pending explicit-end expiry", () => {
  test("a wedged explicit end (turn never closes) is cancelled after the grace period, never terminalized", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-wedged-end";
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "turn-w" }),
        "codex",
      ),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "pre-tool-use",
        parsed({
          session_id: nativeSession,
          turn_id: "turn-w",
          tool_use_id: "orphan-call",
          tool_name: "Bash",
        }),
        "codex",
      ),
    );
    // The stop hook is lost: the turn never closes, so salvage stays
    // ineligible (open turn) and the wedge this expiry mechanism targets forms.
    const state = readHookProducerStateV3(root, "codex", nativeSession);
    if (!state) throw new Error("missing producer state");
    const queued = requestSessionEndExplicitV3({
      coordRoot: root,
      instance_id: state.instance_id,
      generation_id: state.generation_id,
      outcome: "succeeded",
      coordination_finalized: true,
    });
    expect(queued.state).toBe("queued");

    // A second explicit end reports the exact blocker instead of a bare refusal.
    const repeated = requestSessionEndExplicitV3({
      coordRoot: root,
      instance_id: state.instance_id,
      generation_id: state.generation_id,
      outcome: "succeeded",
      coordination_finalized: true,
    });
    expect(repeated.state).toBe("already_requested");
    if (repeated.state === "already_requested") {
      expect(repeated.blocker.open_span_ids.length).toBe(1);
      expect(repeated.blocker.current_turn_open).toBeTrue();
    }

    // Inside the grace period the request stays pending.
    expect(reconcileSessionFinalizationV3(root, { archive_observations: [] })).toMatchObject({
      pending: 1,
      cancelled: 0,
    });
    // Past the grace period it is cancelled (a safe, reversible transition) —
    // never terminalized from age alone.
    const future = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const expired = reconcileSessionFinalizationV3(root, {
      archive_observations: [],
      now: future,
    });
    expect(expired.cancelled).toBe(1);
    expect(
      expired.diagnostics.some((d) => d.startsWith("expired_pending_explicit_end:")),
    ).toBeTrue();
    expect(readHookProducerStateV3(root, "codex", nativeSession)?.terminal).toBeFalse();
    expect(listSessionFinalizationRequestsV3(root)[0]).toMatchObject({ status: "cancelled" });
  });

  test("a closed-turn explicit end with approved orphan spans salvages instead of expiring", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-salvage-end";
    recordHookSignalV3(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    // No turn context: the orphan span stays unstamped, survives the stop
    // boundary sweep (fail closed), and only explicit-end salvage can reach it.
    recordHookSignalV3(
      baseInput(
        root,
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "orphan-call", tool_name: "Bash" }),
        "codex",
      ),
    );
    recordHookSignalV3(baseInput(root, "stop", parsed({ session_id: nativeSession }), "codex"));
    expect(readHookProducerStateV3(root, "codex", nativeSession)?.spans.length).toBe(1);

    const state = readHookProducerStateV3(root, "codex", nativeSession);
    if (!state) throw new Error("missing producer state");
    const queued = requestSessionEndExplicitV3({
      coordRoot: root,
      instance_id: state.instance_id,
      generation_id: state.generation_id,
      outcome: "succeeded",
      coordination_finalized: true,
    });
    expect(queued.state).toBe("queued");

    const reconciled = reconcileSessionFinalizationV3(root, { archive_observations: [] });
    expect(reconciled.finalized).toBe(1);
    expect(reconciled.diagnostics.some((d) => d.startsWith("salvaged_explicit_end:"))).toBeTrue();
    const rows = readLedgerV3(root).events.map(({ event }) => event);
    const salvage = rows.find(
      (event) =>
        event.event_type === "tool.completed" &&
        event.payload.recovery?.reason === "explicit_end_salvage",
    );
    if (salvage?.event_type !== "tool.completed") {
      throw new Error("salvage terminal missing");
    }
    expect(salvage.payload.outcome).toBe("unknown");
    expect(salvage.payload.duration_ms).toEqual({
      state: "unknown",
      reason: "explicit_end_salvage",
    });
    expect(salvage.payload.span.duration_ms).toEqual(salvage.payload.duration_ms);
    expect(salvage.payload.recovery?.elapsed_upper_bound_ms).toEqual({
      state: "unknown",
      reason: "recovery_monotonic_clock_unavailable",
    });
    const ended = rows.find((event) => event.event_type === "session.ended");
    expect(ended).toBeDefined();
    expect(readHookProducerStateV3(root, "codex", nativeSession)?.terminal).toBeTrue();
    expect(listSessionFinalizationRequestsV3(root)[0]).toMatchObject({ status: "completed" });
  });
});
