/**
 * Stage 2 contract for Harnery's own scheduler: the tracked job file, the
 * per-machine enrollment, the permanent claim for each due time, the cursor,
 * the heartbeat, the run record, and the request the tick hands to the run
 * module.
 *
 * Pure: types, constants, validators and hashing. No file or process access;
 * paths live in `paths.ts`. Frozen for the tracks that build against it.
 */

import { coordEnv } from "../../lib/env.ts";
import { stripJsonComments } from "../config.ts";
import { stableDigest } from "../storage/durable-record.ts";
import { isScheduleIsoInstant, ScheduleFieldChecker, type ScheduleValidation } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Suffix for `coordEnv()`; the full variable is `SCHEDULE_CHILD_ENV`. */
export const SCHEDULE_CHILD_ENV_SUFFIX = "SCHEDULE_CHILD";
/**
 * Set to "1" in a scheduled run's child process. Hooks inside it skip
 * capture, the cue and the catch-up tick, the way `HARNERY_WORKFLOW_CHILD`
 * marks a workflow child.
 */
export const SCHEDULE_CHILD_ENV = `HARNERY_${SCHEDULE_CHILD_ENV_SUFFIX}`;

/**
 * Whether this process is a scheduled run's child. Reads `process.env`
 * through `coordEnv()` unless an environment is passed (tests).
 */
export function isScheduleChild(env?: Readonly<Record<string, string | undefined>>): boolean {
  const value = env ? env[SCHEDULE_CHILD_ENV] : coordEnv(SCHEDULE_CHILD_ENV_SUFFIX);
  return value === "1";
}

/** Only the latest missed time within this window gets a catch-up run. */
export const SCHEDULE_CATCH_UP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Run folders kept per job; older ones are removed. */
export const SCHEDULE_RUNS_KEPT = 20;
/** Bytes kept from one gather command's combined output; more marks it truncated. */
export const SCHEDULE_GATHER_OUTPUT_CAP_BYTES = 262_144;
/** How often the installed timer calls the tick. */
export const SCHEDULE_TIMER_INTERVAL_MINUTES = 5;
/** Skipped ranges kept in a cursor; the newest are kept. */
export const SCHEDULE_SKIPPED_RANGES_KEPT = 20;

export const SCHEDULE_JOB_FILE_VERSION = 1;
export const SCHEDULE_EVERY_MIN_MINUTES = 5;
export const SCHEDULE_TIMEOUT_MINUTES_MAX = 240;
export const SCHEDULE_LAUNCHES_PER_DAY_MAX = 48;

// ---------------------------------------------------------------------------
// The job file: `<coordRoot>/.harnery/schedules.jsonc` (tracked)
// ---------------------------------------------------------------------------

/**
 * When a job is due. Times are in the zone from `resolveTimeZone()`.
 * - `once`: at one ISO instant (with Z or an offset).
 * - `every`: every `minutes` (whole number, at least 5), counted from the
 *   enrollment time.
 * - `cron`: a 5-field expression (minute hour day-of-month month
 *   day-of-week) with numbers, `*`, ranges, lists and steps. Names such as
 *   MON or JAN are not accepted. A time a clock change skips runs at the next
 *   valid minute; a time that repeats runs once.
 */
export type ScheduleJobTrigger =
  | { type: "once"; at: string }
  | { type: "every"; minutes: number }
  | { type: "cron"; expr: string };

/**
 * One command Harnery runs itself before any agent starts. A fixed
 * executable with literal arguments, never a shell string. It runs from the
 * checkout root with a small base environment plus the variables in `env`.
 */
export interface ScheduleGatherCommand {
  /** Kebab-case, unique within the job; names the output file. */
  name: string;
  /** `argv[0]` is an executable name or path; the rest are literal arguments. */
  argv: string[];
  /** Exit codes (1-255) that mean "the check ran and found something". Others besides 0 are errors. */
  finding_exit_codes?: number[];
  /** Names (not values) of environment variables passed through to the command. */
  env?: string[];
}

/** The read-only judge. The launcher refuses an adapter with no read-only projection. */
export interface ScheduleJobAgent {
  adapter: string;
  model?: string;
  effort?: string;
  prompt: string;
}

