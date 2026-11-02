import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { processStartToken } from "../agents/state/proc-start.ts";
import { autoCleanArtifacts, createArtifact } from "./index.ts";

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-autoclean-"));
  // Without a repo the tracked-paths guard fails closed (managed-tracked) and
  // nothing ever classifies as expired.
  spawnSync("git", ["init", "-q", root], { stdio: "ignore" });
  roots.push(root);
  return root;
}

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
});

/** One artifact created at t0 with a 1-day TTL, plus a payload file. */
function seedExpired(root: string, t0: Date, slug = "sweep-me"): string {
  const created = createArtifact(root, {
    slug,
    purpose: "test payload",
    retentionDays: 1,
    now: t0,
  });
  writeFileSync(join(created.path, "payload.txt"), "expired bytes\n");
  return created.path;
}

// Times run FORWARD from the real clock: expiry derives from real file
// mtimes (retention resets on modification), so a fake past `now` would make
// freshly-written test files look modified-in-the-future and never expired.
const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = new Date();
const T0_PLUS_3D = new Date(T0.getTime() + 3 * DAY_MS);
const T0_PLUS_3D_PLUS_30M = new Date(T0.getTime() + 3 * DAY_MS + 30 * 60 * 1000);
const T0_PLUS_3D_PLUS_61M = new Date(T0.getTime() + 3 * DAY_MS + 61 * 60 * 1000);

/** Count `git ls-files` processes started while `run` executes. */
function countLsFiles<T>(
  run: () => T,
  after?: (call: number) => void,
): { result: T; calls: number } {
  const original = childProcess.spawnSync;
  let calls = 0;
  const spy = spyOn(childProcess, "spawnSync").mockImplementation(((
    command: string,
    args?: readonly string[],
    options?: childProcess.SpawnSyncOptions,
  ) => {
    const out = original(command, args ?? [], options ?? {});
    if (command === "git" && args?.[0] === "ls-files") {
      calls++;
      after?.(calls);
    }
    return out;
  }) as typeof childProcess.spawnSync);
  try {
    return { result: run(), calls };
  } finally {
    spy.mockRestore();
  }
}

/** A lock owned by this live test process, as a concurrent worker would hold it. */
function holdLockAsLiveOwner(root: string): string {
  const lock = join(root, ".harnery/artifacts-mutation.lock");
  mkdirSync(lock);
  writeFileSync(
    join(lock, "owner-22222222-2222-2222-2222-222222222222.json"),
    JSON.stringify({
      version: 1,
      host: hostname(),
      pid: process.pid,
      process_start: processStartToken(process.pid),
      acquired_at: new Date().toISOString(),
    }),
  );
  return lock;
}

