import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserGuard, type GuardDecision, type GuardOwner } from "./browser-guard.ts";
import type { BrowserCall } from "./types.ts";

const A: GuardOwner = { id: "owner-a", label: "agent-A" };
const B: GuardOwner = { id: "owner-b", label: "agent-B" };

let dir: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browser-guard-"));
  clock = Date.parse("2026-01-01T00:00:00Z");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function guard() {
  return createBrowserGuard({ dir, now });
}

function code(decision: GuardDecision): string | undefined {
  return decision.ok ? undefined : decision.code;
}

const attach = (pid?: number, window_id?: number): BrowserCall => ({
  kind: "attach",
  tool: "attach_browser",
  pid,
  window_id,
});
const bind = (pid?: number, window_id?: number, session = "s1"): BrowserCall => ({
  kind: "bind",
  tool: "get_browser_state",
  pid,
  window_id,
  session,
});
const onTab = (
  kind: BrowserCall["kind"],
  target_id: string,
  extra: Partial<BrowserCall> = {},
): BrowserCall => ({ kind, tool: `${kind}_tool`, target_id, tab_id: "tab1", ...extra });

/** Attach to pid 10 window 1 as owner A (own window), bind it as t1, snapshot tab1. */
function setupBound(g = guard(), snapshot = { sensitive_refs: ["p1:0"], password_offer: false }) {
  g.recordWindow(A, { pid: 10, window_id: 1, session: "s1" });
  g.observe(A, attach(10, 1), {});
  g.observe(A, bind(10, 1), { bound: { target_id: "t1", pid: 10, window_id: 1 } });
  g.observe(A, onTab("read", "t1"), {
    snapshot: { target_id: "t1", tab_id: "tab1", ...snapshot },
  });
  return g;
}

describe("check: launch and opaque", () => {
  test("launch is always allowed", () => {
    expect(guard().check(A, { kind: "launch", tool: "launch_browser" })).toEqual({ ok: true });
  });

  test("an opaque program is refused", () => {
    const d = guard().check(A, { kind: "opaque", tool: "run_script" });
    expect(code(d)).toBe("browser_script_not_checked");
    if (!d.ok) expect(d.hint).toContain("its own call");
  });

  test("an unknown kind is allowed", () => {
    expect(guard().check(A, { kind: "weird" as BrowserCall["kind"], tool: "x" }).ok).toBe(true);
  });
});

describe("check: attach", () => {
  test("missing pid or window_id is left to the driver", () => {
    const g = guard();
    expect(g.check(A, attach()).ok).toBe(true);
    expect(g.check(A, attach(10)).ok).toBe(true);
    expect(g.check(A, attach(undefined, 1)).ok).toBe(true);
  });

  test("a window the owner recorded is allowed", () => {
    const g = guard();
    g.recordWindow(A, { pid: 10, window_id: 1, session: "s1" });
    expect(g.check(A, attach(10, 1)).ok).toBe(true);
  });

  test("an unrecorded window is refused, and another owner's window too", () => {
    const g = guard();
    g.recordWindow(A, { pid: 10, window_id: 1, session: "s1" });
    const d = g.check(B, attach(10, 1));
    expect(code(d)).toBe("browser_window_not_yours");
    if (!d.ok) {
      expect(d.message).toContain("not one you opened");
      expect(d.hint).toContain("computer browser open command");
      expect(d.hint).toContain("--person-window");
    }
    expect(code(g.check(A, attach(10, 2)))).toBe("browser_window_not_yours");
  });

  test("personWindow overrides ownership", () => {
    expect(guard().check(A, attach(10, 1), { personWindow: true }).ok).toBe(true);
  });
});

describe("check: bind", () => {
  test("missing pid or window_id is allowed", () => {
    expect(guard().check(A, bind(undefined, 1)).ok).toBe(true);
  });

  test("a pid nobody attached to is allowed (driver-owned browser)", () => {
    expect(guard().check(A, bind(20, 5)).ok).toBe(true);
  });

  test("attached_pids are global across owners", () => {
    const g = guard();
    g.observe(B, attach(10, 1), {});
    expect(code(g.check(A, bind(10, 1)))).toBe("browser_window_not_yours");
    g.recordWindow(A, { pid: 10, window_id: 2, session: "s1" });
    expect(g.check(A, bind(10, 2)).ok).toBe(true);
    expect(g.check(A, bind(10, 1), { personWindow: true }).ok).toBe(true);
  });

  test("an attach the driver refused still marks the pid", () => {
    const g = guard();
    g.observe(A, attach(30), {});
    expect(code(g.check(A, bind(30, 1)))).toBe("browser_window_not_yours");
  });
});

