/**
 * Scheduler health: what the next session start and `doctor` say about failed
 * or uncertain runs and about a stopped clock.
 *
 * `assessScheduleHealth` reads only files (the heartbeat, the timer install
 * record, the job file and enrollments, each job's run records and claims)
 * and, only when a timer install record exists, asks systemd for the timer
 * unit's state. It never writes.
 *
 * Order matters. The heartbeat is the evidence that the clock stopped, and any
 * tick refreshes it. Every file is read synchronously, before the first
 * `await`, so a caller that starts the assessment and then starts the
 * catch-up tick still judges the state the previous session left behind.
 *
 * Repeat rule: a run warning is derived from the files each time, with no
 * "already shown" state. A failed or attention run stays in the cue until a
 * newer `ok` run of the same job exists, and an uncertain claim stays until a
 * newer `ok` run supersedes it. Nothing a session does can hide a failure, so
 * a caller shows the cue once, at session start, not on every prompt.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveMachineLabel } from "../../lib/machine.ts";
import { resolveBinName } from "../config.ts";
import { defaultScheduleCommandRunner } from "./command-runner.ts";
import { checkScheduleEnrollment, readScheduleEnrollment } from "./enrollment.ts";
import {
  isScheduleJobEnabled,
  isScheduleKebabId,
  parseScheduleClaimFileName,
  parseScheduleJobFileText,
  SCHEDULE_TIMEOUT_MINUTES_MAX,
  type ScheduleClaim,
  type ScheduleHeartbeat,
  type ScheduleRunRecord,
  type ScheduleTimerInstall,
  validateScheduleClaim,
  validateScheduleHeartbeat,
  validateScheduleTimerInstall,
} from "./job-types.ts";
import { loadScheduleJobFile, resolveScheduleJob } from "./jobs.ts";
import {
  scheduleClaimsDir,
  scheduleHeartbeatPath,
  scheduleJobFilePath,
  scheduleRunDir,
  scheduleRunStamp,
  scheduleStateDir,
  scheduleTimerInstallPath,
} from "./paths.ts";
import { listScheduleRuns } from "./report.ts";
import type { ScheduleCommandRunner } from "./types.ts";

/** At most this many claim files per job are read, newest first. */
export const SCHEDULE_CUE_CLAIMS_READ = 50;

/** Session-start cue lines, including the closing "and N more" line. */
export const SCHEDULE_CUE_MAX_LINES = 5;

/**
 * Slack past a job's deadline before a started run with a live-looking
 * process counts as uncertain: two timer intervals, so a tick that is about
 * to record the finish is not reported.
 */
export const SCHEDULE_UNCERTAIN_GRACE_MS = 10 * 60 * 1000;

export type ScheduleProblemKind =
  | "run-failed"
  | "run-attention"
  | "run-uncertain"
  | "job-stopped"
  | "tick-error"
  | "timer-overdue"
  | "timer-unit"
  | "unreadable";

export interface ScheduleProblem {
  kind: ScheduleProblemKind;
  /** `clock` for the heartbeat, timer and unit; `runs` for runs and claims. */
  area: "clock" | "runs";
  /** One line, no trailing period. */
  message: string;
  job_id?: string;
  /** The run's report, relative to the checkout. */
  report?: string;
  /** The problem file, relative to the checkout (for `unreadable`). */
  file?: string;
}

/**
 * `unknown` means systemd could not be asked (no `systemctl`, no user bus);
 * the heartbeat age is then the only clock evidence.
 */
export type ScheduleUnitStatus =
  | "active"
  | "missing"
  | "disabled"
  | "inactive"
  | "failed"
  | "unknown";

export interface ScheduleUnitState {
  status: ScheduleUnitStatus;
  detail?: string;
}

export type ScheduleUnitStateProbe = (install: ScheduleTimerInstall) => Promise<ScheduleUnitState>;

