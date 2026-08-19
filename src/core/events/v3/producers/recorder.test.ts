import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import type { Adapter } from "../../../adapter.ts";
import { readCodexArchiveObservationsV3 } from "../../../agents/codex-archive-v3.ts";
import {
  listSessionFinalizationRequestsV3,
  observeHostDisappearedV3,
  reconcileSessionFinalizationV3,
  requestSessionEndExplicitV3,
} from "../../../agents/session-finalizer-v3.ts";
import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import { acquireNoClobberLease } from "../../../workflow/workspaces/leases.ts";
import { buildEventV3 } from "../builder.ts";
import { canonicalJsonV3, sha256V3 } from "../canonical.ts";
import { adapterCapabilityProfileDigestV3 } from "../capabilities.ts";
import {
  type CandidateGenesisManifestV3,
  type CandidateProfileV3,
  candidateProfileDigestV3,
  EVENT_V3_GENESIS_MANIFEST,
  repairEventV3ControlPair,
} from "../control.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "../fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "../generated.ts";
import { projectLatencyV3 } from "../latency.ts";
import { readLedgerV3 } from "../reader.ts";
import { eventV3Paths } from "../writer.ts";
import {
  drainHookIntakeSpoolV3,
  readHookProducerStateV3,
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
    const started = events.find((event) => event.event_type === "agent.started");
    const completed = events.find((event) => event.event_type === "agent.completed");
    expect(started?.payload.delegation_id).toBe(completed?.payload.delegation_id);
    expect(started?.payload.child_generation_id).toBe(completed?.payload.child_generation_id);
    expect(readHookProducerStateV3(root, "claude-code", nativeSession)?.delegations).toEqual([]);
    expect(readFileSync(eventV3Paths(root).active, "utf8")).not.toContain(nativeChild);
  });

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

  test("records Cursor pre-compaction but refuses unsupported completion telemetry", () => {
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
          "pre-compact",
          parsed({ session_id: nativeSession, raw: { pre_tokens: 80, context_window_size: 100 } }),
          "cursor",
        ),
      ).state,
    ).toBe("recorded");
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
    recordHookSignalV3(baseInput(root, "session-start", parsed({ session_id: nativeSession })));
    recordHookSignalV3(
      baseInput(root, "user-prompt-submit", parsed({ session_id: nativeSession, prompt: "go" })),
    );
    recordHookSignalV3(
      baseInput(
        root,
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "lost-call", tool_name: "Bash" }),
      ),
    );
    recordHookSignalV3(baseInput(root, "stop", parsed({ session_id: nativeSession })));

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
    const turnCompleted = rows.find((event) => event.event_type === "turn.completed");
    expect(rows.indexOf(derived)).toBeLessThan(rows.indexOf(turnCompleted as never));
    expect(readHookProducerStateV3(root, "claude-code", nativeSession)?.spans.length).toBe(0);
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
    const ended = rows.find((event) => event.event_type === "session.ended");
    expect(ended).toBeDefined();
    expect(readHookProducerStateV3(root, "codex", nativeSession)?.terminal).toBeTrue();
    expect(listSessionFinalizationRequestsV3(root)[0]).toMatchObject({ status: "completed" });
  });
});
