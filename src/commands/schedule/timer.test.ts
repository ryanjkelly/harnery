import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { EmitContext } from "../../commander.ts";
import { scheduleTimerInstallPath } from "../../core/schedule/paths.ts";
import type { ScheduleCommandRunner } from "../../core/schedule/types.ts";
import { registerScheduleTimerCommands, type ScheduleTimerDeps } from "./timer.ts";

interface Captured {
  emit: EmitContext;
  texts: string[];
  data: unknown[];
  errors: unknown[];
  exitCode: number;
}

function capture(): Captured {
  const c: Captured = {
    texts: [],
    data: [],
    errors: [],
    exitCode: 0,
    emit: {} as EmitContext,
  };
  c.emit = {
    config() {},
    data: (p) => c.data.push(p),
    rows: (r) => c.data.push(r),
    text: (s) => c.texts.push(s),
    file() {},
    error: (e) => c.errors.push(e),
    log() {},
    setExitCode: (n) => {
      c.exitCode = n;
    },
  };
  return c;
}

let base: string;
let coordRoot: string;
let unitDir: string;
let calls: string[][];

const runner: ScheduleCommandRunner = async (argv) => {
  calls.push([...argv]);
  if (argv[2] === "is-system-running") return { exitCode: 0, stdout: "running\n", stderr: "" };
  if (argv[0] === "loginctl") return { exitCode: 0, stdout: "no\n", stderr: "" };
  return { exitCode: 0, stdout: "", stderr: "" };
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "harnery-timer-cmd-")));
  coordRoot = join(base, "my checkout");
  mkdirSync(coordRoot);
  unitDir = join(base, "units");
  calls = [];
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function deps(extra: Partial<ScheduleTimerDeps> = {}): ScheduleTimerDeps {
  return {
    coordRoot,
    unitDir,
    runner,
    env: { PATH: "/usr/bin:/bin", USER: "tester" },
    platform: "linux",
    isWsl: false,
    entry: { execPath: "/opt/rt/node", script: "/opt/tool/cli.js" },
    ...extra,
  };
}

async function run(args: string[], c: Captured, d: ScheduleTimerDeps = deps()): Promise<void> {
  const schedule = new Command("schedule").exitOverride();
  registerScheduleTimerCommands(schedule, c.emit, d);
  await schedule.parseAsync(args, { from: "user" });
}

describe("schedule timer commands", () => {
  test("install prints units, the command, the PATH and the lingering note", async () => {
    const c = capture();
    await run(["install"], c);
    expect(c.errors).toEqual([]);
    const out = c.texts.join("");
    expect(out).toMatch(/harnery-schedule-[0-9a-f]{12}\.timer/);
    expect(out).toContain("/opt/tool/cli.js");
    expect(out).toContain(`'${coordRoot}'`);
    expect(out).toContain("  /usr/bin\n  /bin");
    expect(out).toContain("loginctl enable-linger tester");
    expect(existsSync(scheduleTimerInstallPath(coordRoot))).toBe(true);
  });

  test("install --json and --interval-minutes", async () => {
    const c = capture();
    await run(["install", "--interval-minutes", "15", "--json"], c);
    const result = c.data[0] as { interval_minutes: number; on_calendar: string };
    expect(result.interval_minutes).toBe(15);
    expect(result.on_calendar).toBe("*:0/15");
  });

  test("install refuses a bad interval with an error code", async () => {
    const c = capture();
    await run(["install", "--interval-minutes", "7"], c);
    expect(c.exitCode).toBe(1);
    expect((c.errors[0] as { code: string }).code).toBe("bad_timer_interval");
    expect(calls).toEqual([]);
  });

  test("install refuses on macOS", async () => {
    const c = capture();
    await run(["install"], c, deps({ platform: "darwin" }));
    expect((c.errors[0] as { code: string }).code).toBe("timer_platform_unsupported");
  });

  test("timer-status is read-only and uninstall removes the timer", async () => {
    await run(["install"], capture());
    calls = [];
    const status = capture();
    await run(["timer-status", "--json"], status);
    expect((status.data[0] as { timer_file: boolean }).timer_file).toBe(true);
    expect(calls.every((c) => c[2] === "is-enabled" || c[2] === "is-active")).toBe(true);

    const removed = capture();
    await run(["uninstall"], removed);
    expect(removed.texts.join("")).toContain("Removed the schedule timer");
    expect(existsSync(scheduleTimerInstallPath(coordRoot))).toBe(false);

    const again = capture();
    await run(["uninstall"], again);
    expect(again.texts.join("")).toContain("No schedule timer is installed");
  });
});
