import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRunLock,
  addNotice,
  autoUpdateLockPath,
  autoUpdateStatePath,
  inspectLock,
  lockStaleMinutes,
  mutateAutoUpdateState,
  pendingNotices,
  readAutoUpdateState,
} from "./state.ts";

const CFG = { timeoutMinutes: 20, steps: [["a"]], dailySteps: [] as string[][] };
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnery-autoupdate-state-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("state file", () => {
  test("missing and corrupt files read as fresh state", () => {
    expect(readAutoUpdateState(root)).toEqual({ schema: 1, notices: [], delivered: {} });
    mkdirSync(join(root, ".harnery/private/autoupdate"), { recursive: true });
    writeFileSync(autoUpdateStatePath(root), "{not json");
    expect(readAutoUpdateState(root).notices).toEqual([]);
  });

  test("mutate round-trips through an atomic write", () => {
    mutateAutoUpdateState(root, (s) => {
      s.dailyAt = "2026-11-01T00:00:00.000Z";
    });
    expect(readAutoUpdateState(root).dailyAt).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("notices", () => {
  test("dedupes the same kind and text within 24h and keeps the newest 20", () => {
    const state = readAutoUpdateState(root);
    const a = addNotice(state, "info", "hello", NOW);
    const b = addNotice(state, "info", "hello", NOW + 60_000);
    expect(b.id).toBe(a.id);
    addNotice(state, "info", "hello", NOW + 25 * 3600_000);
    expect(state.notices).toHaveLength(2);
    for (let i = 0; i < 30; i += 1) addNotice(state, "info", `n${i}`, NOW + i);
    expect(state.notices).toHaveLength(20);
    expect(state.notices.at(-1)?.text).toBe("n29");
  });

  test("pendingNotices delivers each notice once per session", () => {
    mutateAutoUpdateState(root, (s) => {
      addNotice(s, "instructions", "old", NOW - 30 * 3600_000);
      addNotice(s, "hooks", "recent", NOW - 3600_000);
    });
    const first = pendingNotices(root, "session-a", NOW);
    expect(first.map((n) => n.text)).toEqual(["recent"]);
    expect(pendingNotices(root, "session-a", NOW)).toEqual([]);
    expect(pendingNotices(root, "session-b", NOW).map((n) => n.text)).toEqual(["recent"]);
    mutateAutoUpdateState(root, (s) => {
      addNotice(s, "info", "newer", NOW + 1000);
    });
    expect(pendingNotices(root, "session-a", NOW + 2000).map((n) => n.text)).toEqual(["newer"]);
  });

  test("prunes delivery records older than 7 days", () => {
    mutateAutoUpdateState(root, (s) => {
      s.delivered.ancient = new Date(NOW - 8 * 86400_000).toISOString();
      addNotice(s, "info", "x", NOW);
    });
    pendingNotices(root, "fresh", NOW);
    expect(Object.keys(readAutoUpdateState(root).delivered)).toEqual(["fresh"]);
  });
});

describe("run lock", () => {
  test("a held lock blocks a second acquirer and releases", () => {
    const first = acquireRunLock(root, CFG, NOW);
    expect(first.acquired).toBe(true);
    const second = acquireRunLock(root, CFG, NOW);
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.owner?.pid).toBe(process.pid);
    if (first.acquired) first.release();
    expect(inspectLock(root, CFG, NOW).held).toBe(false);
  });

  test("a stale lock is broken", () => {
    mkdirSync(autoUpdateLockPath(root), { recursive: true });
    const staleAt = NOW - (lockStaleMinutes(CFG) + 1) * 60_000;
    writeFileSync(
      join(autoUpdateLockPath(root), "owner.json"),
      JSON.stringify({ pid: 999999, at: new Date(staleAt).toISOString() }),
    );
    expect(inspectLock(root, CFG, NOW).stale).toBe(true);
    const attempt = acquireRunLock(root, CFG, NOW);
    expect(attempt.acquired).toBe(true);
    if (attempt.acquired) attempt.release();
  });
});