describe("check: tab calls", () => {
  test("missing target_id is allowed", () => {
    expect(guard().check(A, { kind: "read", tool: "r" }).ok).toBe(true);
  });

  test("an unknown target is refused", () => {
    const d = guard().check(A, onTab("read", "nope"));
    expect(code(d)).toBe("browser_target_unknown");
    if (!d.ok) expect(d.hint).toContain("get_browser_state");
  });

  test("another owner's target is unknown to this owner", () => {
    const g = setupBound();
    expect(g.check(A, onTab("read", "t1")).ok).toBe(true);
    expect(code(g.check(B, onTab("read", "t1")))).toBe("browser_target_unknown");
  });

  test("typing into a sensitive field is refused; other fields are allowed", () => {
    const g = setupBound();
    expect(code(g.check(A, onTab("type", "t1", { ref: "p1:0" })))).toBe("browser_sensitive_field");
    expect(g.check(A, onTab("type", "t1", { ref: "p2:0" })).ok).toBe(true);
  });

  test("typed then point is refused until a fresh snapshot", () => {
    const g = setupBound();
    expect(g.check(A, onTab("point", "t1")).ok).toBe(true);
    g.observe(A, onTab("type", "t1", { ref: "p2:0" }), { delivered: true });
    expect(code(g.check(A, onTab("point", "t1")))).toBe("browser_read_back_required");
    g.observe(A, onTab("read", "t1"), {
      snapshot: { target_id: "t1", tab_id: "tab1", sensitive_refs: [], password_offer: false },
    });
    expect(g.check(A, onTab("point", "t1")).ok).toBe(true);
  });

  test("an undelivered type does not mark the tab typed", () => {
    const g = setupBound();
    g.observe(A, onTab("type", "t1", { ref: "p2:0" }), { delivered: false });
    expect(g.check(A, onTab("point", "t1")).ok).toBe(true);
  });

  test("typing into an unsnapshotted tab creates its entry", () => {
    const g = setupBound();
    g.observe(A, onTab("type", "t1", { tab_id: "tab2" }), { delivered: true });
    expect(code(g.check(A, onTab("point", "t1", { tab_id: "tab2" })))).toBe(
      "browser_read_back_required",
    );
  });

  test("a password manager offer refuses point; typed takes precedence", () => {
    const g = setupBound(guard(), { sensitive_refs: [], password_offer: true });
    expect(code(g.check(A, onTab("point", "t1")))).toBe("browser_password_offer");
    expect(g.check(A, onTab("act", "t1")).ok).toBe(true);
    g.observe(A, onTab("type", "t1"), { delivered: true });
    expect(code(g.check(A, onTab("point", "t1")))).toBe("browser_read_back_required");
  });

  test("a delivered navigation clears the tab's state", () => {
    const g = setupBound(guard(), { sensitive_refs: ["p1:0"], password_offer: true });
    g.observe(A, onTab("act", "t1", { navigates: true }), { delivered: true });
    expect(g.check(A, onTab("type", "t1", { ref: "p1:0" })).ok).toBe(true);
    expect(g.check(A, onTab("point", "t1")).ok).toBe(true);
  });

  test("a snapshot for an unknown target is ignored", () => {
    const g = guard();
    g.observe(A, onTab("read", "ghost"), {
      snapshot: { target_id: "ghost", tab_id: "tab1", sensitive_refs: [], password_offer: false },
    });
    expect(code(g.check(A, onTab("read", "ghost")))).toBe("browser_target_unknown");
  });
});

describe("observe: bind", () => {
  test("re-binding the same window replaces the old target and its tabs", () => {
    const g = setupBound();
    g.observe(A, bind(10, 1), { bound: { target_id: "t2" } });
    expect(code(g.check(A, onTab("read", "t1")))).toBe("browser_target_unknown");
    expect(g.check(A, onTab("type", "t2", { ref: "p1:0" })).ok).toBe(true);
  });

  test("a bind uses the call's pid and window when the result omits them", () => {
    const g = guard();
    g.observe(A, bind(10, 1), { bound: { target_id: "t1" } });
    g.observe(A, bind(10, 1), { bound: { target_id: "t2" } });
    const raw = JSON.parse(readFileSync(join(dir, "browser.json"), "utf8"));
    expect(raw.targets.map((t: { target_id: string }) => t.target_id)).toEqual(["t2"]);
    expect(raw.targets[0].pid).toBe(10);
    expect(raw.targets[0].window_id).toBe(1);
  });

  test("another owner's bind of the same window does not drop this owner's target", () => {
    const g = setupBound();
    g.observe(B, bind(10, 1), { bound: { target_id: "tb", pid: 10, window_id: 1 } });
    expect(g.check(A, onTab("read", "t1")).ok).toBe(true);
    expect(g.check(B, onTab("read", "tb")).ok).toBe(true);
  });

  test("person_window is recorded from the option", () => {
    const g = guard();
    g.observe(A, bind(10, 1), { bound: { target_id: "t1" } }, { personWindow: true });
    const raw = JSON.parse(readFileSync(join(dir, "browser.json"), "utf8"));
    expect(raw.targets[0].person_window).toBe(true);
  });
});

