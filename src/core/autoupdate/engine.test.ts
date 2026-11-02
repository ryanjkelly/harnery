import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AUTOUPDATE_CHILD_ENV,
  AUTOUPDATE_OFF_ENV,
  type AutoUpdateDeps,
  autoUpdateTick,
  checkForUpdate,
  GIT_HOOK_ENV,
  isHookConfigPath,
  isInstructionPath,
  parseNoticeLines,
  resolveStepCommand,
  runAutoUpdate,
  setStamp,
} from "./engine.ts";
import {
  autoUpdateLockPath,
  autoUpdateStampPath,
  mutateAutoUpdateState,
  readAutoUpdateState,
} from "./state.ts";
import { AUTOUPDATE_DEFAULTS, type AutoUpdateConfig } from "./types.ts";

const MIN = 60_000;
const posixOnly = process.platform === "win32" ? test.skip : test;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commitFile(repo: string, rel: string, body: string, message = `edit ${rel}`): string {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  git(repo, "add", rel);
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

let base: string;
let remote: string;
let work: string;
let other: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "harnery-autoupdate-engine-"));
  remote = join(base, "remote.git");
  work = join(base, "work");
  other = join(base, "other");
  git(base, "init", "--bare", "-q", remote);
  git(base, "clone", "-q", remote, work);
  git(work, "checkout", "-q", "-b", "main");
  commitFile(work, "AGENTS.md", "v1\n", "init");
  git(work, "push", "-q", "-u", "origin", "main");
  git(base, "clone", "-q", "-b", "main", remote, other);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function cfg(overrides: Partial<AutoUpdateConfig> = {}): AutoUpdateConfig {
  return {
    enabled: true,
    checkMinutes: 15,
    steps: [],
    dailySteps: [],
    watch: [],
    timeoutMinutes: 1,
    cleanup: false,
    ...overrides,
  };
}

/** The test process's env without the variables Git sets for hooks, so a tick here is not "inside a hook". */
function outsideHookEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, [AUTOUPDATE_CHILD_ENV]: "" };
  delete env[AUTOUPDATE_OFF_ENV];
  for (const name of GIT_HOOK_ENV) delete env[name];
  return env;
}

function deps(config: AutoUpdateConfig | null, extra: AutoUpdateDeps = {}): AutoUpdateDeps {
  return {
    readConfig: () => config,
    env: outsideHookEnv(),
    binName: "harn",
    ...extra,
  };
}

describe("autoUpdateTick", () => {
  test("disabled inside a run and when not configured", () => {
    expect(autoUpdateTick(work, deps(cfg(), { env: { [AUTOUPDATE_CHILD_ENV]: "1" } })).action).toBe(
      "disabled",
    );
    expect(autoUpdateTick(work, deps(null)).action).toBe("disabled");
    expect(autoUpdateTick(work, deps(cfg({ enabled: false }))).action).toBe("disabled");
  });

  test("HARNERY_AUTOUPDATE=off or 0 turns it off for the process tree", () => {
    for (const value of ["off", "0", "OFF"])
      expect(
        autoUpdateTick(work, deps(cfg(), { env: { [AUTOUPDATE_OFF_ENV]: value } })).action,
      ).toBe("disabled");
  });

  test("disabled outside a Git checkout, such as a hook's exported snapshot", () => {
    const snapshot = join(base, "snapshot");
    mkdirSync(snapshot, { recursive: true });
    expect(autoUpdateTick(snapshot, deps(cfg()))).toEqual({
      action: "disabled",
      detail: "not a Git checkout",
    });
  });

  test("disabled inside a Git hook, so a commit never starts a pull", () => {
    for (const name of GIT_HOOK_ENV) {
      const result = autoUpdateTick(work, deps(cfg(), { env: { [name]: "/repo/.git/x" } }));
      expect(result).toEqual({ action: "disabled", detail: "inside a Git hook" });
    }
  });

  test("claims the stamp before launching, then throttles", () => {
    const now = Date.now();
    let stampAtSpawn: number | null = null;
    const d = deps(cfg(), {
      now: () => now,
      spawnRunner: () => {
        stampAtSpawn = statSync(autoUpdateStampPath(work)).mtimeMs;
      },
    });
    expect(autoUpdateTick(work, d).action).toBe("launched");
    expect(stampAtSpawn).not.toBeNull();
    expect(Math.abs((stampAtSpawn ?? 0) - now)).toBeLessThan(1000);
    expect(autoUpdateTick(work, d).action).toBe("throttled");
    const later = deps(cfg(), { now: () => now + 16 * MIN, spawnRunner: () => {} });
    expect(autoUpdateTick(work, later).action).toBe("launched");
  });

  test("an old stamp launches; a stamp within checkMinutes throttles", () => {
    setStamp(work, Date.now());
    const path = autoUpdateStampPath(work);
    const old = (Date.now() - 20 * MIN) / 1000;
    utimesSync(path, old, old);
    let spawned = 0;
    expect(autoUpdateTick(work, deps(cfg(), { spawnRunner: () => spawned++ })).action).toBe(
      "launched",
    );
    expect(spawned).toBe(1);
  });

  test("a fresh lock reports locked; a stale one launches", () => {
    const lock = autoUpdateLockPath(work);
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: 1, at: new Date().toISOString() }),
    );
    expect(autoUpdateTick(work, deps(cfg(), { spawnRunner: () => {} })).action).toBe("locked");
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: 1, at: new Date(Date.now() - 60 * MIN).toISOString() }),
    );
    rmSync(autoUpdateStampPath(work), { force: true });
    expect(autoUpdateTick(work, deps(cfg(), { spawnRunner: () => {} })).action).toBe("launched");
  });

  test("never throws", () => {
    const d = deps(cfg(), {
      spawnRunner: () => {
        throw new Error("boom");
      },
    });
    expect(autoUpdateTick(work, d)).toEqual({ action: "error", detail: "boom" });
  });
});

