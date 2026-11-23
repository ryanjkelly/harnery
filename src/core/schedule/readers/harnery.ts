/**
 * Reader for Harnery's own scheduler: one record per job in the tracked job
 * file (`.harnery/schedules.jsonc`). It reads the job file, this checkout's
 * enrollments and the run records under `.harnery/private/schedule/`. It
 * never puts a job's prompt or gather arguments in a record.
 */

import { join } from "node:path";
import { checkScheduleEnrollment, type ScheduleEnrollmentCheck } from "../enrollment.ts";
import {
  isScheduleJobEnabled,
  type ScheduleJob,
  type ScheduleJobTrigger,
  type ScheduleRunRecord,
  type ScheduleRunResult,
} from "../job-types.ts";
import { loadScheduleJobFile, resolveScheduleJob } from "../jobs.ts";
import { scheduleRunDir, scheduleRunStamp } from "../paths.ts";
import { listScheduleRuns } from "../report.ts";
import { scheduleNextDueTime } from "../triggers.ts";
import type {
  ScheduleCoverageState,
  ScheduleReadContext,
  ScheduleReader,
  ScheduleReadResult,
  ScheduleRecord,
  ScheduleRunStatus,
  ScheduleTrigger,
} from "../types.ts";

/** The record trigger for a job trigger; `raw` is the job file's own trigger object. */
export function harneryScheduleTrigger(trigger: ScheduleJobTrigger, zone: string): ScheduleTrigger {
  const raw = JSON.stringify(trigger);
  switch (trigger.type) {
    case "once":
      return { kind: "once", at: trigger.at, raw };
    case "every":
      return { kind: "interval", everyMs: trigger.minutes * 60_000, raw };
    case "cron":
      return { kind: "cron", expr: trigger.expr, zone, raw };
  }
}

const RUN_STATUS: Record<ScheduleRunResult, ScheduleRunStatus> = {
  ok: "succeeded",
  attention: "attention",
  failed: "failed",
};

/** A run's result as a record status. */
export function harneryRunStatus(result: ScheduleRunResult): ScheduleRunStatus {
  return RUN_STATUS[result] ?? "unknown";
}

/** The absolute path of a run's report file. */
export function harneryRunReportPath(coordRoot: string, run: ScheduleRunRecord): string {
  return join(
    scheduleRunDir(coordRoot, run.job_id, scheduleRunStamp(run.started_at)),
    run.report_file,
  );
}

/** What `schedule show` adds for a Harnery job: its enrollment here and its newest run. */
export interface HarneryJobStatus {
  enrollment: ScheduleEnrollmentCheck;
  latestRun: ScheduleRunRecord | null;
  /** Absolute path of the newest run's report, or null when the job has not run. */
  latestReportPath: string | null;
}

/** The enrollment check and newest run of one job on this machine and checkout. */
export function harneryJobStatus(
  ctx: Pick<ScheduleReadContext, "coordRoot" | "env" | "machine">,
  job: ScheduleJob,
): HarneryJobStatus {
  const resolved = resolveScheduleJob(job, { coordRoot: ctx.coordRoot, env: ctx.env });
  const enrollment = checkScheduleEnrollment({
    coordRoot: ctx.coordRoot,
    job,
    resolved,
    machine: ctx.machine,
  });
  const latestRun = listScheduleRuns(ctx.coordRoot, job.id)[0] ?? null;
  return {
    enrollment,
    latestRun,
    latestReportPath: latestRun ? harneryRunReportPath(ctx.coordRoot, latestRun) : null,
  };
}

function jobRecord(ctx: ScheduleReadContext, job: ScheduleJob): ScheduleRecord {
  const resolved = resolveScheduleJob(job, { coordRoot: ctx.coordRoot, env: ctx.env });
  const local = job.host === ctx.machine;
  const check = checkScheduleEnrollment({
    coordRoot: ctx.coordRoot,
    job,
    resolved,
    machine: ctx.machine,
  });
  const jobEnabled = isScheduleJobEnabled(job);
  // A job for another machine cannot be enrolled here; whether it runs there is unknown.
  const enabled = !jobEnabled ? false : local ? check.state === "enrolled" : null;
  let nextRunAt: string | null = null;
  if (enabled === true && check.state === "enrolled") {
    const next = scheduleNextDueTime(job.trigger, {
      zone: resolved.zone,
      enrolledAtMs: Date.parse(check.enrollment.enrolled_at),
      afterMs: ctx.now(),
    });
    nextRunAt = next === null ? null : new Date(next).toISOString();
  }
  const latest = listScheduleRuns(ctx.coordRoot, job.id)[0];
  return {
    source: "harnery",
    account: ctx.machine,
    id: job.id,
    title: job.title,
    trigger: harneryScheduleTrigger(job.trigger, resolved.zone),
    runs_on: { host: job.host },
    enabled,
    next_run_at: nextRunAt,
    last_run: latest ? { at: latest.finished_at, status: harneryRunStatus(latest.result) } : null,
    created_by: null,
  };
}

export const harneryScheduleReader: ScheduleReader = {
  id: "harnery",
  requiresOptIn: false,
  async read(ctx: ScheduleReadContext): Promise<ScheduleReadResult> {
    const readAt = new Date(ctx.now()).toISOString();
    const answer = (
      state: ScheduleCoverageState,
      records: ScheduleRecord[],
      detail?: string,
    ): ScheduleReadResult => ({
      coverage: {
        source: "harnery",
        account: ctx.machine,
        state,
        ...(detail === undefined ? {} : { detail }),
        read_at: readAt,
      },
      records,
    });
    try {
      const loaded = loadScheduleJobFile(ctx.coordRoot);
      if (!loaded.ok) {
        if (loaded.reason === "missing") return answer("current", []);
        return answer(
          "unreadable",
          [],
          `The job file is not valid: ${loaded.errors[0] ?? "unknown error"}.`,
        );
      }
      return answer(
        "current",
        loaded.file.jobs.map((job) => jobRecord(ctx, job)),
      );
    } catch (error) {
      return answer(
        "unreadable",
        [],
        `The job file could not be read: ${(error as Error).message.split("\n")[0]}.`,
      );
    }
  },
};
