import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateStopHook } from "./stop-hook.ts";

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `agent-coord-stop-test-${process.pid}-${Date.now()}`);
  mkdirSync(join(root, ".harnery"), { recursive: true });
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
        harness: "claude-code",
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
        harness: "claude-code",
        source: "test",
        data: {},
      },
      {
        event_id: "2",
        event_type: "turn.stop",
        ts: ts(-1000),
        instance_id: "a",
        session_id: "a",
        harness: "claude-code",
        source: "test",
        data: { status_box_present: true },
      },
    ]);
    const v = evaluateStopHook(root, { rule: "stop-hook", instance_id: "a", now_ms: now });
    expect(v.allow).toBe(true);
  });

  // --- Harness-aware ack signal (Cursor) ---
  // Cursor renders Shell output inline, so running `harn agents status`
  // (state.status_checked) is the end-of-turn ack signal; the verbatim box
  // paste (rule 2/3, transcript-scanned) is a Claude-Code-collapsed-UI remedy
  // that's redundant + undetectable here. Cursor never carries
  // status_box_present, so the verdict must NOT require it.

  test("cursor tool-turn: status_checked + task_set pass WITHOUT a box (rule 2/3 not required)", () => {
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "c", session_id: "c", harness: "cursor", source: "test" };
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
      harness: "cursor",
      now_ms: now,
    });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("stop-hook.pass");
  });

  test("cursor tool-turn: missing task_set → block rule 3/3", () => {
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "c", session_id: "c", harness: "cursor", source: "test" };
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
      harness: "cursor",
      now_ms: now,
    });
    expect(v.allow).toBe(false);
    expect(v.rule).toBe("stop-hook.rule_3_3");
  });

  test("cursor: status_checked is the ack signal, missing it blocks rule 1/3 (not 2/3)", () => {
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "c", session_id: "c", harness: "cursor", source: "test" };
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
      harness: "cursor",
      now_ms: now,
    });
    expect(v.allow).toBe(false);
    expect(v.rule).toBe("stop-hook.rule_1_3");
  });

  test("cursor pure-prose turn (no tools, no status) → block rule 1/3 (parity: every turn)", () => {
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "c", session_id: "c", harness: "cursor", source: "test" };
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
      harness: "cursor",
      now_ms: now,
    });
    expect(v.allow).toBe(false);
    expect(v.rule).toBe("stop-hook.rule_1_3");
  });

  test("claude-code tool-turn still requires the box (rule 2/3); cursor change doesn't leak", () => {
    const now = Date.now();
    const ts = (o: number) => new Date(now + o).toISOString();
    const base = { instance_id: "d", session_id: "d", harness: "claude-code", source: "test" };
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
      harness: "claude-code",
      now_ms: now,
    });
    expect(v.allow).toBe(false);
    expect(v.rule).toBe("stop-hook.rule_2_3");
  });
});
