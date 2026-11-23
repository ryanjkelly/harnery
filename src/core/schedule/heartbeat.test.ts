import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJsonAtomic } from "../storage/atomic-json.ts";
import {
  nextScheduleHeartbeat,
  oneLineScheduleError,
  readScheduleHeartbeat,
  touchScheduleTimerHeartbeat,
  writeScheduleHeartbeat,
} from "./heartbeat.ts";
import { SCHEDULE_TIMER_INTERVAL_MINUTES } from "./job-types.ts";
import { scheduleTimerInstallPath } from "./paths.ts";

let root: string;
const T1 = new Date("2026-11-22T12:00:00.000Z");
const T2 = new Date("2026-11-22T12:07:00.000Z");
const T3 = new Date("2026-11-22T12:09:00.000Z");

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "harnery-schedule-heartbeat-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("heartbeat", () => {
  test("a timer tick sets the timer fields; an activity tick carries them forward", () => {
    const timer = writeScheduleHeartbeat(root, { at: T1, source: "timer", status: "ok" });
    expect(timer).toMatchObject({
      last_tick_at: T1.toISOString(),
      last_ok_at: T1.toISOString(),
      last_timer_tick_at: T1.toISOString(),
      timer_interval_minutes: SCHEDULE_TIMER_INTERVAL_MINUTES,
      source: "timer",
    });
    const activity = writeScheduleHeartbeat(root, { at: T2, source: "activity", status: "ok" });
    expect(activity).toMatchObject({
      last_tick_at: T2.toISOString(),
      source: "activity",
      last_timer_tick_at: T1.toISOString(),
      timer_interval_minutes: SCHEDULE_TIMER_INTERVAL_MINUTES,
    });
    expect(readScheduleHeartbeat(root)).toEqual(activity);
  });

  test("an activity tick with no earlier timer tick has no timer fields", () => {
    const hb = writeScheduleHeartbeat(root, { at: T1, source: "activity", status: "ok" });
    expect(hb.last_timer_tick_at).toBeUndefined();
    expect(hb.timer_interval_minutes).toBeUndefined();
  });

  test("the timer interval comes from the install record", () => {
    writePrivateJsonAtomic(scheduleTimerInstallPath(root), {
      schema_version: 1,
      installed_at: T1.toISOString(),
      interval_minutes: 15,
      unit: "harnery-schedule-x.timer",
      command: ["harn", "schedule", "tick", "--source", "timer"],
    });
    expect(
      writeScheduleHeartbeat(root, { at: T1, source: "timer", status: "ok" })
        .timer_interval_minutes,
    ).toBe(15);
  });

  test("an error keeps the last ok time and records one line", () => {
    writeScheduleHeartbeat(root, { at: T1, source: "timer", status: "ok" });
    const hb = writeScheduleHeartbeat(root, {
      at: T2,
      source: "manual",
      status: "error",
      error: "first line\nsecond line",
    });
    expect(hb).toMatchObject({
      last_tick_status: "error",
      last_tick_error: "first line second line",
      last_ok_at: T1.toISOString(),
      last_timer_tick_at: T1.toISOString(),
    });
    const ok = writeScheduleHeartbeat(root, { at: T3, source: "activity", status: "ok" });
    expect(ok.last_tick_error).toBeUndefined();
    expect(ok.last_ok_at).toBe(T3.toISOString());
  });

  test("touch updates only the timer fields, and only when a heartbeat exists", () => {
    expect(touchScheduleTimerHeartbeat(root, T1)).toBeNull();
    writeScheduleHeartbeat(root, { at: T1, source: "activity", status: "error", error: "x" });
    const touched = touchScheduleTimerHeartbeat(root, T2);
    expect(touched).toMatchObject({
      last_tick_at: T1.toISOString(),
      last_tick_status: "error",
      source: "activity",
      last_timer_tick_at: T2.toISOString(),
    });
  });

  test("nextScheduleHeartbeat is pure and caps the message", () => {
    const next = nextScheduleHeartbeat(
      null,
      { at: T1, source: "timer", status: "error", error: "y".repeat(500) },
      7,
    );
    expect(next.last_ok_at).toBeUndefined();
    expect(next.timer_interval_minutes).toBe(7);
    expect(next.last_tick_error?.length).toBe(300);
    expect(oneLineScheduleError("  ")).toBe("unknown error");
  });
});

describe("touchScheduleTimerHeartbeat with createIfMissing", () => {
  test("writes a first valid heartbeat for a timer tick that has started", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-schedule-touch-"));
    try {
      const at = new Date("2026-11-22T12:00:00.000Z");
      expect(touchScheduleTimerHeartbeat(root, at)).toBeNull();
      expect(readScheduleHeartbeat(root)).toBeNull();
      const written = touchScheduleTimerHeartbeat(root, at, { createIfMissing: true });
      expect(written).toMatchObject({
        source: "timer",
        last_tick_at: at.toISOString(),
        last_timer_tick_at: at.toISOString(),
      });
      expect(readScheduleHeartbeat(root)).toEqual(written);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
