import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateStopHook, STOP_REMEDIATION_MARKER } from "./stop-hook.ts";

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `agent-coord-stop-test-${process.pid}-${Date.now()}`);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  writeFileSync(
    join(root, ".harnery", "config.jsonc"),
    `{ "agents": { "requireGitFinalization": false } }`,
    "utf8",
  );
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

function writeEvents(events: Array<Record<string, unknown>>): void {
  const path = join(root, ".harnery", "events.ndjson");
  writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

describe("evaluateStopHook", () => {
  test("bypass=true short-circuits to allow", () => {
    const v = evaluateStopHook(root, { rule: "stop-hook", instance_id: "x", bypass: true });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("stop-hook.bypass");
  });

  test("codex is observe-only even when every ritual signal is missing", () => {
    const now = Date.now();
    const ts = (offset: number) => new Date(now + offset).toISOString();
    writeEvents([
      {
        event_id: "1",
        event_type: "user_prompt.submit",
        ts: ts(-10000),
        instance_id: "codex-agent",
        session_id: "codex-session",
        adapter: "codex",
        source: "test",
        data: {},
      },
      {
        event_id: "2",
        event_type: "tool.pre_use",
        ts: ts(-8000),
        instance_id: "codex-agent",
        session_id: "codex-session",
        adapter: "codex",
        source: "test",
        data: {},
      },
      {
        event_id: "3",
        event_type: "turn.stop",
        ts: ts(-1000),
        instance_id: "codex-agent",
        session_id: "codex-session",
        adapter: "codex",
        source: "test",
        data: { status_box_present: false },
      },
    ]);

    const v = evaluateStopHook(root, {
      rule: "stop-hook",
      instance_id: "codex-agent",
      adapter: "codex",
      now_ms: now,
    });

    expect(v.allow).toBe(true);
    expect(v.exit_code).toBe(0);
    expect(v.rule).toBe("stop-hook.codex_observe_only");
  });

  test("missing events.ndjson → no_history (empty stream allows)", () => {
    // readRecentEvents returns [] when the file doesn't exist; no events for
    // owner → defer-allow under "stop-hook.no_history".
    const v = evaluateStopHook(root, { rule: "stop-hook", instance_id: "x" });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("stop-hook.no_history");
  });

  test("no canonical events for owner → defer-allow", () => {
    writeEvents([
      {
        event_id: "1",
        event_type: "session.start",
        ts: new Date().toISOString(),
        instance_id: "other",
        session_id: "s",
        adapter: "claude-code",
        source: "test",
        data: {},
      },
    ]);
    const v = evaluateStopHook(root, { rule: "stop-hook", instance_id: "missing" });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("stop-hook.no_history");
  });

  test("pure-prose turn (zero tool.pre_use) exempts rules 1/3 + 3/3", () => {
    const now = Date.now();
    const ts = (offset: number) => new Date(now + offset).toISOString();
    writeEvents([
      {
        event_id: "1",
        event_type: "user_prompt.submit",
        ts: ts(-10000),
        instance_id: "a",
        session_id: "a",
        adapter: "claude-code",
        source: "test",
        data: {},
      },
      {
        event_id: "2",
        event_type: "turn.stop",
        ts: ts(-1000),
        instance_id: "a",
        session_id: "a",
        adapter: "claude-code",
        source: "test",
        data: { status_box_present: true },
      },
    ]);
    const v = evaluateStopHook(root, { rule: "stop-hook", instance_id: "a", now_ms: now });
    expect(v.allow).toBe(true);
  });

  // --- Adapter-aware ack signal (Cursor) ---
  // Cursor renders Shell output inline, so running `harn agents status`
  // (state.status_checked) is the end-of-turn ack signal; the verbatim box
  // paste (rule 2/3, transcript-scanned) is a Claude-Code-collapsed-UI remedy
  // that's redundant + undetectable here. Cursor never carries
  // status_box_present, so the verdict must NOT require it.

  test("cursor tool-turn: status_checked + task_set pass WITHOUT a box (rule 2/3 not required)", () => {
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "c", session_id: "c", adapter: "cursor", source: "test" };
    writeEvents([
      { event_id: "1", event_type: "user_prompt.submit", ts: ts(-9000), ...base, data: {} },
      { event_id: "2", event_type: "tool.pre_use", ts: ts(-8000), ...base, data: {} },
      { event_id: "3", event_type: "state.status_checked", ts: ts(-3000), ...base, data: {} },
      { event_id: "4", event_type: "state.task_set", ts: ts(-2000), ...base, data: {} },
      {
        event_id: "5",
        event_type: "turn.stop",
        ts: ts(-1000),
        ...base,
        data: { status_box_present: false },
      },
    ]);
    const v = evaluateStopHook(root, {
      rule: "stop-hook",
      instance_id: "c",
      adapter: "cursor",
      now_ms: now,
    });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("stop-hook.pass");
  });

  test("opted-in host rejects a plain status event and accepts Git-finalization evidence", () => {
    writeFileSync(
      join(root, ".harnery", "config.jsonc"),
      `{ "agents": { "requireGitFinalization": true } }`,
      "utf8",
    );
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "c", session_id: "c", adapter: "cursor", source: "test" };
    const events = (gitFinalizationChecked: boolean) => [
      { event_id: "1", event_type: "user_prompt.submit", ts: ts(-9000), ...base, data: {} },
      { event_id: "2", event_type: "tool.pre_use", ts: ts(-8000), ...base, data: {} },
      {
        event_id: "3",
        event_type: "state.status_checked",
        ts: ts(-3000),
        ...base,
        data: { git_finalization_checked: gitFinalizationChecked },
      },
      { event_id: "4", event_type: "state.task_set", ts: ts(-2000), ...base, data: {} },
      {
        event_id: "5",
        event_type: "turn.stop",
        ts: ts(-1000),
        ...base,
        data: { status_box_present: false },
      },
    ];

    writeEvents(events(false));
    const plain = evaluateStopHook(root, {
      rule: "stop-hook",
      instance_id: "c",
      adapter: "cursor",
      now_ms: now,
    });
    expect(plain.allow).toBe(false);
    expect(plain.rule).toBe("stop-hook.rule_1_3");
    expect(plain.reason).toContain("agents status --final");

    writeEvents(events(true));
    const guarded = evaluateStopHook(root, {
      rule: "stop-hook",
      instance_id: "c",
      adapter: "cursor",
      now_ms: now,
    });
    expect(guarded.allow).toBe(true);
    expect(guarded.rule).toBe("stop-hook.pass");
  });

  test("cursor tool-turn: missing task_set → block rule 3/3", () => {
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "c", session_id: "c", adapter: "cursor", source: "test" };
    writeEvents([
      { event_id: "1", event_type: "user_prompt.submit", ts: ts(-9000), ...base, data: {} },
      { event_id: "2", event_type: "tool.pre_use", ts: ts(-8000), ...base, data: {} },
      { event_id: "3", event_type: "state.status_checked", ts: ts(-3000), ...base, data: {} },
      {
        event_id: "4",
        event_type: "turn.stop",
        ts: ts(-1000),
        ...base,
        data: { status_box_present: false },
      },
    ]);
    const v = evaluateStopHook(root, {
      rule: "stop-hook",
      instance_id: "c",
      adapter: "cursor",
      now_ms: now,
    });
    expect(v.allow).toBe(false);
    expect(v.rule).toBe("stop-hook.rule_3_3");
  });

  test("cursor: status_checked is the ack signal, missing it blocks rule 1/3 (not 2/3)", () => {
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "c", session_id: "c", adapter: "cursor", source: "test" };
    writeEvents([
      { event_id: "1", event_type: "user_prompt.submit", ts: ts(-9000), ...base, data: {} },
      { event_id: "2", event_type: "tool.pre_use", ts: ts(-8000), ...base, data: {} },
      {
        event_id: "3",
        event_type: "turn.stop",
        ts: ts(-1000),
        ...base,
        data: { status_box_present: false },
      },
    ]);
    const v = evaluateStopHook(root, {
      rule: "stop-hook",
      instance_id: "c",
      adapter: "cursor",
      now_ms: now,
    });
    expect(v.allow).toBe(false);
    expect(v.rule).toBe("stop-hook.rule_1_3");
  });

  test("cursor pure-prose turn (no tools, no status) → block rule 1/3 (parity: every turn)", () => {
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "c", session_id: "c", adapter: "cursor", source: "test" };
    writeEvents([
      { event_id: "1", event_type: "user_prompt.submit", ts: ts(-9000), ...base, data: {} },
      {
        event_id: "2",
        event_type: "turn.stop",
        ts: ts(-1000),
        ...base,
        data: { status_box_present: false },
      },
    ]);
    const v = evaluateStopHook(root, {
      rule: "stop-hook",
      instance_id: "c",
      adapter: "cursor",
      now_ms: now,
    });
    expect(v.allow).toBe(false);
    expect(v.rule).toBe("stop-hook.rule_1_3");
  });

  test("claude-code tool-turn still requires the box (rule 2/3); cursor change doesn't leak", () => {
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "d", session_id: "d", adapter: "claude-code", source: "test" };
    writeEvents([
      { event_id: "1", event_type: "user_prompt.submit", ts: ts(-9000), ...base, data: {} },
      { event_id: "2", event_type: "tool.pre_use", ts: ts(-8000), ...base, data: {} },
      { event_id: "3", event_type: "state.status_checked", ts: ts(-3000), ...base, data: {} },
      { event_id: "4", event_type: "state.task_set", ts: ts(-2000), ...base, data: {} },
      {
        event_id: "5",
        event_type: "turn.stop",
        ts: ts(-1000),
        ...base,
        data: { status_box_present: false },
      },
    ]);
    const v = evaluateStopHook(root, {
      rule: "stop-hook",
      instance_id: "d",
      adapter: "claude-code",
      now_ms: now,
    });
    expect(v.allow).toBe(false);
    expect(v.rule).toBe("stop-hook.rule_2_3");
  });

  // Cross-turn remediation. Cursor answers a Stop block by auto-submitting our
  // message as a NEW user turn, so these cases cover the window that spans the
  // repair turn and the turn it repairs. Judged per-turn, the pair below
  // alternates rule_3_3 / rule_1_3 forever: the repair runs a tool, so the new
  // turn needs both signals while the earlier one sits outside the window.
  const remediationPrompt = (rule: string) =>
    `${STOP_REMEDIATION_MARKER} rule=${rule}]\nEnd-of-turn rule: repair the ritual.`;

  test("cursor remediation followup inherits the window of the turn it repairs", () => {
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "e", session_id: "e", adapter: "cursor", source: "test" };
    writeEvents([
      // Human turn: ran tools and status, forgot set-task → blocked rule 3/3.
      {
        event_id: "1",
        event_type: "user_prompt.submit",
        ts: ts(-30000),
        ...base,
        data: { prompt_text: "anything else before we wrap?" },
      },
      { event_id: "2", event_type: "tool.pre_use", ts: ts(-25000), ...base, data: {} },
      { event_id: "3", event_type: "state.status_checked", ts: ts(-24000), ...base, data: {} },
      {
        event_id: "4",
        event_type: "turn.stop",
        ts: ts(-20000),
        ...base,
        data: { status_box_present: false },
      },
      // Repair turn, opened by our own followup: supplies only the missing half.
      {
        event_id: "5",
        event_type: "user_prompt.submit",
        ts: ts(-15000),
        ...base,
        data: { prompt_text: remediationPrompt("stop-hook.rule_3_3") },
      },
      { event_id: "6", event_type: "tool.pre_use", ts: ts(-12000), ...base, data: {} },
      { event_id: "7", event_type: "state.task_set", ts: ts(-11000), ...base, data: {} },
      {
        event_id: "8",
        event_type: "turn.stop",
        ts: ts(-1000),
        ...base,
        data: { status_box_present: false },
      },
    ]);
    const v = evaluateStopHook(root, {
      rule: "stop-hook",
      instance_id: "e",
      adapter: "cursor",
      now_ms: now,
    });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("stop-hook.pass");

    // The same stream judged with the window pinned to the repair turn alone is
    // the pre-fix behavior, and it blocks: the agent supplied task_set, so the
    // verdict now demands status_checked, which it already gave one turn ago.
    // That is the alternation the remediation walk-back removes.
    const perTurn = evaluateStopHook(root, {
      rule: "stop-hook",
      instance_id: "e",
      adapter: "cursor",
      now_ms: now,
      turn_window: { start_ms: now - 15000, end_ms: now },
    });
    expect(perTurn.allow).toBe(false);
    expect(perTurn.rule).toBe("stop-hook.rule_1_3");
  });

  test("a chain of remediation followups anchors on the last human prompt", () => {
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "f", session_id: "f", adapter: "cursor", source: "test" };
    writeEvents([
      {
        event_id: "1",
        event_type: "user_prompt.submit",
        ts: ts(-40000),
        ...base,
        data: { prompt_text: "human turn" },
      },
      { event_id: "2", event_type: "tool.pre_use", ts: ts(-38000), ...base, data: {} },
      { event_id: "3", event_type: "state.status_checked", ts: ts(-37000), ...base, data: {} },
      {
        event_id: "4",
        event_type: "user_prompt.submit",
        ts: ts(-30000),
        ...base,
        data: { prompt_text: remediationPrompt("stop-hook.rule_3_3") },
      },
      { event_id: "5", event_type: "tool.pre_use", ts: ts(-28000), ...base, data: {} },
      // Repair ran the wrong command (status again), so a second followup fired.
      { event_id: "6", event_type: "state.status_checked", ts: ts(-27000), ...base, data: {} },
      {
        event_id: "7",
        event_type: "user_prompt.submit",
        ts: ts(-20000),
        ...base,
        data: { prompt_text: remediationPrompt("stop-hook.rule_3_3") },
      },
      { event_id: "8", event_type: "tool.pre_use", ts: ts(-18000), ...base, data: {} },
      { event_id: "9", event_type: "state.task_set", ts: ts(-17000), ...base, data: {} },
      {
        event_id: "10",
        event_type: "turn.stop",
        ts: ts(-1000),
        ...base,
        data: { status_box_present: false },
      },
    ]);
    const v = evaluateStopHook(root, {
      rule: "stop-hook",
      instance_id: "f",
      adapter: "cursor",
      now_ms: now,
    });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("stop-hook.pass");
  });

  test("a followup in the pre-marker format is still recognized (upgrade rollout window)", () => {
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "h", session_id: "h", adapter: "cursor", source: "test" };
    writeEvents([
      {
        event_id: "1",
        event_type: "user_prompt.submit",
        ts: ts(-30000),
        ...base,
        data: { prompt_text: "human turn" },
      },
      { event_id: "2", event_type: "tool.pre_use", ts: ts(-25000), ...base, data: {} },
      { event_id: "3", event_type: "state.status_checked", ts: ts(-24000), ...base, data: {} },
      // Written by the build that was running before this change shipped.
      {
        event_id: "4",
        event_type: "user_prompt.submit",
        ts: ts(-15000),
        ...base,
        data: {
          prompt_text:
            "End-of-turn rule (3/3): no state.task_set event found in this turn.\n[agent-hook stop]: rule=stop-hook.rule_3_3",
        },
      },
      { event_id: "5", event_type: "tool.pre_use", ts: ts(-12000), ...base, data: {} },
      { event_id: "6", event_type: "state.task_set", ts: ts(-11000), ...base, data: {} },
      {
        event_id: "7",
        event_type: "turn.stop",
        ts: ts(-1000),
        ...base,
        data: { status_box_present: false },
      },
    ]);
    const v = evaluateStopHook(root, {
      rule: "stop-hook",
      instance_id: "h",
      adapter: "cursor",
      now_ms: now,
    });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("stop-hook.pass");
  });

  test("now_ms bounds the anchor search: a later prompt cannot anchor this turn", () => {
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "i", session_id: "i", adapter: "cursor", source: "test" };
    writeEvents([
      {
        event_id: "1",
        event_type: "user_prompt.submit",
        ts: ts(-30000),
        ...base,
        data: { prompt_text: "the turn under judgement" },
      },
      { event_id: "2", event_type: "tool.pre_use", ts: ts(-28000), ...base, data: {} },
      { event_id: "3", event_type: "state.status_checked", ts: ts(-27000), ...base, data: {} },
      { event_id: "4", event_type: "state.task_set", ts: ts(-26000), ...base, data: {} },
      {
        event_id: "5",
        event_type: "turn.stop",
        ts: ts(-25000),
        ...base,
        data: { status_box_present: false },
      },
      // Later history, past the cutoff. Replaying a recorded stop must not let
      // this anchor the window (which would leave it empty and block wrongly).
      {
        event_id: "6",
        event_type: "user_prompt.submit",
        ts: ts(-5000),
        ...base,
        data: { prompt_text: "a later turn" },
      },
      { event_id: "7", event_type: "tool.pre_use", ts: ts(-4000), ...base, data: {} },
    ]);
    const v = evaluateStopHook(root, {
      rule: "stop-hook",
      instance_id: "i",
      adapter: "cursor",
      now_ms: now - 24000,
    });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("stop-hook.pass");
  });

  test("a real human prompt does NOT inherit ritual credit from the previous turn", () => {
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "g", session_id: "g", adapter: "cursor", source: "test" };
    writeEvents([
      {
        event_id: "1",
        event_type: "user_prompt.submit",
        ts: ts(-30000),
        ...base,
        data: { prompt_text: "first human turn" },
      },
      { event_id: "2", event_type: "tool.pre_use", ts: ts(-28000), ...base, data: {} },
      { event_id: "3", event_type: "state.status_checked", ts: ts(-27000), ...base, data: {} },
      { event_id: "4", event_type: "state.task_set", ts: ts(-26000), ...base, data: {} },
      {
        event_id: "5",
        event_type: "turn.stop",
        ts: ts(-25000),
        ...base,
        data: { status_box_present: false },
      },
      // Second human turn: ritual not performed. Must still block.
      {
        event_id: "6",
        event_type: "user_prompt.submit",
        ts: ts(-15000),
        ...base,
        data: { prompt_text: "second human turn" },
      },
      { event_id: "7", event_type: "tool.pre_use", ts: ts(-12000), ...base, data: {} },
      {
        event_id: "8",
        event_type: "turn.stop",
        ts: ts(-1000),
        ...base,
        data: { status_box_present: false },
      },
    ]);
    const v = evaluateStopHook(root, {
      rule: "stop-hook",
      instance_id: "g",
      adapter: "cursor",
      now_ms: now,
    });
    expect(v.allow).toBe(false);
    expect(v.rule).toBe("stop-hook.rule_1_3");
  });
});
