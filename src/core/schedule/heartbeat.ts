/**
 * The scheduler's heartbeat (`heartbeat.json`): written at the end of every
 * tick and read by the session cue and doctor before any catch-up tick
 * refreshes it.
 *
 * Every write carries `last_timer_tick_at` and `timer_interval_minutes`
 * forward from the previous heartbeat, unless the tick came from the timer,
 * which sets them. So an activity or manual tick never hides a timer that
 * stopped. `last_ok_at` is carried forward by a tick that errored.
 */

import { readFileSync, statSync } from "node:fs";
import { writePrivateJsonAtomic } from "../storage/atomic-json.ts";
import {
  SCHEDULE_TIMER_INTERVAL_MINUTES,
  type ScheduleHeartbeat,
  type ScheduleTimerInstall,
  validateScheduleHeartbeat,
  validateScheduleTimerInstall,
} from "./job-types.ts";
import { scheduleHeartbeatPath, scheduleTimerInstallPath } from "./paths.ts";

export type ScheduleTickSource = ScheduleHeartbeat["source"];

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The stored heartbeat, validated; null when missing, unreadable or invalid. */
export function readScheduleHeartbeat(coordRoot: string): ScheduleHeartbeat | null {
  const value = readJson(scheduleHeartbeatPath(coordRoot));
  if (value === undefined) return null;
  const checked = validateScheduleHeartbeat(value);
  return checked.ok ? checked.value : null;
}

/** The timer install record, validated; null when no timer is installed or it is invalid. */
export function readScheduleTimerInstall(coordRoot: string): ScheduleTimerInstall | null {
  const value = readJson(scheduleTimerInstallPath(coordRoot));
  if (value === undefined) return null;
  const checked = validateScheduleTimerInstall(value);
  return checked.ok ? checked.value : null;
}

/** The interval a timer tick records: the install record's, else the default. */
export function scheduleTimerIntervalMinutes(coordRoot: string): number {
  return readScheduleTimerInstall(coordRoot)?.interval_minutes ?? SCHEDULE_TIMER_INTERVAL_MINUTES;
}

/** Collapse a message to one line of at most 300 characters. */
export function oneLineScheduleError(message: string): string {
  const line = message.replace(/\s+/g, " ").trim() || "unknown error";
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

export interface ScheduleHeartbeatUpdate {
  at: Date;
  source: ScheduleTickSource;
  status: "ok" | "error";
  /** Set when `status` is `error`; collapsed to one line. */
  error?: string;
}

/** Build the next heartbeat from the previous one. Pure. */
export function nextScheduleHeartbeat(
  previous: ScheduleHeartbeat | null,
  update: ScheduleHeartbeatUpdate,
  timerIntervalMinutes: number,
): ScheduleHeartbeat {
  const at = update.at.toISOString();
  const next: ScheduleHeartbeat = {
    schema_version: 1,
    last_tick_at: at,
    last_tick_status: update.status,
    source: update.source,
  };
  if (update.status === "error") {
    next.last_tick_error = oneLineScheduleError(update.error ?? "");
    if (previous?.last_ok_at) next.last_ok_at = previous.last_ok_at;
  } else {
    next.last_ok_at = at;
  }
  if (update.source === "timer") {
    next.last_timer_tick_at = at;
    next.timer_interval_minutes = timerIntervalMinutes;
  } else {
    if (previous?.last_timer_tick_at) next.last_timer_tick_at = previous.last_timer_tick_at;
    if (previous?.timer_interval_minutes !== undefined) {
      next.timer_interval_minutes = previous.timer_interval_minutes;
    }
  }
  return next;
}

/** Write the heartbeat for a finished tick, atomically and privately. */
export function writeScheduleHeartbeat(
  coordRoot: string,
  update: ScheduleHeartbeatUpdate,
): ScheduleHeartbeat {
  const next = nextScheduleHeartbeat(
    readScheduleHeartbeat(coordRoot),
    update,
    update.source === "timer" ? scheduleTimerIntervalMinutes(coordRoot) : 0,
  );
  const checked = validateScheduleHeartbeat(next);
  if (!checked.ok) throw new Error(`schedule heartbeat: ${checked.errors.join("; ")}`);
  writePrivateJsonAtomic(scheduleHeartbeatPath(coordRoot), checked.value);
  return checked.value;
}

/**
 * Record only that the timer is alive at `at`: update `last_timer_tick_at`
 * and `timer_interval_minutes` and keep everything else. Used by a timer tick
 * that found another tick running, and by a running timer tick while its job
 * runs, because the timer's service cannot fire again until that tick ends
 * and a long run must not look like a stopped clock.
 *
 * Without a previous heartbeat it writes nothing, unless `createIfMissing` is
 * set: then it writes a first heartbeat for a timer tick that has started,
 * which the tick replaces with its real result when it ends. Returns the
 * written heartbeat or null.
 */
export function touchScheduleTimerHeartbeat(
  coordRoot: string,
  at: Date,
  opts: { createIfMissing?: boolean } = {},
): ScheduleHeartbeat | null {
  const previous = readScheduleHeartbeat(coordRoot);
  if (!previous && !opts.createIfMissing) return null;
  const next: ScheduleHeartbeat = {
    ...(previous ?? {
      schema_version: 1,
      last_tick_at: at.toISOString(),
      last_tick_status: "ok",
      source: "timer",
    }),
    last_timer_tick_at: at.toISOString(),
    timer_interval_minutes: scheduleTimerIntervalMinutes(coordRoot),
  };
  writePrivateJsonAtomic(scheduleHeartbeatPath(coordRoot), next);
  return next;
}

/** The heartbeat file's modification time in ms, or null when it is missing. */
export function scheduleHeartbeatMtimeMs(coordRoot: string): number | null {
  try {
    return statSync(scheduleHeartbeatPath(coordRoot)).mtimeMs;
  } catch {
    return null;
  }
}