export interface ScheduleHealth {
  assessed_at: string;
  problems: ScheduleProblem[];
  /** Job ids with any run folder or claim folder on this machine. */
  jobs: string[];
  /** True when the tracked job file exists. */
  job_file: boolean;
  /** The heartbeat as read before any catch-up, or null when absent or invalid. */
  heartbeat: ScheduleHeartbeat | null;
  /** The install record, or null when no timer is installed (or it is invalid). */
  timer: ScheduleTimerInstall | null;
  /** Set only when a valid install record exists. */
  unit_state?: ScheduleUnitState;
}

export interface AssessScheduleHealthOptions {
  coordRoot: string;
  now?: Date;
  /** Default: `systemctlUnitStateProbe()` with the shared command runner. */
  unitState?: ScheduleUnitStateProbe;
  /** Default: signal 0; `EPERM` counts as alive. */
  isProcessAlive?: (pid: number) => boolean;
  /** Default: `resolveMachineLabel()`. */
  machine?: string;
  /** Default: `process.env`; used to find each gather command's executable. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Judge the scheduler's state from its files. Cheap when nothing is set up:
 * one `stat` of the private state folder and one of the job file, and no
 * subprocess unless a timer install record exists. Never throws on a bad file;
 * an invalid heartbeat, install record or claim is reported as `unreadable`.
 */
export async function assessScheduleHealth(
  opts: AssessScheduleHealthOptions,
): Promise<ScheduleHealth> {
  // Everything up to the unit probe is synchronous on purpose; see the header.
  const now = opts.now ?? new Date();
  const root = opts.coordRoot;
  const health: ScheduleHealth = {
    assessed_at: now.toISOString(),
    problems: [],
    jobs: [],
    job_file: existsSync(scheduleJobFilePath(root)),
    heartbeat: null,
    timer: null,
  };
  if (!existsSync(scheduleStateDir(root))) return health;

  const heartbeatRead = readRecord(scheduleHeartbeatPath(root), validateScheduleHeartbeat);
  if (heartbeatRead.state === "ok") health.heartbeat = heartbeatRead.value;
  else if (heartbeatRead.state === "invalid") {
    health.problems.push(
      unreadable(root, scheduleHeartbeatPath(root), "clock", heartbeatRead.error),
    );
  }

  const installRead = readRecord(scheduleTimerInstallPath(root), validateScheduleTimerInstall);
  if (installRead.state === "ok") health.timer = installRead.value;
  else if (installRead.state === "invalid") {
    health.problems.push(
      unreadable(root, scheduleTimerInstallPath(root), "clock", installRead.error),
    );
  }

  if (health.timer) health.problems.push(...clockProblems(health.timer, health.heartbeat, now));

  health.jobs = jobIds(root);
  const alive = opts.isProcessAlive ?? defaultIsProcessAlive;
  let timeouts: Map<string, number> | null = null;
  const jobTimeoutMs = (jobId: string): number => {
    timeouts ??= readJobTimeouts(root);
    return (timeouts.get(jobId) ?? SCHEDULE_TIMEOUT_MINUTES_MAX) * 60_000;
  };
  for (const jobId of health.jobs) {
    health.problems.push(...runProblems(root, jobId, now, alive, jobTimeoutMs));
  }
  if (health.job_file) health.problems.push(...stoppedJobProblems(root, opts));

  if (health.timer) {
    const probe = opts.unitState ?? systemctlUnitStateProbe();
    let unit: ScheduleUnitState;
    try {
      unit = await probe(health.timer);
    } catch (err) {
      unit = { status: "unknown", detail: oneLine(String(err)) };
    }
    health.unit_state = unit;
    if (unit.status !== "active" && unit.status !== "unknown") {
      health.problems.push({
        kind: "timer-unit",
        area: "clock",
        message: `schedule timer ${health.timer.unit} is ${unit.status}${unit.detail ? ` (${unit.detail})` : ""}`,
      });
    }
  }
  return health;
}

/**
 * The session-start cue: one line per problem, at most
 * `SCHEDULE_CUE_MAX_LINES` lines with the last one saying how many more.
 * Empty when healthy.
 */
export function scheduleCueLines(health: ScheduleHealth, bin: string = resolveBinName()): string[] {
  const lines = health.problems.map((p) => `${p.message}; ${scheduleProblemHint(p, bin)}`);
  if (lines.length <= SCHEDULE_CUE_MAX_LINES) return lines;
  const shown = lines.slice(0, SCHEDULE_CUE_MAX_LINES - 1);
  const more = lines.length - shown.length;
  shown.push(`and ${more} more schedule problems; run \`${bin} doctor\``);
  return shown;
}

/** The command that shows more about one problem. */
export function scheduleProblemHint(
  problem: ScheduleProblem,
  bin: string = resolveBinName(),
): string {
  if (problem.kind === "job-stopped" && problem.job_id) {
    return `review it and run \`${bin} schedule enroll ${problem.job_id}\``;
  }
  if (problem.job_id) {
    const where = problem.report ? `report ${problem.report}, ` : "";
    return `${where}see \`${bin} schedule history ${problem.job_id}\``;
  }
  if (problem.kind === "timer-unit" || problem.kind === "timer-overdue") {
    return `check \`${bin} schedule timer-status\`, or run \`${bin} schedule install\` again`;
  }
  if (problem.kind === "tick-error") return `run \`${bin} schedule tick\` to see it again`;
  return `see \`${bin} doctor\``;
}

/**
 * Asks systemd about the timer and its service in one `systemctl --user show`
 * call. A missing `systemctl`, a missing user bus, or output it cannot parse
 * gives `unknown`, so the caller falls back to the heartbeat age.
 */
export function systemctlUnitStateProbe(
  runCommand: ScheduleCommandRunner = defaultScheduleCommandRunner,
  timeoutMs = 3_000,
): ScheduleUnitStateProbe {
  return async (install) => {
    const timer = install.unit;
    const service = timer.endsWith(".timer") ? `${timer.slice(0, -".timer".length)}.service` : null;
    const units = service ? [timer, service] : [timer];
    const result = await runCommand(
      [
        "systemctl",
        "--user",
        "show",
        ...units,
        "--property=Id,LoadState,ActiveState,UnitFileState,Result",
      ],
      { timeoutMs },
    );
    if (result.error || result.exitCode !== 0) {
      return { status: "unknown", detail: oneLine(result.error ?? result.stderr) || undefined };
    }
    return parseSystemctlShow(result.stdout, timer, service);
  };
}

/** Exported for tests: the state of the timer (and its service) from `systemctl show` output. */
export function parseSystemctlShow(
  stdout: string,
  timer: string,
  service: string | null,
): ScheduleUnitState {
  const blocks = stdout
    .split(/\r?\n\s*\r?\n/)
    .map((block) => {
      const props: Record<string, string> = {};
      for (const line of block.split(/\r?\n/)) {
        const eq = line.indexOf("=");
        if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1).trim();
      }
      return props;
    })
    .filter((props) => Object.keys(props).length > 0);
  const timerProps = blocks.find((b) => b.Id === timer) ?? blocks[0];
  if (!timerProps?.LoadState) return { status: "unknown" };
  if (timerProps.LoadState === "not-found") return { status: "missing" };
  if (timerProps.ActiveState === "failed") return { status: "failed", detail: timer };
  const serviceProps = service ? blocks.find((b) => b.Id === service) : undefined;
  if (serviceProps?.ActiveState === "failed") {
    const why =
      serviceProps.Result && serviceProps.Result !== "success" ? `: ${serviceProps.Result}` : "";
    return { status: "failed", detail: `${service}${why}` };
  }
  if (timerProps.UnitFileState && !/^enabled/.test(timerProps.UnitFileState)) {
    return { status: "disabled", detail: timerProps.UnitFileState };
  }
  if (timerProps.ActiveState && timerProps.ActiveState !== "active") {
    return { status: "inactive", detail: timerProps.ActiveState };
  }
  return { status: "active" };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Jobs that were enrolled in this checkout and no longer pass the enrollment
 * check because an execution field changed (an edit, or a pulled commit).
 * Such a job does not run until it is enrolled again, and without this line
 * nothing would say so. A job that was never enrolled here, is disabled, or
 * names another host is not a problem.
 */
function stoppedJobProblems(root: string, opts: AssessScheduleHealthOptions): ScheduleProblem[] {
  const problems: ScheduleProblem[] = [];
  try {
    const loaded = loadScheduleJobFile(root);
    if (!loaded.ok) return problems;
    let machine: string | null = null;
    for (const job of loaded.file.jobs) {
      if (!isScheduleJobEnabled(job)) continue;
      if (!readScheduleEnrollment(root, job.id)) continue;
      machine ??= opts.machine ?? resolveMachineLabel();
      if (job.host !== machine) continue;
      const resolution = resolveScheduleJob(job, { coordRoot: root, env: opts.env ?? process.env });
      const check = checkScheduleEnrollment({
        coordRoot: root,
        job,
        resolved: { executables: resolution.executables, zone: resolution.zone },
        machine,
      });
      if (check.state !== "changed") continue;
      const missing =
        resolution.missing.length > 0 ? ` (not found: ${resolution.missing.join(", ")})` : "";
      problems.push({
        kind: "job-stopped",
        area: "runs",
        job_id: job.id,
        message: `scheduled job ${job.id} changed since it was enrolled and will not run${missing}`,
      });
    }
  } catch {
    // An unreadable job file or enrollment is reported by the list and the tick.
  }
  return problems;
}

type ReadOutcome<T> =
  | { state: "absent" }
  | { state: "ok"; value: T }
  | { state: "invalid"; error: string };

function readRecord<T>(
  path: string,
  validate: (value: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
): ReadOutcome<T> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return { state: "absent" };
    return { state: "invalid", error: oneLine(String(err)) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: "invalid", error: "not JSON" };
  }
  const check = validate(parsed);
  return check.ok
    ? { state: "ok", value: check.value }
    : { state: "invalid", error: check.errors[0] ?? "invalid" };
}

