/**
 * The scheduler's single entry point: one tick decides what is due and runs
 * it, and a manual run starts one job now.
 *
 * One tick:
 * 1. Does nothing at all inside a scheduled run's child process.
 * 2. Takes the checkout's tick lease, so two ticks never interleave. A tick
 *    that cannot get it ends `busy`; a busy timer tick only records that the
 *    timer fired.
 * 3. For each enabled job whose host is this machine and whose enrollment
 *    check passes, computes the due times since the job's cursor. Nothing
 *    before enrollment is due. Only the newest due time can run, and only
 *    when it is within the catch-up window; older and superseded times are
 *    written to the cursor as one skipped range, and the cursor's
 *    `last_considered` moves to the tick time so later ticks never walk the
 *    backlog again.
 * 4. Enforces the job's launches per day. A refused new due time is written
 *    as a skipped range (no claim is created); a refused retry abandons its
 *    claim. Both show in the tick result as `refused`.
 * 5. Creates the permanent claim, marks it `started`, calls the launcher,
 *    and marks it `finished`. Jobs run one after another.
 * 6. Always ends by writing the heartbeat.
 *
 * A claim with no start (a tick crashed between the claim and the launch)
 * is retried once by a later tick, when nothing newer for the job runs in
 * that tick; otherwise it is abandoned as superseded. A claim that started
 * and has no finish is never rerun and is listed as `uncertain`.
 *
 * The run kind is `catch-up` when older due times were skipped or the due
 * time is more than two timer intervals old, and `scheduled` otherwise.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMachineLabel } from "../../lib/machine.ts";
import { harnCliEntry } from "../cli-entry.ts";
import { sendPeerMessage } from "../inbox/peer-messages.ts";
import { writePrivateJsonAtomic } from "../storage/atomic-json.ts";
import {
  acquireScheduleLease,
  countScheduleLaunchesToday,
  createScheduleClaim,
  isScheduleLeaseBusy,
  listScheduleClaims,
  markScheduleClaimAbandoned,
  markScheduleClaimFinished,
  markScheduleClaimStarted,
  type ScheduleClaimEntry,
  takeScheduleClaimRetry,
} from "./claims.ts";
import { checkScheduleEnrollment } from "./enrollment.ts";
import {
  oneLineScheduleError,
  type ScheduleTickSource,
  scheduleHeartbeatMtimeMs,
  touchScheduleTimerHeartbeat,
  writeScheduleHeartbeat,
} from "./heartbeat.ts";
import {
  isScheduleChild,
  isScheduleJobEnabled,
  SCHEDULE_CATCH_UP_WINDOW_MS,
  SCHEDULE_SKIPPED_RANGES_KEPT,
  SCHEDULE_TIMER_INTERVAL_MINUTES,
  type ScheduleClaim,
  type ScheduleClaimKind,
  type ScheduleCursor,
  type ScheduleEnrollment,
  type ScheduleJob,
  type ScheduleJobResolution,
  type ScheduleLauncher,
  type ScheduleRunRecord,
  type ScheduleRunResult,
  type ScheduleSkippedRange,
  validateScheduleCursor,
} from "./job-types.ts";
import { findScheduleJob, loadScheduleJobFile, resolveScheduleJob } from "./jobs.ts";
import { scheduleCursorPath, scheduleRunDir, scheduleRunStamp } from "./paths.ts";
import { scheduleDueTimes, scheduleNextDueTime } from "./triggers.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** Tells a job's owner that a run needs attention. Best effort; must not throw. */
export type ScheduleOwnerNotifier = (input: {
  coordRoot: string;
  owner: string;
  message: string;
}) => void;

