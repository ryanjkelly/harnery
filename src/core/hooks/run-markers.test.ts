import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexHookRunsCheck, codexWindowsBridgeCheck } from "../../commands/doctor.ts";
import {
  clearHookRunMarker,
  findUnfinishedHookRuns,
  hookRunMarkerDir,
  writeHookRunMarker,
} from "./run-markers.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function makeRoot(config?: string): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-hook-runs-"));
  mkdirSync(join(root, ".harnery"), { recursive: true });
  if (config) writeFileSync(join(root, ".harnery", "config.jsonc"), config);
  roots.push(root);
  return root;
}

const T0 = Date.parse("2026-10-05T10:00:00.000Z");
const dead = () => false;

describe("hook run markers", () => {
  test("a completed run leaves no marker", () => {
    const root = makeRoot();
    const path = writeHookRunMarker(root, {
      event: "pre-tool-use",
      adapter: "codex",
      pid: 4242,
      timeout_sec: 20,
    });
    expect(path && existsSync(path)).toBe(true);
    clearHookRunMarker(path);
    expect(readdirSync(hookRunMarkerDir(root))).toEqual([]);
  });

  test("a killed run is reported once it outlives its timeout plus grace", () => {
    const root = makeRoot();
    writeHookRunMarker(
      root,
      { event: "pre-tool-use", adapter: "codex", pid: 1, timeout_sec: 20 },
      new Date(T0),
    );
    writeHookRunMarker(
      root,
      { event: "pre-tool-use", adapter: "codex", pid: 2, timeout_sec: 20 },
      new Date(T0),
    );
    writeHookRunMarker(
      root,
      { event: "stop", adapter: "codex", pid: 3, timeout_sec: 20 },
      new Date(T0),
    );
    expect(findUnfinishedHookRuns(root, T0 + 40_000, undefined, dead).count).toBe(0);
    const runs = findUnfinishedHookRuns(root, T0 + 60_000, undefined, dead);
    expect(runs.count).toBe(3);
    expect(runs.events).toEqual([
      { event: "pre-tool-use", count: 2 },
      { event: "stop", count: 1 },
    ]);
    expect(runs.latest).toBe("2026-10-05T10:00:00.000Z");
  });

  test("a live process past its timeout and runs outside the window are not counted", () => {
    const root = makeRoot();
    writeHookRunMarker(
      root,
      { event: "stop", adapter: "codex", pid: 7, timeout_sec: 20 },
      new Date(T0),
    );
    expect(findUnfinishedHookRuns(root, T0 + 60_000, undefined, () => true).count).toBe(0);
    expect(findUnfinishedHookRuns(root, T0 + 25 * 3600_000, undefined, dead).count).toBe(0);
  });

  test("markers older than a week are pruned on the next write", () => {
    const root = makeRoot();
    const old = writeHookRunMarker(root, {
      event: "stop",
      adapter: "codex",
      pid: 8,
      timeout_sec: 20,
    });
    const eightDaysAgo = (Date.now() - 8 * 24 * 3600_000) / 1000;
    utimesSync(old!, eightDaysAgo, eightDaysAgo);
    writeHookRunMarker(root, { event: "stop", adapter: "codex", pid: 9, timeout_sec: 20 });
    expect(readdirSync(hookRunMarkerDir(root))).toEqual(["9-stop.json"]);
  });

  test("a missing marker directory reads as none", () => {
    expect(findUnfinishedHookRuns(makeRoot()).count).toBe(0);
  });
});

describe("doctor checks", () => {
  test("codex:hook runs warns with counts per event", () => {
    const root = makeRoot();
    writeHookRunMarker(
      root,
      { event: "pre-tool-use", adapter: "codex", pid: 1, timeout_sec: 20 },
      new Date(T0),
    );
    const check = codexHookRunsCheck(root, T0 + 60_000, dead);
    expect(check?.severity).toBe("warn");
    expect(check?.detail).toContain("1 hook run started but never finished");
    expect(check?.detail).toContain("pre-tool-use ×1");
    expect(codexHookRunsCheck(makeRoot(), T0, dead)).toBeNull();
  });

  test("codex:Windows hook route reports the opt-in and an invalid value", () => {
    expect(codexWindowsBridgeCheck(makeRoot())).toBeNull();
    const on = codexWindowsBridgeCheck(
      makeRoot('{ "hooks": { "codexWindowsBridge": { "entryPoint": "codex-wsl-hook" } } }'),
    );
    expect(on?.severity).toBe("ok");
    expect(on?.detail).toContain("codex-wsl-hook");
    const bad = codexWindowsBridgeCheck(
      makeRoot('{ "hooks": { "codexWindowsBridge": { "entryPoint": "a;b" } } }'),
    );
    expect(bad?.severity).toBe("warn");
  });
});