export interface ScheduleJob {
  /** Kebab-case, 1 to 64 characters, unique in the file. */
  id: string;
  title: string;
  /** One or two plain sentences on what the job does and why, for people reading the list. */
  description?: string;
  /** The machine label (`resolveMachineLabel()`) that may run the job. */
  host: string;
  trigger: ScheduleJobTrigger;
  /** One deadline for the whole job, gather and agent together: 1 to 240. */
  timeout_minutes: number;
  /** Launches allowed per day, counting catch-up and manual runs: 1 to 48. */
  max_launches_per_day: number;
  /** Agent name to ping when a run needs attention. */
  owner?: string;
  /** Defaults to true; see `isScheduleJobEnabled`. */
  enabled?: boolean;
  /** Non-empty when present. A job needs `gather`, `agent`, or both. */
  gather?: ScheduleGatherCommand[];
  agent?: ScheduleJobAgent;
}

export interface ScheduleJobFile {
  version: 1;
  jobs: ScheduleJob[];
}

export function isScheduleJobEnabled(job: ScheduleJob): boolean {
  return job.enabled !== false;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A job id or gather name: kebab-case, 1 to 64 characters. */
export function isScheduleKebabId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && KEBAB.test(value);
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHELL_OPERATOR = /\|\||&&|[|;<>`]|\$\(/;
const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);
const SHELL_COMMAND_FLAGS = new Set(["-c", "/c", "/C", "-Command", "-command", "-EncodedCommand"]);

function executableBaseName(argv0: string): string {
  const parts = argv0.split(/[\\/]/);
  return (parts[parts.length - 1] ?? argv0).toLowerCase();
}

function checkArgv(c: ScheduleFieldChecker, value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    c.fail(path, "must be a non-empty array of strings");
    return;
  }
  value.forEach((part, i) => {
    if (typeof part !== "string" || part.length === 0) {
      c.fail(`${path}[${i}]`, "must be a non-empty string");
      return;
    }
    if (/\s/.test(part) && SHELL_OPERATOR.test(part)) {
      c.fail(
        `${path}[${i}]`,
        "looks like a shell line; give the executable and each argument as separate elements",
      );
    }
  });
  const argv0 = value[0];
  if (typeof argv0 !== "string" || argv0.length === 0) return;
  if (/\s/.test(argv0) && !/[\\/]/.test(argv0)) {
    c.fail(`${path}[0]`, "must be one executable name or path, not a command line");
  }
  if (
    SHELLS.has(executableBaseName(argv0)) &&
    value.some((part, i) => i > 0 && typeof part === "string" && SHELL_COMMAND_FLAGS.has(part))
  ) {
    c.fail(path, "must not run a shell with a command string; name the executable directly");
  }
}

const CRON_FIELDS: readonly { name: string; min: number; max: number }[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

function cronItemValid(item: string, min: number, max: number): boolean {
  const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
  if (!m) return false;
  const inRange = (n: number) => n >= min && n <= max;
  if (m[2] !== undefined) {
    const lo = Number(m[2]);
    if (!inRange(lo)) return false;
    if (m[3] !== undefined) {
      const hi = Number(m[3]);
      if (!inRange(hi) || hi < lo) return false;
    }
  }
  if (m[4] !== undefined) {
    const step = Number(m[4]);
    if (step < 1 || step > max - min + 1) return false;
  }
  return true;
}

/**
 * Check a 5-field cron expression's syntax and ranges. Returns one error per
 * bad field; an empty list means valid. Track G computes the times.
 */
export function scheduleCronErrors(expr: string): string[] {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] === "") {
    return [
      `must have 5 fields (minute hour day-of-month month day-of-week); found ${expr.trim() === "" ? 0 : fields.length}`,
    ];
  }
  const errors: string[] = [];
  fields.forEach((field, i) => {
    const spec = CRON_FIELDS[i];
    if (!spec) return;
    const ok = field.split(",").every((item) => cronItemValid(item, spec.min, spec.max));
    if (!ok)
      errors.push(
        `${spec.name} field "${field}" must use numbers ${spec.min}-${spec.max}, *, ranges, lists or steps`,
      );
  });
  return errors;
}

function checkJobTrigger(c: ScheduleFieldChecker, value: unknown, path: string): void {
  const t = c.object(value, path);
  if (!t) return;
  if (!c.oneOf(t.type, ["once", "every", "cron"] as const, `${path}.type`)) return;
  switch (t.type) {
    case "once":
      c.onlyKeys(t, ["type", "at"], path);
      c.instant(t.at, `${path}.at`);
      break;
    case "every":
      c.onlyKeys(t, ["type", "minutes"], path);
      c.integer(t.minutes, `${path}.minutes`, SCHEDULE_EVERY_MIN_MINUTES, Number.MAX_SAFE_INTEGER);
      break;
    case "cron":
      c.onlyKeys(t, ["type", "expr"], path);
      if (c.string(t.expr, `${path}.expr`)) {
        for (const e of scheduleCronErrors(t.expr as string)) c.fail(`${path}.expr`, e);
      }
      break;
  }
}

function checkGather(c: ScheduleFieldChecker, value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    c.fail(path, "must be an array");
    return;
  }
  if (value.length === 0) {
    c.fail(path, "must not be empty; leave it out when the job has no gather commands");
    return;
  }
  const names = new Set<string>();
  value.forEach((entry, i) => {
    const p = `${path}[${i}]`;
    const g = c.object(entry, p);
    if (!g) return;
    c.onlyKeys(g, ["name", "argv", "finding_exit_codes", "env"], p);
    if (!isScheduleKebabId(g.name)) {
      c.fail(`${p}.name`, "must be kebab-case, 1 to 64 characters");
    } else if (names.has(g.name)) {
      c.fail(`${p}.name`, `"${g.name}" is used twice in this job`);
    } else {
      names.add(g.name);
    }
    checkArgv(c, g.argv, `${p}.argv`);
    if (g.finding_exit_codes !== undefined) {
      if (!Array.isArray(g.finding_exit_codes)) {
        c.fail(`${p}.finding_exit_codes`, "must be an array of exit codes");
      } else {
        const seen = new Set<number>();
        g.finding_exit_codes.forEach((code, j) => {
          if (c.integer(code, `${p}.finding_exit_codes[${j}]`, 1, 255)) {
            if (seen.has(code as number))
              c.fail(`${p}.finding_exit_codes[${j}]`, "is listed twice");
            seen.add(code as number);
          }
        });
      }
    }
    if (g.env !== undefined) {
      if (!Array.isArray(g.env)) {
        c.fail(`${p}.env`, "must be an array of variable names");
      } else {
        const seen = new Set<string>();
        g.env.forEach((name, j) => {
          if (typeof name !== "string" || !ENV_NAME.test(name)) {
            c.fail(
              `${p}.env[${j}]`,
              "must be a variable name (letters, digits, underscore), not a value",
            );
          } else if (seen.has(name)) {
            c.fail(`${p}.env[${j}]`, "is listed twice");
          } else {
            seen.add(name);
          }
        });
      }
    }
  });
}

function checkAgent(c: ScheduleFieldChecker, value: unknown, path: string): void {
  const a = c.object(value, path);
  if (!a) return;
  c.onlyKeys(a, ["adapter", "model", "effort", "prompt"], path);
  c.string(a.adapter, `${path}.adapter`);
  c.string(a.model, `${path}.model`, { optional: true });
  c.string(a.effort, `${path}.effort`, { optional: true });
  c.string(a.prompt, `${path}.prompt`);
}

const JOB_KEYS = [
  "id",
  "title",
  "description",
  "host",
  "trigger",
  "timeout_minutes",
  "max_launches_per_day",
  "owner",
  "enabled",
  "gather",
  "agent",
] as const;

function checkJob(c: ScheduleFieldChecker, value: unknown, path: string): void {
  const j = c.object(value, path);
  if (!j) return;
  c.onlyKeys(j, JOB_KEYS, path);
  if (!isScheduleKebabId(j.id)) c.fail(`${path}.id`, "must be kebab-case, 1 to 64 characters");
  c.string(j.title, `${path}.title`);
  c.string(j.description, `${path}.description`, { optional: true });
  c.string(j.host, `${path}.host`);
  checkJobTrigger(c, j.trigger, `${path}.trigger`);
  c.integer(j.timeout_minutes, `${path}.timeout_minutes`, 1, SCHEDULE_TIMEOUT_MINUTES_MAX);
  c.integer(
    j.max_launches_per_day,
    `${path}.max_launches_per_day`,
    1,
    SCHEDULE_LAUNCHES_PER_DAY_MAX,
  );
  c.string(j.owner, `${path}.owner`, { optional: true });
  c.boolean(j.enabled, `${path}.enabled`, { optional: true });
  if (j.gather !== undefined) checkGather(c, j.gather, `${path}.gather`);
  if (j.agent !== undefined) checkAgent(c, j.agent, `${path}.agent`);
  if (j.gather === undefined && j.agent === undefined) {
    c.fail(path, "needs gather commands, an agent, or both");
  }
}

/** Validate one job. */
export function validateScheduleJob(value: unknown): ScheduleValidation<ScheduleJob> {
  const c = new ScheduleFieldChecker();
  checkJob(c, value, "job");
  return c.result(value);
}

/** Validate a parsed job file: version, every job, and unique ids. */
export function validateScheduleJobFile(value: unknown): ScheduleValidation<ScheduleJobFile> {
  const c = new ScheduleFieldChecker();
  const f = c.object(value, "file");
  if (!f) return c.result(value);
  c.onlyKeys(f, ["version", "jobs"], "file");
  c.literal(f.version, SCHEDULE_JOB_FILE_VERSION, "file.version");
  if (!Array.isArray(f.jobs)) {
    c.fail("file.jobs", "must be an array");
    return c.result(value);
  }
  const ids = new Set<string>();
  f.jobs.forEach((job, i) => {
    checkJob(c, job, `file.jobs[${i}]`);
    const id = (job as { id?: unknown } | null)?.id;
    if (isScheduleKebabId(id)) {
      if (ids.has(id)) c.fail(`file.jobs[${i}].id`, `"${id}" is used by another job`);
      ids.add(id);
    }
  });
  return c.result(value);
}

/** Parse and validate the job file's JSONC text. */
export function parseScheduleJobFileText(text: string): ScheduleValidation<ScheduleJobFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (error) {
    return {
      ok: false,
      errors: [`file: is not valid JSON with comments (${(error as Error).message})`],
    };
  }
  return validateScheduleJobFile(parsed);
}

// ---------------------------------------------------------------------------
// Execution fields and the enrollment hash
// ---------------------------------------------------------------------------

/** Values resolved on the enrolling machine that also pin a job. */
export interface ScheduleJobResolution {
  /** The resolved absolute path of each gather command's `argv[0]`, in gather order. */
  executables: readonly string[];
  /** The zone from `resolveTimeZone()`. */
  zone: string;
}

/** The canonical execution fields of a job. Title, description, owner, enabled and comments are excluded. */
export interface ScheduleJobExecutionFields {
  gather: {
    name: string;
    argv: string[];
    finding_exit_codes: number[];
    env: string[];
    executable: string;
  }[];
  agent: { adapter: string; model: string | null; effort: string | null; prompt: string } | null;
  trigger: ScheduleJobTrigger;
  zone: string;
  host: string;
  timeout_minutes: number;
  max_launches_per_day: number;
}

/**
 * The fields enrollment pins. Optional lists are normalised (absent is the
 * same as empty; exit codes and variable names are sorted) so an equivalent
 * rewrite does not stop a job. `argv` order is kept. Throws when
 * `resolved.executables` does not have one path per gather command, which is
 * a caller bug.
 */
export function scheduleJobExecutionFields(
  job: ScheduleJob,
  resolved: ScheduleJobResolution,
): ScheduleJobExecutionFields {
  const gather = job.gather ?? [];
  if (resolved.executables.length !== gather.length) {
    throw new Error(
      `scheduleJobExecutionFields: ${gather.length} gather commands but ${resolved.executables.length} resolved executables`,
    );
  }
  return {
    gather: gather.map((g, i) => ({
      name: g.name,
      argv: [...g.argv],
      finding_exit_codes: [...(g.finding_exit_codes ?? [])].sort((a, b) => a - b),
      env: [...(g.env ?? [])].sort(),
      executable: resolved.executables[i] as string,
    })),
    agent: job.agent
      ? {
          adapter: job.agent.adapter,
          model: job.agent.model ?? null,
          effort: job.agent.effort ?? null,
          prompt: job.agent.prompt,
        }
      : null,
    trigger: { ...job.trigger },
    zone: resolved.zone,
    host: job.host,
    timeout_minutes: job.timeout_minutes,
    max_launches_per_day: job.max_launches_per_day,
  };
}

/** sha256 hex of the canonical (sorted-key) JSON of the execution fields. */
export function hashScheduleJob(job: ScheduleJob, resolved: ScheduleJobResolution): string {
  return stableDigest(scheduleJobExecutionFields(job, resolved));
}

// ---------------------------------------------------------------------------
// Private runtime records under `.harnery/private/schedule/`
// ---------------------------------------------------------------------------

/** `enrollments/<job>.json`: this machine may run the job as hashed. */
export interface ScheduleEnrollment {
  schema_version: 1;
  job_id: string;
  /** `hashScheduleJob` at enrollment; any difference stops the job until it is enrolled again. */
  job_hash: string;
  /** `resolveMachineLabel()` at enrollment. */
  machine: string;
  /** The checkout's real path (`realpathSync`) at enrollment. */
  checkout: string;
  /** Nothing due before this instant ever runs; `every` counts from it. */
  enrolled_at: string;
  /** Agent name or person that enrolled it. */
  enrolled_by?: string;
}

export type ScheduleClaimKind = "scheduled" | "catch-up" | "manual";

/**
 * - `claimed`: created, not yet launched. A claim with no start is retried once.
 * - `started`: launched. One that started and never finished is reported as
 *   uncertain and never rerun silently.
 * - `finished`: the run record exists.
 * - `abandoned`: given up (a second failure to start, or a refused launch).
 */
export type ScheduleClaimState = "claimed" | "started" | "finished" | "abandoned";

/**
 * `claims/<job>/<scheduleClaimFileName>`: permanent, created exclusively,
 * never deleted. A manual run gets its own `scheduled_for` (the request time).
 */
export interface ScheduleClaim {
  schema_version: 1;
  job_id: string;
  /** The due instant, in UTC `toISOString()` form. */
  scheduled_for: string;
  kind: ScheduleClaimKind;
  state: ScheduleClaimState;
  claimed_at: string;
  started_at?: string;
  finished_at?: string;
  pid?: number;
  /** Opaque and unique per claim (the tick mints it); names the run in reports. */
  run_id: string;
}

/** A compact, skipped stretch of due times. */
export interface ScheduleSkippedRange {
  from: string;
  to: string;
  count: number;
}

/** `cursors/<job>.json`: stops later ticks from walking the backlog again. */
export interface ScheduleCursor {
  schema_version: 1;
  job_id: string;
  /** Due times at or before this instant have been considered. */
  last_considered: string;
  /** At most `SCHEDULE_SKIPPED_RANGES_KEPT`, oldest first; the newest are kept. */
  skipped: ScheduleSkippedRange[];
}

/** `heartbeat.json`: written by every tick, read by the cue and doctor before any catch-up. */
export interface ScheduleHeartbeat {
  schema_version: 1;
  last_tick_at: string;
  last_tick_status: "ok" | "error";
  /** One line; set when the last tick errored. */
  last_tick_error?: string;
  /** The newest tick that ended `ok`. */
  last_ok_at?: string;
  /** What called the tick. */
  source: "timer" | "activity" | "manual";
  /**
   * The newest tick the installed timer made. Every tick carries it forward,
   * so an activity or manual tick never hides a timer that stopped. The timer
   * is overdue when this is older than twice the installed interval.
   */
  last_timer_tick_at?: string;
  /** The interval of the timer tick that set `last_timer_tick_at`. */
  timer_interval_minutes?: number;
}

/**
 * `timer.json`: written by `schedule install`, removed by `uninstall`. Its
 * presence means this checkout expects a timer; the cue and doctor compare it
 * with the heartbeat's `last_timer_tick_at`.
 */
export interface ScheduleTimerInstall {
  schema_version: 1;
  installed_at: string;
  interval_minutes: number;
  /** The timer unit's name, for example `harnery-schedule-<id>.timer`. */
  unit: string;
  /** The exact command line the unit runs, as an argument list. */
  command: string[];
}

/**
 * One gather command's outcome.
 * - `ok`: exit 0 and output within the cap.
 * - `finding`: an exit code the job lists in `finding_exit_codes`.
 * - `error`: timeout, could not start, an unexpected exit code, or truncated
 *   output (`truncated` true).
 */
export interface ScheduleGatherResult {
  name: string;
  state: "ok" | "finding" | "error";
  exit_code: number | null;
  duration_ms: number;
  truncated: boolean;
  error?: string;
  /** Relative to the run folder: `gather/<name>.txt`. */
  output_file: string;
}

export type ScheduleRunResult = "ok" | "attention" | "failed";

/** The agent's outcome. `status_line` comes from `parseScheduleStatusLine`. */
export interface ScheduleAgentOutcome {
  adapter: string;
  /** False when the agent could not start, timed out, or exited with an error. */
  ok: boolean;
  status_line: "ok" | "attention" | "missing";
  error?: string;
}

/** `runs/<job>/<stamp>/run.json`, beside `report.md`. Written by Harnery, not the agent. */
export interface ScheduleRunRecord {
  schema_version: 1;
  run_id: string;
  job_id: string;
  scheduled_for: string;
  kind: ScheduleClaimKind;
  started_at: string;
  finished_at: string;
  result: ScheduleRunResult;
  gather: ScheduleGatherResult[];
  /** Null for a gather-only job. */
  agent: ScheduleAgentOutcome | null;
  /** Relative to the run folder: `report.md`. */
  report_file: string;
}

/**
 * The run's result. Any gather `error` or an agent that is not ok makes it
 * `failed`; otherwise any `finding`, or an agent status of `attention` or
 * `missing`, makes it `attention`; otherwise `ok`. The agent can never clear
 * a finding or an error.
 */
export function resolveScheduleRunResult(
  gather: readonly Pick<ScheduleGatherResult, "state">[],
  agent: Pick<ScheduleAgentOutcome, "ok" | "status_line"> | null,
): ScheduleRunResult {
  if (gather.some((g) => g.state === "error") || (agent !== null && !agent.ok)) return "failed";
  if (gather.some((g) => g.state === "finding")) return "attention";
  if (agent !== null && agent.status_line !== "ok") return "attention";
  return "ok";
}

/**
 * The agent's verdict from its final message: the first non-empty line must
 * be `STATUS: ok` or `STATUS: attention` (the value in any case). Anything
 * else is `missing`, which the run treats as attention.
 */
export function parseScheduleStatusLine(text: string): "ok" | "attention" | "missing" {
  const first = text.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (first === undefined) return "missing";
  const m = /^STATUS:\s*(ok|attention)$/i.exec(first.trim());
  if (!m) return "missing";
  return (m[1] as string).toLowerCase() === "ok" ? "ok" : "attention";
}

// ---------------------------------------------------------------------------
// The tick to run-module contract
// ---------------------------------------------------------------------------

/** What the tick (track H) hands the run module (track I) for one claimed run. */
export interface ScheduleLaunchRequest {
  job: ScheduleJob;
  enrollment: ScheduleEnrollment;
  /** Already `started` by the tick. */
  claim: ScheduleClaim;
  coordRoot: string;
  /** ISO instant; one deadline for gather and agent together. */
  deadline_at: string;
}

export interface ScheduleLaunchResult {
  record: ScheduleRunRecord;
}

/**
 * The run module's entry point type. Track I exports
 * `launchScheduledJob(request, deps?)`, which satisfies this; the tick
 * depends on the type and tests inject a fake. It resolves with a record even
 * when the run fails; it rejects only on a bug.
 */
export type ScheduleLauncher = (request: ScheduleLaunchRequest) => Promise<ScheduleLaunchResult>;

// ---------------------------------------------------------------------------
// Colon-free time stamps for file and folder names
// ---------------------------------------------------------------------------

const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/;

/**
 * A colon-free UTC stamp such as `20260101T060000000Z`, safe on Windows and
 * sorting in time order. Throws on an invalid instant.
 */
export function scheduleTimeStamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!isScheduleIsoInstant(iso) || !Number.isFinite(ms)) {
    throw new Error(`scheduleTimeStamp: not an ISO instant: ${iso}`);
  }
  return new Date(ms).toISOString().replace(/[-:.]/g, "");
}

/** The inverse of `scheduleTimeStamp`: a UTC `toISOString()` string, or null. */
export function parseScheduleTimeStamp(stamp: string): string | null {
  const m = STAMP.exec(stamp);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== iso) return null;
  return iso;
}

/**
 * The claim's file name: `<job_id>_<stamp>.json`. Job ids are kebab-case, so
 * the underscore separates unambiguously. Throws on a bad id or instant.
 */
export function scheduleClaimFileName(job_id: string, scheduled_for: string): string {
  if (!isScheduleKebabId(job_id)) throw new Error(`scheduleClaimFileName: bad job id: ${job_id}`);
  return `${job_id}_${scheduleTimeStamp(scheduled_for)}.json`;
}

/** The inverse of `scheduleClaimFileName`, or null for any other name. */
export function parseScheduleClaimFileName(
  name: string,
): { job_id: string; scheduled_for: string } | null {
  const m = /^([a-z0-9-]+)_(\d{8}T\d{9}Z)\.json$/.exec(name);
  if (!m || !isScheduleKebabId(m[1])) return null;
  const scheduled_for = parseScheduleTimeStamp(m[2] as string);
  return scheduled_for ? { job_id: m[1] as string, scheduled_for } : null;
}

// ---------------------------------------------------------------------------
// Validators for the private records, for readers of those files
// ---------------------------------------------------------------------------

const CLAIM_KINDS: readonly ScheduleClaimKind[] = ["scheduled", "catch-up", "manual"];
const CLAIM_STATES: readonly ScheduleClaimState[] = ["claimed", "started", "finished", "abandoned"];

export function validateScheduleEnrollment(value: unknown): ScheduleValidation<ScheduleEnrollment> {
  const c = new ScheduleFieldChecker();
  const e = c.object(value, "enrollment");
  if (!e) return c.result(value);
  c.onlyKeys(
    e,
    ["schema_version", "job_id", "job_hash", "machine", "checkout", "enrolled_at", "enrolled_by"],
    "enrollment",
  );
  c.literal(e.schema_version, 1, "enrollment.schema_version");
  if (!isScheduleKebabId(e.job_id)) c.fail("enrollment.job_id", "must be a kebab-case job id");
  if (typeof e.job_hash !== "string" || !/^[0-9a-f]{64}$/.test(e.job_hash)) {
    c.fail("enrollment.job_hash", "must be a sha256 hex string");
  }
  c.string(e.machine, "enrollment.machine");
  c.string(e.checkout, "enrollment.checkout");
  c.instant(e.enrolled_at, "enrollment.enrolled_at");
  c.string(e.enrolled_by, "enrollment.enrolled_by", { optional: true });
  return c.result(value);
}

export function validateScheduleClaim(value: unknown): ScheduleValidation<ScheduleClaim> {
  const c = new ScheduleFieldChecker();
  const k = c.object(value, "claim");
  if (!k) return c.result(value);
  c.onlyKeys(
    k,
    [
      "schema_version",
      "job_id",
      "scheduled_for",
      "kind",
      "state",
      "claimed_at",
      "started_at",
      "finished_at",
      "pid",
      "run_id",
    ],
    "claim",
  );
  c.literal(k.schema_version, 1, "claim.schema_version");
  if (!isScheduleKebabId(k.job_id)) c.fail("claim.job_id", "must be a kebab-case job id");
  c.instant(k.scheduled_for, "claim.scheduled_for");
  c.oneOf(k.kind, CLAIM_KINDS, "claim.kind");
  c.oneOf(k.state, CLAIM_STATES, "claim.state");
  c.instant(k.claimed_at, "claim.claimed_at");
  c.instant(k.started_at, "claim.started_at", { optional: true });
  c.instant(k.finished_at, "claim.finished_at", { optional: true });
  c.integer(k.pid, "claim.pid", 1, Number.MAX_SAFE_INTEGER, { optional: true });
  c.string(k.run_id, "claim.run_id");
  return c.result(value);
}

export function validateScheduleCursor(value: unknown): ScheduleValidation<ScheduleCursor> {
  const c = new ScheduleFieldChecker();
  const k = c.object(value, "cursor");
  if (!k) return c.result(value);
  c.onlyKeys(k, ["schema_version", "job_id", "last_considered", "skipped"], "cursor");
  c.literal(k.schema_version, 1, "cursor.schema_version");
  if (!isScheduleKebabId(k.job_id)) c.fail("cursor.job_id", "must be a kebab-case job id");
  c.instant(k.last_considered, "cursor.last_considered");
  if (!Array.isArray(k.skipped)) {
    c.fail("cursor.skipped", "must be an array");
  } else {
    if (k.skipped.length > SCHEDULE_SKIPPED_RANGES_KEPT) {
      c.fail("cursor.skipped", `must hold at most ${SCHEDULE_SKIPPED_RANGES_KEPT} ranges`);
    }
    k.skipped.forEach((range, i) => {
      const p = `cursor.skipped[${i}]`;
      const r = c.object(range, p);
      if (!r) return;
      c.onlyKeys(r, ["from", "to", "count"], p);
      c.instant(r.from, `${p}.from`);
      c.instant(r.to, `${p}.to`);
      c.integer(r.count, `${p}.count`, 1, Number.MAX_SAFE_INTEGER);
    });
  }
  return c.result(value);
}

export function validateScheduleHeartbeat(value: unknown): ScheduleValidation<ScheduleHeartbeat> {
  const c = new ScheduleFieldChecker();
  const h = c.object(value, "heartbeat");
  if (!h) return c.result(value);
  c.onlyKeys(
    h,
    [
      "schema_version",
      "last_tick_at",
      "last_tick_status",
      "last_tick_error",
      "last_ok_at",
      "source",
      "last_timer_tick_at",
      "timer_interval_minutes",
    ],
    "heartbeat",
  );
  c.literal(h.schema_version, 1, "heartbeat.schema_version");
  c.instant(h.last_tick_at, "heartbeat.last_tick_at");
  c.oneOf(h.last_tick_status, ["ok", "error"] as const, "heartbeat.last_tick_status");
  if (h.last_tick_error !== undefined && typeof h.last_tick_error !== "string") {
    c.fail("heartbeat.last_tick_error", "must be a string");
  }
  c.instant(h.last_ok_at, "heartbeat.last_ok_at", { optional: true });
  c.oneOf(h.source, ["timer", "activity", "manual"] as const, "heartbeat.source");
  c.instant(h.last_timer_tick_at, "heartbeat.last_timer_tick_at", { optional: true });
  c.integer(h.timer_interval_minutes, "heartbeat.timer_interval_minutes", 1, 1440, {
    optional: true,
  });
  return c.result(value);
}

export function validateScheduleTimerInstall(
  value: unknown,
): ScheduleValidation<ScheduleTimerInstall> {
  const c = new ScheduleFieldChecker();
  const t = c.object(value, "timer");
  if (!t) return c.result(value);
  c.onlyKeys(t, ["schema_version", "installed_at", "interval_minutes", "unit", "command"], "timer");
  c.literal(t.schema_version, 1, "timer.schema_version");
  c.instant(t.installed_at, "timer.installed_at");
  c.integer(t.interval_minutes, "timer.interval_minutes", 1, 1440);
  c.string(t.unit, "timer.unit");
  if (
    !Array.isArray(t.command) ||
    t.command.length === 0 ||
    t.command.some((part) => typeof part !== "string" || part.length === 0)
  ) {
    c.fail("timer.command", "must be a non-empty list of strings");
  }
  return c.result(value);
}

export function validateScheduleRunRecord(value: unknown): ScheduleValidation<ScheduleRunRecord> {
  const c = new ScheduleFieldChecker();
  const r = c.object(value, "run");
  if (!r) return c.result(value);
  c.onlyKeys(
    r,
    [
      "schema_version",
      "run_id",
      "job_id",
      "scheduled_for",
      "kind",
      "started_at",
      "finished_at",
      "result",
      "gather",
      "agent",
      "report_file",
    ],
    "run",
  );
  c.literal(r.schema_version, 1, "run.schema_version");
  c.string(r.run_id, "run.run_id");
  if (!isScheduleKebabId(r.job_id)) c.fail("run.job_id", "must be a kebab-case job id");
  c.instant(r.scheduled_for, "run.scheduled_for");
  c.oneOf(r.kind, CLAIM_KINDS, "run.kind");
  c.instant(r.started_at, "run.started_at");
  c.instant(r.finished_at, "run.finished_at");
  c.oneOf(r.result, ["ok", "attention", "failed"] as const, "run.result");
  if (!Array.isArray(r.gather)) {
    c.fail("run.gather", "must be an array");
  } else {
    r.gather.forEach((entry, i) => {
      const p = `run.gather[${i}]`;
      const g = c.object(entry, p);
      if (!g) return;
      c.onlyKeys(
        g,
        ["name", "state", "exit_code", "duration_ms", "truncated", "error", "output_file"],
        p,
      );
      if (!isScheduleKebabId(g.name)) c.fail(`${p}.name`, "must be a kebab-case name");
      c.oneOf(g.state, ["ok", "finding", "error"] as const, `${p}.state`);
      c.integer(g.exit_code, `${p}.exit_code`, -2_147_483_648, 4_294_967_295, { nullable: true });
      c.integer(g.duration_ms, `${p}.duration_ms`, 0, Number.MAX_SAFE_INTEGER);
      c.boolean(g.truncated, `${p}.truncated`);
      if (g.error !== undefined && typeof g.error !== "string")
        c.fail(`${p}.error`, "must be a string");
      c.string(g.output_file, `${p}.output_file`);
    });
  }
  if (r.agent !== null) {
    const a = c.object(r.agent, "run.agent");
    if (a) {
      c.onlyKeys(a, ["adapter", "ok", "status_line", "error"], "run.agent");
      c.string(a.adapter, "run.agent.adapter");
      c.boolean(a.ok, "run.agent.ok");
      c.oneOf(a.status_line, ["ok", "attention", "missing"] as const, "run.agent.status_line");
      if (a.error !== undefined && typeof a.error !== "string")
        c.fail("run.agent.error", "must be a string");
    }
  }
  c.string(r.report_file, "run.report_file");
  return c.result(value);
}
