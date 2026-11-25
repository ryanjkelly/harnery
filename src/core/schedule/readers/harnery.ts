/**
 * Reader for Harnery's own scheduler: one record per job in the tracked job
 * file (`.harnery/schedules.jsonc`). It reads the job file, this checkout's
 * enrollments and the run records under `.harnery/private/schedule/`.
 *
 * Each record's `job` says what the job runs: every gather command's argv as
 * written, the names (never values) of the environment variables it passes
 * through, and the judge agent's adapter, model, effort and full prompt. The
 * job file is the project's own committed, reviewed file, so showing it
 * reveals nothing the checkout does not already hold (ADR 0280). The record
 * never carries environment values, gather output or report text; for the
 * newest run it gives exit codes and the report's path only.
 */

import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
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
  ScheduleHarneryEnrollment,
  ScheduleHarneryJob,
  ScheduleHarneryRun,
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

/** The record form of an enrollment check. */
export function harneryEnrollment(check: ScheduleEnrollmentCheck): ScheduleHarneryEnrollment {
  return {
    state: check.state,
    detail: check.state === "enrolled" ? null : check.detail,
    enrolled_at: check.enrollment?.enrolled_at ?? null,
  };
}

/** The record form of a run: outcomes and the report's path, never its text. */
export function harneryRun(coordRoot: string, run: ScheduleRunRecord): ScheduleHarneryRun {
  const reportPath = harneryRunReportPath(coordRoot, run);
  const started = Date.parse(run.started_at);
  const finished = Date.parse(run.finished_at);
  return {
    run_id: run.run_id,
    kind: run.kind,
    result: run.result,
    started_at: run.started_at,
    finished_at: run.finished_at,
    duration_ms: Number.isFinite(started) && finished >= started ? finished - started : 0,
    commands: run.gather.map((g) => ({ name: g.name, state: g.state, exit_code: g.exit_code })),
    agent: run.agent
      ? { adapter: run.agent.adapter, ok: run.agent.ok, status_line: run.agent.status_line }
      : null,
    report_path:
      run.report_file && existsSync(reportPath)
        ? relative(coordRoot, reportPath).split(sep).join("/")
        : null,
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
  const detail: ScheduleHarneryJob = {
    commands: (job.gather ?? []).map((g) => ({
      name: g.name,
      argv: [...g.argv],
      env: [...(g.env ?? [])],
      finding_exit_codes: [...(g.finding_exit_codes ?? [])],
    })),
    agent: job.agent
      ? {
          adapter: job.agent.adapter,
          model: job.agent.model ?? null,
          effort: job.agent.effort ?? null,
          prompt: job.agent.prompt,
        }
      : null,
    enrollment: harneryEnrollment(check),
    owner: job.owner ?? null,
    timeout_minutes: job.timeout_minutes,
    max_launches_per_day: job.max_launches_per_day,
    zone: resolved.zone,
    latest_run: latest ? harneryRun(ctx.coordRoot, latest) : null,
  };
  return {
    source: "harnery",
    account: ctx.machine,
    id: job.id,
    title: job.title,
    ...(job.description ? { description: job.description } : {}),
    trigger: harneryScheduleTrigger(job.trigger, resolved.zone),
    runs_on: { host: job.host },
    enabled,
    next_run_at: nextRunAt,
    last_run: latest ? { at: latest.finished_at, status: harneryRunStatus(latest.result) } : null,
    created_by: null,
    job: detail,
  };
}

export const harneryScheduleReader: ScheduleReader = {
  id: "harnery",
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