function unreadable(
  root: string,
  path: string,
  area: ScheduleProblem["area"],
  error: string,
  jobId?: string,
): ScheduleProblem {
  const file = relative(root, path);
  return {
    kind: "unreadable",
    area,
    message: `schedule file ${file} is unreadable (${error})`,
    file,
    ...(jobId ? { job_id: jobId } : {}),
  };
}

function clockProblems(
  install: ScheduleTimerInstall,
  heartbeat: ScheduleHeartbeat | null,
  now: Date,
): ScheduleProblem[] {
  const problems: ScheduleProblem[] = [];
  if (heartbeat?.last_tick_status === "error") {
    const error = heartbeat.last_tick_error ? `: ${oneLine(heartbeat.last_tick_error)}` : "";
    problems.push({
      kind: "tick-error",
      area: "clock",
      message: `the last schedule tick, ${ago(heartbeat.last_tick_at, now)}, failed${error}`,
    });
  }
  const limitMs = 2 * install.interval_minutes * 60_000;
  const lastTimerTick = heartbeat?.last_timer_tick_at;
  // No timer tick yet: count from the install, so a fresh install is quiet.
  const since = lastTimerTick ?? install.installed_at;
  if (now.getTime() - Date.parse(since) > limitMs) {
    problems.push({
      kind: "timer-overdue",
      area: "clock",
      message: lastTimerTick
        ? `the schedule timer last ticked ${ago(lastTimerTick, now)} (expected every ${install.interval_minutes}m)`
        : `the schedule timer has not ticked since it was installed ${ago(install.installed_at, now)}`,
    });
  }
  return problems;
}

