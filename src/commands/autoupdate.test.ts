import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import type { EmitContext } from "../commander.ts";
import { autoUpdateLockPath } from "../core/autoupdate/state.ts";
import type { AutoUpdateConfig } from "../core/autoupdate/types.ts";
import { exitCodeForOutcome, registerAutoUpdateCommand } from "./autoupdate.ts";

let base: string;
let work: string;

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "harnery-autoupdate-cmd-"));
  const remote = join(base, "remote.git");
  work = join(base, "work");
  git(base, "init", "--bare", "-q", remote);
  git(base, "clone", "-q", remote, work);
  git(work, "checkout", "-q", "-b", "main");
  writeFileSync(join(work, "README.md"), "x\n");
  git(work, "add", "README.md");
  git(work, "commit", "-q", "-m", "init");
  git(work, "push", "-q", "-u", "origin", "main");
});
afterEach(() => {
  removeDir(base);
});

function capture() {
  const text: string[] = [];
  const data: unknown[] = [];
  const errors: unknown[] = [];
  let code = 0;
  const emit: EmitContext = {
    config() {},
    data: (payload) => data.push(payload),
    rows() {},
    text: (s) => text.push(s),
    file() {},
    error: (err) => {
      errors.push(err);
      code = code || 1;
    },
    log: (msg) => text.push(msg),
    setExitCode: (n) => {
      code = n;
    },
  };
  return { emit, text, data, errors, exitCode: () => code };
}

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

async function runCli(argv: string[], config: AutoUpdateConfig | null) {
  const out = capture();
  const program = new Command().exitOverride();
  registerAutoUpdateCommand(program, out.emit, "acme", {
    root: () => work,
    deps: { readConfig: () => config, binName: "acme" },
  });
  await program.parseAsync(["node", "acme", "autoupdate", ...argv]);
  return out;
}

describe("autoupdate command", () => {
  test("status --json reports config and the first-run state", async () => {
    const out = await runCli(["status", "--json"], cfg());
    expect(out.data[0]).toMatchObject({ enabled: true, lastRun: null, nextCheckMs: 0, lock: null });
  });

  test("status text ends with a newline", async () => {
    const out = await runCli(["status"], cfg({ steps: [["make", "setup"]] }));
    const text = out.text.join("");
    expect(text).toContain("Steps: make setup");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("check decides without running steps", async () => {
    let ran = false;
    const out = capture();
    const program = new Command().exitOverride();
    registerAutoUpdateCommand(program, out.emit, "acme", {
      root: () => work,
      deps: {
        readConfig: () => cfg({ steps: [["x"]] }),
        runStep: async () => {
          ran = true;
          return { exitCode: 0, timedOut: false, output: "", ms: 0 };
        },
      },
    });
    await program.parseAsync(["node", "acme", "autoupdate", "check", "--json"]);
    expect(out.data[0]).toMatchObject({ needed: true, reason: "drift" });
    expect(ran).toBe(false);
  });

  test("run --json converges and exits 0; a held lock is skipped with exit 0", async () => {
    const out = await runCli(["run", "--json"], cfg());
    expect(out.data[0]).toMatchObject({ outcome: "updated" });
    expect(out.exitCode()).toBe(0);
    const again = await runCli(["run"], cfg());
    expect(again.text.join("")).toContain("Auto-update current (current)");
    const lock = autoUpdateLockPath(work);
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: 7, at: new Date().toISOString() }),
    );
    const locked = await runCli(["run"], cfg());
    expect(locked.text.join("")).toContain("pid 7");
    expect(locked.exitCode()).toBe(0);
  });

  test("maps outcomes to exit codes", () => {
    expect(exitCodeForOutcome("failed")).toBe(1);
    expect(exitCodeForOutcome("blocked")).toBe(75);
    expect(exitCodeForOutcome("updated")).toBe(0);
    expect(exitCodeForOutcome("skipped-locked")).toBe(0);
  });
});