describe("work, clear, list", () => {
  test("work lists this owner's sessions and own windows only", () => {
    const g = guard();
    g.recordWindow(A, { pid: 10, window_id: 1, session: "s1" });
    g.observe(A, bind(99, 7, "s2"), { bound: { target_id: "tp" } }, { personWindow: true });
    g.observe(A, bind(99, 8, ""), { bound: { target_id: "tq" } });
    g.recordWindow(B, { pid: 11, window_id: 3, session: "sb" });
    const w = g.work(A);
    expect(w.sessions.sort()).toEqual(["s1", "s2"]);
    expect(w.windows).toEqual([{ pid: 10, window_id: 1 }]);
  });

  test("recordWindow upserts by (pid, window_id)", () => {
    const g = guard();
    g.recordWindow(A, { pid: 10, window_id: 1, session: "s1" });
    g.recordWindow(B, { pid: 10, window_id: 1, session: "s9" });
    const all = g.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ owner_id: "owner-b", owner_label: "agent-B", session: "s9" });
  });

  test("clear removes this owner's windows and targets but keeps attached pids", () => {
    const g = setupBound();
    g.recordWindow(B, { pid: 11, window_id: 3, session: "sb" });
    g.clear(A);
    expect(g.work(A)).toEqual({ sessions: [], windows: [] });
    expect(g.list().map((w) => w.owner_id)).toEqual(["owner-b"]);
    expect(code(g.check(A, onTab("read", "t1")))).toBe("browser_target_unknown");
    expect(code(g.check(A, bind(10, 1)))).toBe("browser_window_not_yours");
  });
});

describe("store", () => {
  test("state persists across guard instances on the same dir", () => {
    setupBound(createBrowserGuard({ dir, now }));
    const second = createBrowserGuard({ dir, now });
    expect(code(second.check(A, onTab("type", "t1", { ref: "p1:0" })))).toBe(
      "browser_sensitive_field",
    );
    expect(second.list()).toHaveLength(1);
  });

  test("a missing directory is created on write", () => {
    const nested = join(dir, "a", "b");
    const g = createBrowserGuard({ dir: nested, now });
    expect(g.list()).toEqual([]);
    g.recordWindow(A, { pid: 1, window_id: 1, session: "" });
    expect(JSON.parse(readFileSync(join(nested, "browser.json"), "utf8")).windows).toHaveLength(1);
  });

  test("a malformed file reads as empty state and is replaced on write", () => {
    writeFileSync(join(dir, "browser.json"), "{not json");
    const g = guard();
    expect(g.list()).toEqual([]);
    expect(g.check(A, bind(10, 1)).ok).toBe(true);
    g.recordWindow(A, { pid: 10, window_id: 1, session: "s1" });
    expect(g.list()).toHaveLength(1);
  });

  test("a wrong-shaped file drops bad entries", () => {
    writeFileSync(
      join(dir, "browser.json"),
      JSON.stringify({ windows: [{ pid: "x" }, null], attached_pids: "no", targets: [{}] }),
    );
    expect(guard().list()).toEqual([]);
  });

  test("entries older than 24 hours are dropped", () => {
    const g = setupBound();
    clock += 23 * 60 * 60 * 1000;
    g.recordWindow(B, { pid: 11, window_id: 3, session: "sb" });
    expect(g.list()).toHaveLength(2);
    clock += 2 * 60 * 60 * 1000;
    g.recordWindow(B, { pid: 12, window_id: 4, session: "sb" });
    const raw = JSON.parse(readFileSync(join(dir, "browser.json"), "utf8"));
    expect(raw.windows.map((w: { pid: number }) => w.pid).sort()).toEqual([11, 12]);
    expect(raw.attached_pids).toEqual([]);
    expect(raw.targets).toEqual([]);
    expect(g.check(A, bind(10, 1)).ok).toBe(true);
  });
});
