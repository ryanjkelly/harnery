import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { runScheduleGather, SCHEDULE_BASE_ENV_NAMES, scheduleGatherEnv } from "./gather.ts";
import type { ScheduleGatherCommand } from "./job-types.ts";

const RUNTIME = process.execPath;

let root: string;
let runDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "schedule-gather-"));
  runDir = join(root, "run");
});

afterEach(() => removeDir(root));

const script = (name: string, source: string, extra: Partial<ScheduleGatherCommand> = {}) => ({
  name,
  argv: [RUNTIME, "-e", source],
  ...extra,
});

const parentEnv = (): Record<string, string | undefined> => ({
  ...process.env,
  GATHER_TEST_LISTED: "listed",
  GATHER_TEST_SECRET: "secret",
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("scheduleGatherEnv", () => {
  test("copies the base names and listed names only, and marks the child", () => {
    const env = scheduleGatherEnv(
      { env: ["GATHER_TEST_LISTED"] },
      { PATH: "/bin", HOME: "/h", GATHER_TEST_LISTED: "x", GATHER_TEST_SECRET: "y" },
      "linux",
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      GATHER_TEST_LISTED: "x",
      HARNERY_SCHEDULE_CHILD: "1",
    });
    expect(SCHEDULE_BASE_ENV_NAMES).toContain("SystemRoot");
  });

  test("matches names without case on Windows", () => {
    const env = scheduleGatherEnv({}, { Path: "C:\\bin" }, "win32");
    expect(env.PATH).toBe("C:\\bin");
  });
});

describe("runScheduleGather", () => {
  test("ok, finding and error by exit code, with output in arrival order", async () => {
    const results = await runScheduleGather({
      commands: [
        script(
          "clean",
          "process.stdout.write('one\\n'); setTimeout(() => process.stderr.write('two\\n'), 150); setTimeout(() => process.stdout.write('three\\n'), 300)",
        ),
        script("found", "process.exit(3)", { finding_exit_codes: [3] }),
        script("broken", "process.exit(4)", { finding_exit_codes: [3] }),
      ],
      coordRoot: root,
      runDir,
      deadlineAtMs: Date.now() + 30_000,
      env: parentEnv(),
    });
    expect(results.map((r) => [r.name, r.state, r.exit_code, r.error ?? null])).toEqual([
      ["clean", "ok", 0, null],
      ["found", "finding", 3, null],
      ["broken", "error", 4, "unexpected exit code 4"],
    ]);
    expect(results[0]?.output_file).toBe("gather/clean.txt");
    const text = readFileSync(join(runDir, "gather", "clean.txt"), "utf8");
    expect(text).toBe("one\ntwo\nthree\n");
    if (process.platform !== "win32") {
      expect(statSync(join(runDir, "gather", "clean.txt")).mode & 0o077).toBe(0);
    }
  }, 30_000);

  test("runs from the checkout root with only base and listed variables", async () => {
    await runScheduleGather({
      commands: [
        script("env", "console.log(JSON.stringify({ cwd: process.cwd(), env: process.env }))", {
          env: ["GATHER_TEST_LISTED"],
        }),
      ],
      coordRoot: root,
      runDir,
      deadlineAtMs: Date.now() + 30_000,
      env: parentEnv(),
    });
    const seen = JSON.parse(readFileSync(join(runDir, "gather", "env.txt"), "utf8")) as {
      cwd: string;
      env: Record<string, string>;
    };
    expect(seen.env.GATHER_TEST_LISTED).toBe("listed");
    expect(seen.env.GATHER_TEST_SECRET).toBeUndefined();
    expect(seen.env.HARNERY_SCHEDULE_CHILD).toBe("1");
    const allowed = new Set([
      ...SCHEDULE_BASE_ENV_NAMES,
      "GATHER_TEST_LISTED",
      "HARNERY_SCHEDULE_CHILD",
      // On Windows the child process fills these session values in itself
      // from the logged-on user, even from an environment that omits them.
      ...(process.platform === "win32"
        ? [
            "HOMEDRIVE",
            "HOMEPATH",
            "LOGONSERVER",
            "SYSTEMDRIVE",
            "USERDOMAIN",
            "USERNAME",
            "WINDIR",
          ]
        : []),
    ]);
    // A runtime may add a few of its own (for example Bun's underscore); none from the parent.
    for (const name of Object.keys(seen.env)) {
      if (!allowed.has(name)) expect(process.env[name] === seen.env[name]).toBe(false);
    }
    const { realpathSync } = await import("node:fs");
    expect(realpathSync(seen.cwd)).toBe(realpathSync(root));
  }, 30_000);

  test("does not use a shell", async () => {
    const results = await runScheduleGather({
      commands: [{ name: "echo", argv: ["echo", "$HOME", "&&", "x"] }],
      coordRoot: root,
      runDir,
      deadlineAtMs: Date.now() + 30_000,
      env: parentEnv(),
      platform: process.platform,
    });
    if (process.platform === "win32") return;
    expect(results[0]?.state).toBe("ok");
    expect(readFileSync(join(runDir, "gather", "echo.txt"), "utf8")).toBe("$HOME && x\n");
  }, 30_000);

  test("spawns the argv directly, hidden, with no shell", async () => {
    const seen: { file: string; args: readonly string[]; opts: SpawnOptions }[] = [];
    const spy = ((file: string, args: readonly string[], opts: SpawnOptions) => {
      seen.push({ file, args, opts });
      return nodeSpawn(file, args, opts);
    }) as typeof nodeSpawn;
    await runScheduleGather({
      commands: [script("spy", "process.exit(0)")],
      coordRoot: root,
      runDir,
      deadlineAtMs: Date.now() + 30_000,
      env: parentEnv(),
      spawn: spy,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.args).toEqual(["-e", "process.exit(0)"]);
    expect(seen[0]?.opts).toMatchObject({ windowsHide: true, shell: false });
    if (process.platform !== "win32") expect(seen[0]?.opts.detached).toBe(true);
  }, 30_000);

  test("a missing executable could not start", async () => {
    const results = await runScheduleGather({
      commands: [{ name: "missing", argv: ["harnery-no-such-program-xyz"] }],
      coordRoot: root,
      runDir,
      deadlineAtMs: Date.now() + 30_000,
      env: parentEnv(),
    });
    expect(results[0]?.state).toBe("error");
    expect(results[0]?.exit_code).toBeNull();
    expect(results[0]?.error).toBe("could not start: ENOENT");
  });

  test("output past the cap is dropped, the process finishes, and the result is an error", async () => {
    const results = await runScheduleGather({
      commands: [
        script(
          "loud",
          "process.stdout.write('x'.repeat(5000)); setTimeout(() => process.exit(0), 50)",
        ),
      ],
      coordRoot: root,
      runDir,
      deadlineAtMs: Date.now() + 30_000,
      env: parentEnv(),
      outputCapBytes: 1000,
    });
    expect(results[0]).toMatchObject({ state: "error", exit_code: 0, truncated: true });
    expect(results[0]?.error).toContain("truncated");
    expect(readFileSync(join(runDir, "gather", "loud.txt")).length).toBe(1000);
  }, 30_000);

  test("a truncated finding is still an error", async () => {
    const results = await runScheduleGather({
      commands: [
        script("loud", "process.stdout.write('x'.repeat(5000), () => process.exit(2))", {
          finding_exit_codes: [2],
        }),
      ],
      coordRoot: root,
      runDir,
      deadlineAtMs: Date.now() + 30_000,
      env: parentEnv(),
      outputCapBytes: 100,
    });
    expect(results[0]?.state).toBe("error");
  }, 30_000);

  test.skipIf(process.platform === "win32")(
    "the deadline kills the whole group and later commands never start",
    async () => {
      const pidFile = join(root, "grandchild.pid");
      const t0 = Date.now();
      const results = await runScheduleGather({
        commands: [
          script(
            "slow",
            [
              `const { spawn } = require("node:child_process");`,
              `const c = spawn("sh", ["-c", "trap '' TERM; echo $$ > ${pidFile}; exec sleep 60"], { stdio: "inherit" });`,
              `setInterval(() => {}, 1000);`,
            ].join("\n"),
          ),
          script("later", "console.log('should not run')"),
        ],
        coordRoot: root,
        runDir,
        deadlineAtMs: Date.now() + 1_500,
        env: parentEnv(),
      });
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(results[0]?.state).toBe("error");
      expect(results[0]?.error).toContain("timed out");
      expect(results[1]).toMatchObject({
        name: "later",
        state: "error",
        exit_code: null,
        duration_ms: 0,
        error: "deadline passed before start",
      });
      expect(readFileSync(join(runDir, "gather", "later.txt"), "utf8")).toBe("");
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      const until = Date.now() + 3_000;
      while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      expect(alive(pid)).toBe(false);
    },
    20_000,
  );

  test("a passed deadline runs nothing", async () => {
    const results = await runScheduleGather({
      commands: [script("a", "process.exit(0)"), script("b", "process.exit(0)")],
      coordRoot: root,
      runDir,
      deadlineAtMs: Date.now() - 1,
      env: parentEnv(),
    });
    expect(results.map((r) => r.error)).toEqual([
      "deadline passed before start",
      "deadline passed before start",
    ]);
  });
});
