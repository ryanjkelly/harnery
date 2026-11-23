/**
 * Pure path helpers for the scheduler. Private runtime state lives under
 * `<coordRoot>/.harnery/private/schedule/`; the job file is tracked at
 * `<coordRoot>/.harnery/schedules.jsonc`. Every helper that takes a job id or
 * gather name refuses one that is not kebab-case, so no name can leave its
 * folder.
 */

import { join, resolve } from "node:path";
import { isScheduleKebabId, scheduleClaimFileName, scheduleTimeStamp } from "./job-types.ts";

function assertId(kind: string, value: string): string {
  if (!isScheduleKebabId(value)) throw new Error(`schedule paths: bad ${kind}: ${value}`);
  return value;
}

/** The tracked job file. */
export function scheduleJobFilePath(coordRoot: string): string {
  return join(resolve(coordRoot), ".harnery", "schedules.jsonc");
}

/** `<coordRoot>/.harnery/private/schedule`. */
export function scheduleStateDir(coordRoot: string): string {
  return join(resolve(coordRoot), ".harnery", "private", "schedule");
}

/** Captured tool-call observations, one JSON object per line. */
export function scheduleObservedPath(coordRoot: string): string {
  return join(scheduleStateDir(coordRoot), "observed.jsonl");
}

export function scheduleEnrollmentsDir(coordRoot: string): string {
  return join(scheduleStateDir(coordRoot), "enrollments");
}

export function scheduleEnrollmentPath(coordRoot: string, jobId: string): string {
  return join(scheduleEnrollmentsDir(coordRoot), `${assertId("job id", jobId)}.json`);
}

export function scheduleClaimsDir(coordRoot: string, jobId: string): string {
  return join(scheduleStateDir(coordRoot), "claims", assertId("job id", jobId));
}

/** The permanent claim for one due instant. */
export function scheduleClaimPath(coordRoot: string, jobId: string, scheduledFor: string): string {
  return join(scheduleClaimsDir(coordRoot, jobId), scheduleClaimFileName(jobId, scheduledFor));
}

export function scheduleCursorPath(coordRoot: string, jobId: string): string {
  return join(scheduleStateDir(coordRoot), "cursors", `${assertId("job id", jobId)}.json`);
}

export function scheduleHeartbeatPath(coordRoot: string): string {
  return join(scheduleStateDir(coordRoot), "heartbeat.json");
}

/** Present while `schedule install` has a timer installed for this checkout. */
export function scheduleTimerInstallPath(coordRoot: string): string {
  return join(scheduleStateDir(coordRoot), "timer.json");
}

/** Every run folder of one job sits here; names sort in time order. */
export function scheduleRunsDir(coordRoot: string, jobId: string): string {
  return join(scheduleStateDir(coordRoot), "runs", assertId("job id", jobId));
}

/**
 * A run folder's name: the colon-free stamp of an instant. Pass the run's
 * `started_at`, so a retried claim gets a folder of its own.
 */
export function scheduleRunStamp(iso: string): string {
  return scheduleTimeStamp(iso);
}

export function scheduleRunDir(coordRoot: string, jobId: string, stamp: string): string {
  if (!/^\d{8}T\d{9}Z$/.test(stamp)) throw new Error(`schedule paths: bad run stamp: ${stamp}`);
  return join(scheduleRunsDir(coordRoot, jobId), stamp);
}

/** File names inside a run folder, relative to it (as the run record stores them). */
export const SCHEDULE_RUN_RECORD_FILE = "run.json";
export const SCHEDULE_RUN_REPORT_FILE = "report.md";

/** `gather/<name>.txt`, relative to the run folder. */
export function scheduleGatherOutputRelativePath(name: string): string {
  return `gather/${assertId("gather name", name)}.txt`;
}

export function scheduleRunRecordPath(runDir: string): string {
  return join(runDir, SCHEDULE_RUN_RECORD_FILE);
}

export function scheduleRunReportPath(runDir: string): string {
  return join(runDir, SCHEDULE_RUN_REPORT_FILE);
}

export function scheduleGatherOutputPath(runDir: string, name: string): string {
  return join(runDir, "gather", `${assertId("gather name", name)}.txt`);
}