/** Leaves a held `agents ping` for the owner; an unknown name is ignored. */
export const notifyScheduleOwner: ScheduleOwnerNotifier = ({ coordRoot, owner, message }) => {
  try {
    sendPeerMessage({
      coordRoot,
      target: { name: owner },
      senderInstanceId: null,
      senderName: "harnery-schedule",
      body: message,
    });
  } catch {
    // The owner cannot be resolved or the inbox refused; the report still exists.
  }
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ScheduleTickLaunch {
  scheduled_for: string;
  kind: ScheduleClaimKind;
  run_id: string;
  /** True when this launch is the one retry of a claim that never started. */
  retry: boolean;
  /** Set when the launcher returned a record. */
  result?: ScheduleRunResult;
  report_path?: string;
  /** Set when the launcher threw; the claim stays `started` (uncertain). */
  error?: string;
}

export type ScheduleTickSkipReason =
  | "disabled"
  | "other-host"
  | "not-enrolled"
  | "changed"
  | "wrong-machine"
  | "wrong-checkout";

export interface ScheduleTickJobOutcome {
  job_id: string;
  /** Set when the job was not considered at all. */
  skipped?: { reason: ScheduleTickSkipReason; detail: string };
  launches: ScheduleTickLaunch[];
  /** Due times not run because of the launches-per-day limit. */
  refused: { scheduled_for: string; reason: "daily-limit"; launches_today: number }[];
  /** Claims with no start given up in this tick. */
  abandoned: { scheduled_for: string; reason: "retried-once" | "superseded" | "daily-limit" }[];
  /** The range written to the cursor in this tick, if any. */
  skipped_range?: ScheduleSkippedRange;
  /** Claims that started and never finished; never rerun. */
  uncertain: string[];
}

export interface ScheduleTickResult {
  status: "ok" | "busy" | "error" | "child";
  source: ScheduleTickSource;
  tick_at: string;
  jobs: ScheduleTickJobOutcome[];
  /** One line; set when `status` is `error`. */
  error?: string;
}

export interface ScheduleTickOptions {
  coordRoot: string;
  source: ScheduleTickSource;
  /** The tick's instant; defaults to the current time. */
  now?: Date;
  /** Defaults to `launchScheduledJob` from `./launch.ts`. */
  launcher?: ScheduleLauncher;
  /** Defaults to `resolveMachineLabel()`. */
  machine?: string;
  /** Defaults to `process.env`; used for the child marker and executable lookup. */
  env?: Env;
  /** Defaults to `notifyScheduleOwner`. */
  notify?: ScheduleOwnerNotifier;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function defaultLauncher(): Promise<ScheduleLauncher> {
  const mod = await import("./launch.ts");
  return (request) => mod.launchScheduledJob(request);
}

function clockFrom(now: Date | undefined): () => Date {
  return () => (now ? new Date(now.getTime()) : new Date());
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readCursor(coordRoot: string, jobId: string): ScheduleCursor | null {
  try {
    const value: unknown = JSON.parse(readFileSync(scheduleCursorPath(coordRoot, jobId), "utf8"));
    const checked = validateScheduleCursor(value);
    if (!checked.ok || checked.value.job_id !== jobId) return null;
    return checked.value;
  } catch {
    return null;
  }
}

/** Read a job's cursor, validated; null when missing or invalid. */
export function readScheduleCursor(coordRoot: string, jobId: string): ScheduleCursor | null {
  return readCursor(coordRoot, jobId);
}

function writeCursor(coordRoot: string, cursor: ScheduleCursor): void {
  const kept = cursor.skipped.slice(-SCHEDULE_SKIPPED_RANGES_KEPT);
  const next = { ...cursor, skipped: kept };
  const checked = validateScheduleCursor(next);
  if (!checked.ok) throw new Error(`schedule cursor: ${checked.errors.join("; ")}`);
  writePrivateJsonAtomic(scheduleCursorPath(coordRoot, cursor.job_id), checked.value);
}

type EnrollmentGate =
  | { ok: true; enrollment: ScheduleEnrollment; resolved: ScheduleJobResolution }
  | { ok: false; reason: ScheduleTickSkipReason; detail: string };

function gateJob(coordRoot: string, job: ScheduleJob, machine: string, env: Env): EnrollmentGate {
  const resolution = resolveScheduleJob(job, { coordRoot, env });
  const resolved: ScheduleJobResolution = {
    executables: resolution.executables,
    zone: resolution.zone,
  };
  const check = checkScheduleEnrollment({ coordRoot, job, resolved, machine });
  if (check.state !== "enrolled") {
    const missing =
      resolution.missing.length > 0 ? ` (not found: ${resolution.missing.join(", ")})` : "";
    return { ok: false, reason: check.state, detail: `${check.detail}${missing}` };
  }
  return { ok: true, enrollment: check.enrollment, resolved };
}

interface RunClaimInput {
  coordRoot: string;
  job: ScheduleJob;
  enrollment: ScheduleEnrollment;
  claim: ScheduleClaim;
  launcher: ScheduleLauncher;
  clock: () => Date;
}

interface RunClaimOutput {
  record?: ScheduleRunRecord;
  runDir?: string;
  reportPath?: string;
  error?: string;
}

/** Start, launch and finish one claim. A launcher that throws leaves it `started`. */
async function runClaim(input: RunClaimInput): Promise<RunClaimOutput> {
  const { coordRoot, job, enrollment, launcher, clock } = input;
  const startedAt = clock();
  const started = markScheduleClaimStarted(coordRoot, input.claim, {
    now: startedAt,
    pid: process.pid,
  });
  const deadline = new Date(startedAt.getTime() + job.timeout_minutes * 60_000);
  let record: ScheduleRunRecord;
  try {
    ({ record } = await launcher({
      job,
      enrollment,
      claim: started,
      coordRoot,
      deadline_at: deadline.toISOString(),
    }));
  } catch (error) {
    return { error: oneLineScheduleError(errorText(error)) };
  }
  markScheduleClaimFinished(coordRoot, started, { now: clock() });
  const runDir = scheduleRunDir(coordRoot, job.id, scheduleRunStamp(record.started_at));
  return { record, runDir, reportPath: join(runDir, record.report_file) };
}

// ---------------------------------------------------------------------------
// One job in one tick
// ---------------------------------------------------------------------------

interface JobTickInput {
  coordRoot: string;
  job: ScheduleJob;
  enrollment: ScheduleEnrollment;
  zone: string;
  nowMs: number;
  clock: () => Date;
  launcher: ScheduleLauncher;
  notify: ScheduleOwnerNotifier;
  /** Collects launcher errors; the tick ends `error` when any is set. */
  errors: string[];
}

async function tickJob(input: JobTickInput): Promise<ScheduleTickJobOutcome> {
  const { coordRoot, job, enrollment, zone, nowMs, clock } = input;
  const outcome: ScheduleTickJobOutcome = {
    job_id: job.id,
    launches: [],
    refused: [],
    abandoned: [],
    uncertain: [],
  };
  const enrolledAtMs = Date.parse(enrollment.enrolled_at);
  const windowStart = nowMs - SCHEDULE_CATCH_UP_WINDOW_MS;

  const recent = listScheduleClaims(coordRoot, job.id, { sinceMs: windowStart - 86_400_000 });
  const byTime = new Map(recent.map((entry) => [entry.scheduled_for, entry]));
  for (const entry of recent) {
    if (entry.claim?.state === "started" && entry.claim.kind !== "manual") {
      outcome.uncertain.push(entry.scheduled_for);
    }
  }
  const orphans: ScheduleClaimEntry[] = recent.filter(
    (entry) => entry.claim?.state === "claimed" && entry.claim.kind !== "manual",
  );

  // Due times since the cursor.
  const cursor = readCursor(coordRoot, job.id);
  const afterMs = cursor ? Date.parse(cursor.last_considered) : enrolledAtMs - 1;
  const due = scheduleDueTimes(job.trigger, { zone, enrolledAtMs, afterMs, untilMs: nowMs });

  let planned: { scheduledFor: string; kind: ScheduleClaimKind } | null = null;
  let skippedFromMs: number | null = null;
  let skippedToMs = 0;
  let skippedCount = 0;
  const skip = (ms: number, count = 1) => {
    if (skippedFromMs === null || ms < skippedFromMs) skippedFromMs = ms;
    if (ms > skippedToMs) skippedToMs = ms;
    skippedCount += count;
  };

  if (due.times.length > 0) {
    const newest = due.times[due.times.length - 1] as number;
    const older = due.times.slice(0, -1);
    if (older.length > 0) {
      // When capped, the oldest times were not returned; the range still
      // starts at the first due time and the count covers what was seen.
      const first = due.capped
        ? scheduleNextDueTime(job.trigger, { zone, enrolledAtMs, afterMs })
        : older[0];
      if (first !== null && first !== undefined) skip(first, 0);
      for (const ms of older) skip(ms);
    }
    if (newest < windowStart) {
      skip(newest);
    } else {
      const iso = new Date(newest).toISOString();
      const kind: ScheduleClaimKind =
        older.length > 0 || nowMs - newest > 2 * SCHEDULE_TIMER_INTERVAL_MINUTES * 60_000
          ? "catch-up"
          : "scheduled";
      // An existing claim for this time is handled as an orphan or is done.
      if (!byTime.has(iso)) planned = { scheduledFor: iso, kind };
    }
  }

  // Claim the planned time (or record the refusal) before writing the cursor,
  // so a crash between the two leaves a claim the next tick recognises.
  let plannedClaim: ScheduleClaim | null = null;
  if (planned) {
    const created = createScheduleClaim({
      coordRoot,
      jobId: job.id,
      scheduledFor: planned.scheduledFor,
      kind: planned.kind,
      now: clock(),
      limit: { maxLaunchesPerDay: job.max_launches_per_day, zone },
    });
    if (created.ok) {
      plannedClaim = created.claim;
    } else if (created.reason === "daily-limit") {
      outcome.refused.push({
        scheduled_for: planned.scheduledFor,
        reason: "daily-limit",
        launches_today: created.launchesToday,
      });
      skip(Date.parse(planned.scheduledFor));
    }
  }

  if (due.times.length > 0) {
    const skipped = [...(cursor?.skipped ?? [])];
    if (skippedFromMs !== null && skippedCount > 0) {
      const range: ScheduleSkippedRange = {
        from: new Date(skippedFromMs).toISOString(),
        to: new Date(skippedToMs).toISOString(),
        count: skippedCount,
      };
      skipped.push(range);
      outcome.skipped_range = range;
    }
    writeCursor(coordRoot, {
      schema_version: 1,
      job_id: job.id,
      last_considered: new Date(Math.max(nowMs, due.times.at(-1) as number)).toISOString(),
      skipped,
    });
  }

  // Orphaned claims: retry the newest once when nothing newer runs now.
  const toRun: { claim: ScheduleClaim; retry: boolean }[] = [];
  const newestOrphan = orphans.at(-1);
  for (const entry of orphans) {
    const claim = entry.claim as ScheduleClaim;
    let reason: "retried-once" | "superseded" | "daily-limit" | null = null;
    if (entry !== newestOrphan || plannedClaim !== null) {
      reason = "superseded";
    } else if (Date.parse(claim.scheduled_for) < windowStart) {
      reason = "superseded";
    } else if (entry.retried || !takeScheduleClaimRetry(coordRoot, claim, clock())) {
      reason = "retried-once";
    } else {
      const launchesToday = countScheduleLaunchesToday(coordRoot, job.id, clock(), zone);
      if (launchesToday >= job.max_launches_per_day) {
        reason = "daily-limit";
        outcome.refused.push({
          scheduled_for: claim.scheduled_for,
          reason: "daily-limit",
          launches_today: launchesToday,
        });
      }
    }
    if (reason) {
      markScheduleClaimAbandoned(coordRoot, claim, { now: clock() });
      outcome.abandoned.push({ scheduled_for: claim.scheduled_for, reason });
    } else {
      toRun.push({ claim, retry: true });
    }
  }
  if (plannedClaim) toRun.push({ claim: plannedClaim, retry: false });

  for (const { claim, retry } of toRun) {
    const run = await runClaim({
      coordRoot,
      job,
      enrollment,
      claim,
      launcher: input.launcher,
      clock,
    });
    const launch: ScheduleTickLaunch = {
      scheduled_for: claim.scheduled_for,
      kind: claim.kind,
      run_id: claim.run_id,
      retry,
    };
    if (run.error !== undefined) {
      launch.error = run.error;
      input.errors.push(`${job.id}: launcher failed: ${run.error}`);
    } else if (run.record) {
      launch.result = run.record.result;
      launch.report_path = run.reportPath;
      if (job.owner && (run.record.result === "attention" || run.record.result === "failed")) {
        input.notify({
          coordRoot,
          owner: job.owner,
          message: `Scheduled job ${job.id} ended ${run.record.result}; report: ${run.reportPath}`,
        });
      }
    }
    outcome.launches.push(launch);
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/** How long a crashed tick's lease blocks the next one before its process is checked. */
const TICK_LEASE_STALE_MS = 60_000;

/** Run one tick. Never throws for a job's failure; the result and heartbeat carry it. */
export async function runScheduleTick(opts: ScheduleTickOptions): Promise<ScheduleTickResult> {
  const clock = clockFrom(opts.now);
  const tickAt = clock();
  const result: ScheduleTickResult = {
    status: "ok",
    source: opts.source,
    tick_at: tickAt.toISOString(),
    jobs: [],
  };
  if (isScheduleChild(opts.env)) {
    result.status = "child";
    return result;
  }

  let lease: ReturnType<typeof acquireScheduleLease>;
  try {
    lease = acquireScheduleLease(opts.coordRoot, "tick", { staleAfterMs: TICK_LEASE_STALE_MS });
  } catch (error) {
    if (!isScheduleLeaseBusy(error)) {
      result.status = "error";
      result.error = oneLineScheduleError(`tick lease: ${errorText(error)}`);
      writeHeartbeatQuietly(opts.coordRoot, tickAt, opts.source, result.error);
      return result;
    }
    result.status = "busy";
    if (opts.source === "timer") {
      try {
        touchScheduleTimerHeartbeat(opts.coordRoot, tickAt);
      } catch {
        // The running tick writes the full heartbeat when it ends.
      }
    }
    return result;
  }

  const errors: string[] = [];
  try {
    const loaded = loadScheduleJobFile(opts.coordRoot);
    if (!loaded.ok && loaded.reason === "invalid") {
      errors.push(`job file is invalid: ${loaded.errors.join("; ")}`);
    } else if (loaded.ok) {
      const machine = opts.machine ?? resolveMachineLabel();
      const env: Env = opts.env ?? process.env;
      const notify = opts.notify ?? notifyScheduleOwner;
      let launcher = opts.launcher;
      for (const job of loaded.file.jobs) {
        const base = { job_id: job.id, launches: [], refused: [], abandoned: [], uncertain: [] };
        if (!isScheduleJobEnabled(job)) {
          result.jobs.push({
            ...base,
            skipped: { reason: "disabled", detail: "enabled is false" },
          });
          continue;
        }
        if (job.host !== machine) {
          result.jobs.push({
            ...base,
            skipped: {
              reason: "other-host",
              detail: `runs on "${job.host}", and this machine is "${machine}"`,
            },
          });
          continue;
        }
        try {
          const gate = gateJob(opts.coordRoot, job, machine, env);
          if (!gate.ok) {
            result.jobs.push({ ...base, skipped: { reason: gate.reason, detail: gate.detail } });
            continue;
          }
          launcher ??= await defaultLauncher();
          result.jobs.push(
            await tickJob({
              coordRoot: opts.coordRoot,
              job,
              enrollment: gate.enrollment,
              zone: gate.resolved.zone,
              nowMs: tickAt.getTime(),
              clock,
              launcher,
              notify,
              errors,
            }),
          );
        } catch (error) {
          errors.push(`${job.id}: ${errorText(error)}`);
        }
      }
    }
  } catch (error) {
    errors.push(errorText(error));
  } finally {
    if (errors.length > 0) {
      result.status = "error";
      result.error = oneLineScheduleError(errors.join("; "));
    }
    writeHeartbeatQuietly(opts.coordRoot, tickAt, opts.source, result.error);
    try {
      lease.release();
    } catch {
      // A stale lease is recovered by the next tick once this process is gone.
    }
  }
  return result;
}

function writeHeartbeatQuietly(
  coordRoot: string,
  at: Date,
  source: ScheduleTickSource,
  error: string | undefined,
): void {
  try {
    writeScheduleHeartbeat(coordRoot, {
      at,
      source,
      status: error === undefined ? "ok" : "error",
      error,
    });
  } catch {
    // Nothing else can report a heartbeat that cannot be written.
  }
}

// ---------------------------------------------------------------------------
// Manual run
// ---------------------------------------------------------------------------

export interface ManualScheduleRunOptions {
  coordRoot: string;
  jobId: string;
  /** Defaults to the current time; becomes the claim's `scheduled_for`. */
  now?: Date;
  /** Defaults to `launchScheduledJob` from `./launch.ts`. */
  launcher?: ScheduleLauncher;
  machine?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export type ManualScheduleRunResult =
  | { ok: true; record: ScheduleRunRecord; runDir: string; reportPath: string }
  | { ok: false; reason: string };

/** How many one-millisecond steps a manual claim tries past a collision. */
const MANUAL_CLAIM_ATTEMPTS = 1000;

/**
 * Run one job now. The job must exist and pass the same enrollment check as
 * the tick. The claim's `scheduled_for` is the request time, kind `manual`;
 * when that instant is already claimed the time moves on one millisecond and
 * the create is tried again. A manual run does not read or move the cursor.
 * It counts toward the launches-per-day limit and is refused once the limit
 * is reached, because the limit protects cost. It does not take the tick
 * lease, so it can run while a tick runs.
 */
export async function runScheduleJobManually(
  opts: ManualScheduleRunOptions,
): Promise<ManualScheduleRunResult> {
  const clock = clockFrom(opts.now);
  const requestedAt = clock();
  const loaded = loadScheduleJobFile(opts.coordRoot);
  if (!loaded.ok) {
    return {
      ok: false,
      reason:
        loaded.reason === "missing"
          ? `no job file at ${loaded.path}`
          : `job file is invalid: ${loaded.errors.join("; ")}`,
    };
  }
  const job = findScheduleJob(loaded.file, opts.jobId);
  if (!job) return { ok: false, reason: `no job "${opts.jobId}" in ${loaded.path}` };
  const machine = opts.machine ?? resolveMachineLabel();
  const gate = gateJob(opts.coordRoot, job, machine, opts.env ?? process.env);
  if (!gate.ok) return { ok: false, reason: `${gate.reason}: ${gate.detail}` };

  let claim: ScheduleClaim | null = null;
  for (let step = 0; step < MANUAL_CLAIM_ATTEMPTS && claim === null; step += 1) {
    const created = createScheduleClaim({
      coordRoot: opts.coordRoot,
      jobId: job.id,
      scheduledFor: new Date(requestedAt.getTime() + step).toISOString(),
      kind: "manual",
      now: requestedAt,
      limit: { maxLaunchesPerDay: job.max_launches_per_day, zone: gate.resolved.zone },
    });
    if (created.ok) {
      claim = created.claim;
    } else if (created.reason === "daily-limit") {
      return {
        ok: false,
        reason: `daily-limit: job "${job.id}" already launched ${created.launchesToday} times today (limit ${job.max_launches_per_day})`,
      };
    }
  }
  if (!claim) return { ok: false, reason: "could not claim a free instant for the manual run" };

  const launcher = opts.launcher ?? (await defaultLauncher());
  const run = await runClaim({
    coordRoot: opts.coordRoot,
    job,
    enrollment: gate.enrollment,
    claim,
    launcher,
    clock,
  });
  if (run.error !== undefined || !run.record || !run.runDir || !run.reportPath) {
    return { ok: false, reason: `launcher failed: ${run.error ?? "no run record"}` };
  }
  return { ok: true, record: run.record, runDir: run.runDir, reportPath: run.reportPath };
}

// ---------------------------------------------------------------------------
// Activity catch-up: throttle and detached start
// ---------------------------------------------------------------------------

/** Default gap between activity ticks. */
export const SCHEDULE_ACTIVITY_TICK_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * Whether session activity should start a catch-up tick: one `stat` of the
 * heartbeat. True when it is missing or older than `minIntervalMs`.
 */
export function shouldRunActivityTick(
  coordRoot: string,
  now: Date = new Date(),
  minIntervalMs: number = SCHEDULE_ACTIVITY_TICK_MIN_INTERVAL_MS,
): boolean {
  const mtime = scheduleHeartbeatMtimeMs(coordRoot);
  return mtime === null || now.getTime() - mtime >= minIntervalMs;
}

export interface SpawnDetachedScheduleTickOptions {
  /** Replaces the CLI entry the child runs (tests). */
  cliEntry?: string;
  /** Replaces `child_process.spawn` (tests). */
  spawnImpl?: typeof spawn;
}

/**
 * Start `<cli> schedule tick --source activity --root <coordRoot>` as a
 * detached child of this runtime that inherits no input or output. Returns
 * whether the start was attempted without throwing.
 */
export function spawnDetachedScheduleTick(
  coordRoot: string,
  opts: SpawnDetachedScheduleTickOptions = {},
): { launched: boolean } {
  try {
    const child = (opts.spawnImpl ?? spawn)(
      process.execPath,
      [
        opts.cliEntry ?? harnCliEntry(),
        "schedule",
        "tick",
        "--source",
        "activity",
        "--root",
        coordRoot,
      ],
      { cwd: coordRoot, detached: true, windowsHide: true, stdio: "ignore" },
    );
    child.once("error", () => {
      // The next activity or timer tick tries again.
    });
    child.unref();
    return { launched: true };
  } catch {
    return { launched: false };
  }
}