describe("checkForUpdate and runAutoUpdate", () => {
  test("first run converges, then reports current", async () => {
    const config = cfg();
    const first = await runAutoUpdate(work, { deps: deps(config) });
    expect(first.decision?.reason).toBe("drift");
    expect(first.outcome).toBe("updated");
    const state = readAutoUpdateState(work);
    expect(state.converged?.head).toBe(git(work, "rev-parse", "HEAD"));
    expect(checkForUpdate(work, config, state, deps(config)).reason).toBe("current");
  });

  test("behind: pulls via steps and emits instruction and hook notices", async () => {
    const config = cfg({ steps: [["git", "pull", "-q", "--ff-only"]] });
    await runAutoUpdate(work, { deps: deps(config) });
    const from = git(work, "rev-parse", "HEAD");
    commitFile(other, "AGENTS.md", "v2\n");
    const to = commitFile(other, ".codex/hooks.json", "{}\n");
    git(other, "push", "-q");
    const decision = checkForUpdate(work, config, readAutoUpdateState(work), deps(config));
    expect(decision.reason).toBe("behind");
    expect(decision.remoteSha).toBe(to);
    const result = await runAutoUpdate(work, { deps: deps(config) });
    expect(result.outcome).toBe("updated");
    expect(result.record?.fromHead).toBe(from);
    expect(result.record?.toHead).toBe(to);
    expect(result.notices.map((n) => n.kind).sort()).toEqual(["hooks", "instructions"]);
    expect(result.notices.find((n) => n.kind === "instructions")?.text).toContain(
      `${from.slice(0, 7)}→${to.slice(0, 7)}`,
    );
    const state = readAutoUpdateState(work);
    expect(state.converged?.remoteSha).toBe(to);
    expect(checkForUpdate(work, config, state, deps(config)).reason).toBe("current");
  });

  test("offline leaves converged untouched", async () => {
    const config = cfg();
    await runAutoUpdate(work, { deps: deps(config) });
    const before = readAutoUpdateState(work).converged;
    git(work, "remote", "set-url", "origin", join(base, "does-not-exist.git"));
    const result = await runAutoUpdate(work, { deps: deps(config) });
    expect(result.outcome).toBe("offline");
    const after = readAutoUpdateState(work);
    expect(after.converged).toEqual(before);
    expect(after.lastRun?.outcome).toBe("offline");
  });

  test("no upstream: drift until converged, then no-upstream", async () => {
    git(work, "checkout", "-q", "--detach");
    const config = cfg();
    expect(checkForUpdate(work, config, readAutoUpdateState(work), deps(config)).reason).toBe(
      "drift",
    );
    await runAutoUpdate(work, { deps: deps(config) });
    expect(checkForUpdate(work, config, readAutoUpdateState(work), deps(config)).reason).toBe(
      "no-upstream",
    );
  });

  test("a watched file change is drift", async () => {
    writeFileSync(join(base, "tool"), "1");
    const config = cfg({ watch: [join(base, "tool")] });
    await runAutoUpdate(work, { deps: deps(config) });
    expect(checkForUpdate(work, config, readAutoUpdateState(work), deps(config)).reason).toBe(
      "current",
    );
    utimesSync(join(base, "tool"), 5_000, 5_000);
    expect(checkForUpdate(work, config, readAutoUpdateState(work), deps(config)).reason).toBe(
      "drift",
    );
  });

  test("daily steps run once per day when current", async () => {
    let calls = 0;
    const config = cfg({ dailySteps: [["doctor"]] });
    const d = deps(config, {
      runStep: async () => {
        calls += 1;
        return { exitCode: 0, timedOut: false, output: "", ms: 1 };
      },
    });
    await runAutoUpdate(work, { deps: d }); // drift run also runs the due daily step
    expect(calls).toBe(1);
    const state = readAutoUpdateState(work);
    expect(checkForUpdate(work, config, state, d).reason).toBe("current");
    mutateAutoUpdateState(work, (s) => {
      s.dailyAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    });
    const decision = checkForUpdate(work, config, readAutoUpdateState(work), d);
    expect(decision).toMatchObject({ reason: "daily", dailyOnly: true });
    const result = await runAutoUpdate(work, { deps: d });
    expect(result.outcome).toBe("current");
    expect(calls).toBe(2);
  });

  posixOnly("exit 75 is blocked and its notices go to a person", async () => {
    const config = cfg({ steps: [["sh", "-c", "echo harnery-notice: hi; exit 75"], ["false"]] });
    const result = await runAutoUpdate(work, { force: true, deps: deps(config) });
    expect(result.outcome).toBe("blocked");
    expect(result.record?.steps).toHaveLength(1);
    expect(result.notices).toEqual([expect.objectContaining({ kind: "person", text: "hi" })]);
  });

  posixOnly("a failure records a notice and pushes the stamp into the future", async () => {
    const now = Date.now();
    const config = cfg({ steps: [["sh", "-c", "exit 3"]] });
    const d = deps(config, { now: () => now, spawnRunner: () => {} });
    const result = await runAutoUpdate(work, { force: true, deps: d });
    expect(result.outcome).toBe("failed");
    const failure = result.notices.find((n) => n.kind === "failure");
    expect(failure?.text).toContain("`sh -c exit 3` failed (exit 3)");
    expect(failure?.text).toContain("harn autoupdate run");
    const expected = now + (AUTOUPDATE_DEFAULTS.failureBackoffMinutes - config.checkMinutes) * MIN;
    expect(Math.abs(statSync(autoUpdateStampPath(work)).mtimeMs - expected)).toBeLessThan(1000);
    const at = (offset: number) => deps(config, { now: () => now + offset, spawnRunner: () => {} });
    expect(autoUpdateTick(work, at(30 * MIN)).action).toBe("throttled");
    expect(autoUpdateTick(work, at(61 * MIN)).action).toBe("launched");
  });

  posixOnly("a later successful run clears earlier failure notices", async () => {
    const now = Date.now();
    const failing = deps(cfg({ steps: [["sh", "-c", "exit 3"]] }), {
      now: () => now,
      spawnRunner: () => {},
    });
    await runAutoUpdate(work, { force: true, deps: failing });
    expect(readAutoUpdateState(work).notices.some((n) => n.kind === "failure")).toBe(true);
    const passing = deps(cfg({ steps: [["sh", "-c", "exit 0"]] }), {
      now: () => now + 61 * MIN,
      spawnRunner: () => {},
    });
    const result = await runAutoUpdate(work, { force: true, deps: passing });
    expect(result.outcome).not.toBe("failed");
    expect(readAutoUpdateState(work).notices.some((n) => n.kind === "failure")).toBe(false);
  });

  test("a held lock skips the run", async () => {
    const lock = autoUpdateLockPath(work);
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: 42, at: new Date().toISOString() }),
    );
    const result = await runAutoUpdate(work, { deps: deps(cfg()) });
    expect(result.outcome).toBe("skipped-locked");
    expect(result.lockOwner?.pid).toBe(42);
  });
});