describe("autoCleanArtifacts", () => {
  test("a live concurrent owner makes the sweep a quiet skip, not an error", () => {
    const root = makeRoot();
    const path = seedExpired(root, T0);
    const lock = holdLockAsLiveOwner(root);
    expect(autoCleanArtifacts(root, { now: T0_PLUS_3D })).toEqual({
      ran: false,
      reason: "busy",
      deleted: 0,
      bytes: 0,
    });
    expect(existsSync(join(root, ".harnery/artifacts-auto-clean.json"))).toBe(false);
    expect(existsSync(path)).toBe(true);
    rmSync(lock, { recursive: true });
    expect(autoCleanArtifacts(root, { now: T0_PLUS_3D }).deleted).toBe(1);
  });

  test("an owner whose run cannot be verified still surfaces as an error", () => {
    const root = makeRoot();
    seedExpired(root, T0);
    const lock = holdLockAsLiveOwner(root);
    const [file] = readdirSync(lock);
    const owner = JSON.parse(readFileSync(join(lock, file!), "utf8"));
    writeFileSync(join(lock, file!), JSON.stringify({ ...owner, process_start: null }));
    expect(() => autoCleanArtifacts(root, { now: T0_PLUS_3D })).toThrow("lock unavailable");
  });

  test("one Git listing serves the whole inventory, and one more guards the deletions", () => {
    const root = makeRoot();
    for (let i = 0; i < 4; i++) seedExpired(root, T0, `expired-${i}`);
    const kept = createArtifact(root, { slug: "current", purpose: "fresh", retentionDays: 30 });
    writeFileSync(join(kept.path, "payload.txt"), "keep\n");
    const { result, calls } = countLsFiles(() => autoCleanArtifacts(root, { now: T0_PLUS_3D }));
    expect(result).toMatchObject({ reason: "swept", deleted: 4 });
    expect(calls).toBe(2);
    expect(existsSync(kept.path)).toBe(true);
  });

  test("a throttled sweep starts no Git process", () => {
    const root = makeRoot();
    seedExpired(root, T0);
    autoCleanArtifacts(root, { now: T0_PLUS_3D });
    const { result, calls } = countLsFiles(() =>
      autoCleanArtifacts(root, { now: T0_PLUS_3D_PLUS_30M }),
    );
    expect(result.reason).toBe("fresh");
    expect(calls).toBe(0);
  });

  test("a file Git starts tracking after the first listing still blocks deletion", () => {
    const root = makeRoot();
    const tracked = seedExpired(root, T0, "becomes-tracked");
    const other = seedExpired(root, T0, "stays-untracked");
    const { result } = countLsFiles(
      () => autoCleanArtifacts(root, { now: T0_PLUS_3D }),
      (call) => {
        if (call !== 1) return;
        const added = spawnSync("git", ["add", "-f", join(tracked, "payload.txt")], {
          cwd: root,
          windowsHide: true,
        });
        expect(added.status).toBe(0);
      },
    );
    expect(result.deleted).toBe(1);
    expect(existsSync(tracked)).toBe(true);
    expect(existsSync(other)).toBe(false);
  });

  test("when Git cannot answer, nothing is deleted", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-autoclean-nogit-"));
    roots.push(root);
    const path = seedExpired(root, T0);
    // Keep Git from discovering an enclosing repository above the temp dir.
    setEnv("GIT_CEILING_DIRECTORIES", tmpdir());
    setEnv("GIT_DIR", join(root, "missing-git-dir"));
    expect(autoCleanArtifacts(root, { now: T0_PLUS_3D }).deleted).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test("lock contention does not consume the hourly cleanup opportunity", () => {
    const root = makeRoot();
    const path = seedExpired(root, T0);
    const lock = join(root, ".harnery/artifacts-mutation.lock");
    mkdirSync(lock);
    expect(() => autoCleanArtifacts(root, { now: T0_PLUS_3D })).toThrow();
    expect(existsSync(join(root, ".harnery/artifacts-auto-clean.json"))).toBe(false);
    expect(existsSync(path)).toBe(true);
    rmdirSync(lock);
    expect(autoCleanArtifacts(root, { now: T0_PLUS_3D }).deleted).toBe(1);
  });
  test("sweeps expired workspaces and stamps the run", () => {
    const root = makeRoot();
    const path = seedExpired(root, T0);
    const result = autoCleanArtifacts(root, { now: T0_PLUS_3D });
    expect(result).toMatchObject({ ran: true, reason: "swept", deleted: 1 });
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(false);
    const stamp = JSON.parse(
      readFileSync(join(root, ".harnery", "artifacts-auto-clean.json"), "utf8"),
    );
    expect(stamp.status).toBe("completed");
    expect(stamp.last_completed_at).toBe(T0_PLUS_3D.toISOString());
    expect(stamp.deleted).toBe(1);
  });

  test("keeps an unexpired workspace", () => {
    const root = makeRoot();
    const path = seedExpired(root, T0);
    const result = autoCleanArtifacts(root, { now: new Date(T0.getTime() + 12 * 60 * 60 * 1000) });
    expect(result.deleted).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test("an interrupted attempt does not count as a completed sweep", () => {
    const root = makeRoot();
    const path = seedExpired(root, T0);
    writeFileSync(
      join(root, ".harnery/artifacts-auto-clean.json"),
      JSON.stringify({
        status: "running",
        last_attempt_at: T0_PLUS_3D.toISOString(),
      }),
    );
    expect(autoCleanArtifacts(root, { now: T0_PLUS_3D }).deleted).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  test("partial sweeps yield and continue after a short cooldown", () => {
    const root = makeRoot();
    for (let i = 0; i < 3; i++) seedExpired(root, T0, `expired-${i}`);
    expect(autoCleanArtifacts(root, { now: T0_PLUS_3D, maxDeletes: 1 })).toMatchObject({
      reason: "partial",
      deleted: 1,
    });
    const stamp = JSON.parse(
      readFileSync(join(root, ".harnery/artifacts-auto-clean.json"), "utf8"),
    );
    expect(stamp).toMatchObject({ status: "partial", remaining: 2 });
    expect(stamp.last_completed_at).toBeUndefined();
    expect(autoCleanArtifacts(root, { now: T0_PLUS_3D }).reason).toBe("fresh");
    expect(
      autoCleanArtifacts(root, { now: new Date(T0_PLUS_3D.getTime() + 60_001) }),
    ).toMatchObject({ reason: "swept", deleted: 2 });
  });

  test("a slice that deletes nothing waits a full interval before retrying", () => {
    const root = makeRoot();
    const path = seedExpired(root, T0);
    const locked = join(path, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "pinned.txt"), "cannot be removed\n");
    // Windows ignores a directory's write bit, so pin the directory the way
    // Windows does refuse: it cannot remove a process's working directory.
    const pinByCwd = process.platform === "win32";
    const previousCwd = process.cwd();
    if (pinByCwd) process.chdir(locked);
    else chmodSync(locked, 0o500);
    try {
      expect(autoCleanArtifacts(root, { now: T0_PLUS_3D })).toMatchObject({
        reason: "failed",
        deleted: 0,
      });
      const stamp = JSON.parse(
        readFileSync(join(root, ".harnery/artifacts-auto-clean.json"), "utf8"),
      );
      expect(stamp.status).toBe("failed");
      expect(Date.parse(stamp.retry_after)).toBe(T0_PLUS_3D.getTime() + 60 * 60 * 1000);
      expect(
        autoCleanArtifacts(root, { now: new Date(T0_PLUS_3D.getTime() + 60_001) }).reason,
      ).toBe("fresh");
    } finally {
      if (pinByCwd) process.chdir(previousCwd);
      else chmodSync(locked, 0o700);
    }
  });

  test("a time-limited slice always makes one unit of progress", () => {
    const root = makeRoot();
    seedExpired(root, T0, "first");
    seedExpired(root, T0, "second");
    expect(autoCleanArtifacts(root, { now: T0_PLUS_3D, timeBudgetMs: 0 })).toMatchObject({
      reason: "partial",
      deleted: 1,
    });
  });

  test("throttles to once per interval", () => {
    const root = makeRoot();
    seedExpired(root, T0);
    autoCleanArtifacts(root, { now: T0_PLUS_3D });
    const second = seedExpired(root, T0, "sweep-me-too");
    const throttled = autoCleanArtifacts(root, { now: T0_PLUS_3D_PLUS_30M });
    expect(throttled).toMatchObject({ ran: false, reason: "fresh", deleted: 0 });
    expect(existsSync(second)).toBe(true);
    const later = autoCleanArtifacts(root, { now: T0_PLUS_3D_PLUS_61M });
    expect(later).toMatchObject({ ran: true, reason: "swept", deleted: 1 });
    expect(existsSync(second)).toBe(false);
  });

  test("never touches unmanaged directories", () => {
    const root = makeRoot();
    seedExpired(root, T0);
    const legacy = join(root, ".harnery", "artifacts", "legacy-dump");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "keep.txt"), "no manifest\n");
    autoCleanArtifacts(root, { now: T0_PLUS_3D });
    expect(existsSync(join(legacy, "keep.txt"))).toBe(true);
  });

  test("env kill-switch disables the sweep", () => {
    const root = makeRoot();
    const path = seedExpired(root, T0);
    setEnv("HARNERY_ARTIFACT_AUTO_CLEAN", "0");
    const result = autoCleanArtifacts(root, { now: T0_PLUS_3D });
    expect(result).toMatchObject({ ran: false, reason: "disabled" });
    expect(existsSync(path)).toBe(true);
  });

  test("config kill-switch disables the sweep", () => {
    const root = makeRoot();
    const path = seedExpired(root, T0);
    writeFileSync(
      join(root, ".harnery", "config.jsonc"),
      '{ "artifacts": { "auto_clean": false } }\n',
    );
    const result = autoCleanArtifacts(root, { now: T0_PLUS_3D });
    expect(result).toMatchObject({ ran: false, reason: "disabled" });
    expect(existsSync(path)).toBe(true);
  });

  test("reports no-root when the store does not exist", () => {
    const root = makeRoot();
    expect(autoCleanArtifacts(root, { now: T0 })).toMatchObject({ ran: false, reason: "no-root" });
  });
});
