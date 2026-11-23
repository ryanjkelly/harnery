import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { EmitContext } from "../../commander.ts";
import { readScheduleHeartbeat } from "../../core/schedule/heartbeat.ts";
import { scheduleJobFilePath } from "../../core/schedule/paths.ts";
import type { ScheduleTickResult } from "../../core/schedule/tick.ts";
import { registerScheduleTickCommands } from "./tick.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "harnery-schedule-tick-cmd-")));
  mkdirSync(join(root, ".harnery"), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function captureEmit() {
  const out = {
    data: [] as unknown[],
    errors: [] as unknown[],
    exitCode: undefined as number | undefined,
  };
  const emit: EmitContext = {
    config: () => {},
    data: (payload) => out.data.push(payload),
    rows: () => {},
    text: () => {},
    file: () => {},
    error: (err) => out.errors.push(err),
    log: () => {},
    setExitCode: (n) => {
      out.exitCode = n;
    },
  };
  return { emit, out };
}

async function run(args: string[]) {
  const { emit, out } = captureEmit();
  const schedule = new Command("schedule").exitOverride();
  registerScheduleTickCommands(schedule, emit, {
    tickOptions: {
      machine: "box",
      env: {},
      launcher: async () => Promise.reject(new Error("unused")),
    },
  });
  await schedule.parseAsync(args, { from: "user" });
  return out;
}

describe("schedule tick", () => {
  test("runs a tick for --root and emits its result", async () => {
    const out = await run(["tick", "--source", "timer", "--root", root]);
    const result = out.data[0] as ScheduleTickResult;
    expect(result).toMatchObject({ status: "ok", source: "timer", jobs: [] });
    expect(out.exitCode).toBe(0);
    expect(readScheduleHeartbeat(root)?.source).toBe("timer");
  });

  test("defaults the source to manual", async () => {
    const out = await run(["tick", "--root", root]);
    expect((out.data[0] as ScheduleTickResult).source).toBe("manual");
  });

  test("exits non-zero when the tick errors", async () => {
    writeFileSync(scheduleJobFilePath(root), "{ broken");
    const out = await run(["tick", "--root", root]);
    expect((out.data[0] as ScheduleTickResult).status).toBe("error");
    expect(out.exitCode).toBe(1);
  });

  test("refuses an unknown source", async () => {
    const out = await run(["tick", "--source", "cron", "--root", root]);
    expect(out.data).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(out.exitCode).toBe(2);
  });
});