describe("helpers", () => {
  test("classifies instruction and hook paths", () => {
    for (const p of [
      "AGENTS.md",
      "pkg/CLAUDE.md",
      ".cursor/rules/x.mdc",
      ".agents/skills/a/SKILL.md",
    ]) {
      expect(isInstructionPath(p)).toBe(true);
    }
    expect(isInstructionPath("src/index.ts")).toBe(false);
    expect(isHookConfigPath(".codex/hooks.json")).toBe(true);
    expect(isHookConfigPath("docs/hooks.json")).toBe(false);
  });

  test("parses notice lines", () => {
    expect(
      parseNoticeLines("a\n  harnery-notice: one\r\nharnery-notice:\nharnery-notice: two"),
    ).toEqual(["one", "two"]);
  });
});

describe("resolveStepCommand", () => {
  const env = {
    Path: "C:\\tools;C:\\npm",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
  };
  test("non-Windows argv is unchanged", () => {
    expect(resolveStepCommand("bun", ["x.ts"], env, "linux")).toEqual({
      cmd: "bun",
      args: ["x.ts"],
      verbatim: false,
    });
  });
  test("an .exe on PATH runs directly", () => {
    const r = resolveStepCommand(
      "git",
      ["pull"],
      env,
      "win32",
      (p) => p === "C:\\tools/git.exe" || p === "C:\\tools\\git.exe",
    );
    expect(r.cmd.toLowerCase()).toContain("git.exe");
    expect(r.args).toEqual(["pull"]);
  });
  test("a .cmd shim runs through cmd.exe with quoting", () => {
    const r = resolveStepCommand("bun", ["scripts/pull.ts", "a b"], env, "win32", (p) =>
      /npm.bun\.cmd$/i.test(p),
    );
    expect(r.cmd).toBe(env.ComSpec);
    expect(r.verbatim).toBe(true);
    expect(r.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(r.args[3]).toContain('scripts/pull.ts "a b"');
  });
  test("paths and names with extensions are left alone on Windows", () => {
    expect(resolveStepCommand("bin/git-pull-all", [], env, "win32").cmd).toBe("bin/git-pull-all");
    expect(resolveStepCommand("tool.exe", [], env, "win32").cmd).toBe("tool.exe");
  });
});