function jobIds(root: string): string[] {
  const state = scheduleStateDir(root);
  const ids = new Set<string>();
  for (const sub of ["runs", "claims"]) {
    let names: string[];
    try {
      names = readdirSync(join(state, sub));
    } catch {
      continue;
    }
    for (const name of names) if (isScheduleKebabId(name)) ids.add(name);
  }
  return [...ids].sort();
}

function readJobTimeouts(root: string): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const parsed = parseScheduleJobFileText(readFileSync(scheduleJobFilePath(root), "utf8"));
    if (parsed.ok) for (const job of parsed.value.jobs) out.set(job.id, job.timeout_minutes);
  } catch {
    // No job file or an unreadable one: every job gets the longest timeout.
  }
  return out;
}

function reportPath(root: string, run: ScheduleRunRecord): string | undefined {
  try {
    const dir = scheduleRunDir(root, run.job_id, scheduleRunStamp(run.started_at));
    return relative(root, join(dir, run.report_file));
  } catch {
    return undefined;
  }
}

function runProblems(
  root: string,
  jobId: string,
  now: Date,
  alive: (pid: number) => boolean,
  jobTimeoutMs: (jobId: string) => number,
): ScheduleProblem[] {
  const problems: ScheduleProblem[] = [];
  const runs = listScheduleRuns(root, jobId); // newest first
  const newest = runs[0];
  if (newest && newest.result !== "ok") {
    const sinceOk = runs.findIndex((r) => r.result === "ok");
    const count = sinceOk === -1 ? runs.length : sinceOk;
    const streak = count > 1 ? ` (${count} runs since the last ok)` : "";
    const report = reportPath(root, newest);
    problems.push({
      kind: newest.result === "failed" ? "run-failed" : "run-attention",
      area: "runs",
      job_id: jobId,
      message:
        newest.result === "failed"
          ? `scheduled job ${jobId} failed ${ago(newest.finished_at, now)}${streak}`
          : `scheduled job ${jobId} needs attention, ${ago(newest.finished_at, now)}${streak}`,
      ...(report ? { report } : {}),
    });
  }

  // Uncertain runs. A claim is uncertain when it is `started`, has no finish
  // and no run record carries its run id, and either its recorded process is
  // gone or the job's deadline plus SCHEDULE_UNCERTAIN_GRACE_MS has passed
  // since it started. A run that is plausibly still going is not a problem.
  // Claims at or before the newest `ok` run's due time are superseded and not
  // read; at most SCHEDULE_CUE_CLAIMS_READ newer claim files are read.
  const newestOk = runs.find((r) => r.result === "ok");
  const okAfter = newestOk ? Date.parse(newestOk.scheduled_for) : Number.NEGATIVE_INFINITY;
  const finishedRunIds = new Set(runs.map((r) => r.run_id));
  let claimsDir: string;
  let names: string[];
  try {
    claimsDir = scheduleClaimsDir(root, jobId);
    names = readdirSync(claimsDir);
  } catch {
    return problems;
  }
  const candidates = names
    .map((name) => ({ name, parsed: parseScheduleClaimFileName(name) }))
    .filter(
      (c): c is { name: string; parsed: { job_id: string; scheduled_for: string } } =>
        c.parsed !== null && c.parsed.job_id === jobId,
    )
    .filter((c) => Date.parse(c.parsed.scheduled_for) > okAfter)
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
    .slice(0, SCHEDULE_CUE_CLAIMS_READ);
  for (const { name } of candidates) {
    const path = join(claimsDir, name);
    const read = readRecord<ScheduleClaim>(path, validateScheduleClaim);
    if (read.state === "absent") continue;
    if (read.state === "invalid") {
      problems.push(unreadable(root, path, "runs", read.error, jobId));
      continue;
    }
    const claim = read.value;
    if (claim.state !== "started" || claim.finished_at || finishedRunIds.has(claim.run_id))
      continue;
    const startedAt = Date.parse(claim.started_at ?? claim.claimed_at);
    const gone = claim.pid !== undefined && !alive(claim.pid);
    const pastDeadline =
      now.getTime() - startedAt > jobTimeoutMs(jobId) + SCHEDULE_UNCERTAIN_GRACE_MS;
    if (!gone && !pastDeadline) continue;
    problems.push({
      kind: "run-uncertain",
      area: "runs",
      job_id: jobId,
      message: `scheduled job ${jobId} started ${ago(claim.started_at ?? claim.claimed_at, now)} and never finished (${gone ? "its process is gone" : "past its deadline"}); it will not be rerun`,
      file: relative(root, path),
    });
  }
  return problems;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

function ago(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "at an unknown time";
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 120) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
