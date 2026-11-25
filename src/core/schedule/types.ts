/**
 * Stage 1 contract for schedules: one record shape for every schedule the
 * agent apps and the machine already hold, the reader interface that
 * produces them, and the observation a hook appends when an agent creates or
 * deletes a schedule through a tool call.
 *
 * This file is frozen for the tracks that build against it. It has no imports
 * so that `config.ts`, readers, commands and the dashboard can all depend on it.
 */

/** Where a schedule record came from. */
export type ScheduleSource =
  /** T3 Code's own scheduled tasks (private store, read-only). */
  | "t3-code"
  /** The Codex app's automations (private store, read-only). */
  | "codex-app"
  /** The machine's own timers: systemd user timers and the user's crontab. */
  | "os-timer"
  /** A schedule no reader can see, known only from a captured tool call. */
  | "captured"
  /** A job from Harnery's own scheduler (`.harnery/schedules.jsonc`). */
  | "harnery";

export const SCHEDULE_SOURCES: readonly ScheduleSource[] = [
  "t3-code",
  "codex-app",
  "os-timer",
  "captured",
  "harnery",
];

/**
 * The sources that have a reader (`captured` has none: observations stand in
 * for one). Every reader runs by default; an operator switches one off with
 * `schedule.disabledReaders` in any config layer (see `scheduleConfig`).
 */
export const SCHEDULE_READER_IDS = ["t3-code", "codex-app", "os-timer", "harnery"] as const;
export type ScheduleReaderId = (typeof SCHEDULE_READER_IDS)[number];

/**
 * When a schedule fires. `raw` always carries the source's own text for the
 * trigger (a cron line, an RRULE, a JSON fragment) so a person can check the
 * mapping; it never carries a prompt or command text.
 */
export type ScheduleTrigger =
  /** Fires once at `at` (ISO 8601 instant). */
  | { kind: "once"; at: string; raw: string }
  /** Fires every `everyMs` milliseconds (positive integer). */
  | { kind: "interval"; everyMs: number; raw: string }
  /** A 5-field cron expression; `zone` is an IANA zone when the source states one. */
  | { kind: "cron"; expr: string; zone?: string; raw: string }
  /** An RFC 5545 RRULE as the source stores it. */
  | { kind: "rrule"; rule: string; raw: string }
  /** Fires on an outside event (a webhook, a boot, a session); `description` says which. */
  | { kind: "event"; description: string; raw: string };

export type ScheduleTriggerKind = ScheduleTrigger["kind"];

/**
 * How the last run went. `attention` means it ran and reported something a
 * person should look at; `unknown` means the source records no outcome (for
 * example a crontab entry) or one Harnery cannot map.
 */
export type ScheduleRunStatus = "succeeded" | "failed" | "skipped" | "attention" | "unknown";

/** Where a schedule runs. */
export interface ScheduleRunsOn {
  /** Machine label (from `resolveMachineLabel()` for local sources). */
  host: string;
  /** The project the source binds it to, when the source knows it. */
  project?: string;
  /** The thread or session the source binds it to, when the source knows it. */
  thread?: string;
}

/** The last run, as the source reports it. */
export interface ScheduleLastRun {
  /** ISO instant of the run, or null when the source has a status without a time. */
  at: string | null;
  status: ScheduleRunStatus;
}

/** The Harnery session that created a schedule, when a hook saw the tool call. */
export interface ScheduleCreatedBy {
  instance_id: string;
  agent_name?: string;
  task?: string;
  /** ISO instant the hook observed the call. */
  observed_at: string;
}

/** One gather command of a Harnery job, exactly as the job file writes it. */
export interface ScheduleHarneryCommand {
  name: string;
  /** The argument list from the job file, unchanged. */
  argv: string[];
  /** Names of the environment variables passed through; never their values. */
  env: string[];
  /** Exit codes that mean "ran and found something"; empty when none are listed. */
  finding_exit_codes: number[];
}

/** The read-only judge agent of a Harnery job. */
export interface ScheduleHarneryAgent {
  adapter: string;
  /** Null when the job file leaves the model to the adapter's default. */
  model: string | null;
  /** Null when the job file leaves the effort to the adapter's default. */
  effort: string | null;
  /** The full prompt from the job file. */
  prompt: string;
}

/**
 * The state `checkScheduleEnrollment` reports for this machine and checkout.
 * Only `enrolled` runs; `changed` means the job's execution fields changed
 * after enrollment and it stays stopped until enrolled again.
 */
export type ScheduleHarneryEnrollmentState =
  | "enrolled"
  | "not-enrolled"
  | "changed"
  | "wrong-machine"
  | "wrong-checkout";

export interface ScheduleHarneryEnrollment {
  state: ScheduleHarneryEnrollmentState;
  /** The check's one-line reason; null when enrolled. */
  detail: string | null;
  /** ISO instant of the stored enrollment, when one exists. */
  enrolled_at: string | null;
}

/** The newest run of a Harnery job on this checkout. */
export interface ScheduleHarneryRun {
  run_id: string;
  kind: "scheduled" | "catch-up" | "manual";
  result: "ok" | "attention" | "failed";
  started_at: string;
  finished_at: string;
  duration_ms: number;
  /** Each gather command's outcome, in run order. */
  commands: { name: string; state: "ok" | "finding" | "error"; exit_code: number | null }[];
  /** Null for a run with no agent. */
  agent: { adapter: string; ok: boolean; status_line: "ok" | "attention" | "missing" } | null;
  /** The run's report file, relative to the checkout root; null when none was written. */
  report_path: string | null;
}

/**
 * What a Harnery job runs and how it stands here. Only the Harnery reader
 * sets it, from the project's own committed job file and this checkout's
 * enrollment and run records. It never carries environment values, gather
 * output or report text.
 */
export interface ScheduleHarneryJob {
  /** Gather commands in run order; empty for an agent-only job. */
  commands: ScheduleHarneryCommand[];
  /** Null when the job runs commands only and starts no agent. */
  agent: ScheduleHarneryAgent | null;
  enrollment: ScheduleHarneryEnrollment;
  /** The agent pinged when a run needs attention; null when none is named. */
  owner: string | null;
  timeout_minutes: number;
  max_launches_per_day: number;
  /** The time zone cron triggers are read in. */
  zone: string;
  latest_run: ScheduleHarneryRun | null;
}

/**
 * One schedule from one source.
 *
 * Records join on `source`, `account` and `id` (see `scheduleRecordKey`).
 *
 * A record carries schedule fields only. It must never carry inbox or report
 * text, a secret, a webhook token, or another app's prompt or command text (a
 * crontab line's command, a unit's ExecStart, an app automation's prompt).
 * Readers select named columns and fields so that text never leaves its
 * store. The one exception is `job`: a Harnery job's commands and agent
 * prompt come from the project's own committed job file (ADR 0280).
 */
export interface ScheduleRecord {
  source: ScheduleSource;
  /** The host or account the source belongs to (a machine label, an app account). */
  account: string;
  /** The source's own native id, unchanged. */
  id: string;
  /** The source's name for the schedule; never a prompt. */
  title: string;
  /**
   * What the schedule does, in the source's own words (a systemd unit's
   * Description=, a Harnery job's description). Absent when the source does
   * not say. Never a prompt or command text; a Harnery job's commands and
   * prompt are in `job` instead.
   */
  description?: string;
  trigger: ScheduleTrigger;
  runs_on: ScheduleRunsOn;
  /** As the source reports it; null when the source does not say. */
  enabled: boolean | null;
  /** ISO instant of the next run as the source reports it; null when unknown or none. */
  next_run_at: string | null;
  /** The newest run; null when the source records no run. */
  last_run: ScheduleLastRun | null;
  /** Null unless a captured observation names the creating session. */
  created_by: ScheduleCreatedBy | null;
  /** Set only on `source: "harnery"` records: what the job runs and how it stands here. */
  job?: ScheduleHarneryJob;
}

/**
 * How complete one source's answer is. Reported for every source on every
 * list, even when it returned no records, so a partial list is never read as
 * a complete one.
 *
 * - `current`: the reader read the live store.
 * - `stale`: the reader fell back to a copy that may lag (for example a
 *   config file instead of the database).
 * - `unreadable`: the store exists but could not be read (locked, no access,
 *   a copy failed).
 * - `unsupported`: the platform or the store's layout is one the reader does
 *   not know; it did not guess.
 * - `disabled`: a reader the operator switched off (`schedule.disabledReaders`).
 */
export type ScheduleCoverageState = "current" | "stale" | "unreadable" | "unsupported" | "disabled";

export interface ScheduleSourceCoverage {
  source: ScheduleSource;
  account: string;
  state: ScheduleCoverageState;
  /** One plain sentence on why, for anything other than `current`. Never store text. */
  detail?: string;
  /** ISO instant the reader ran. */
  read_at: string;
}

/** A reader's answer. `coverage` is always present, even with zero records. */
export interface ScheduleReadResult {
  coverage: ScheduleSourceCoverage;
  records: ScheduleRecord[];
}

/** The result of one command a reader runs through its context. */
export interface ScheduleCommandResult {
  /** Null when the process did not exit normally (killed, timed out, never started). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not start or timed out (for example "ENOENT"). */
  error?: string;
}

/**
 * Runs one command with literal arguments and no shell. The default
 * implementation sets `windowsHide: true`; tests inject a fake.
 */
export type ScheduleCommandRunner = (
  argv: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<ScheduleCommandResult>;

/**
 * Everything a reader may touch. Readers read the environment, the home
 * directory and the platform from here, never from `process` or `os`, so a
 * test can run one against a temporary directory with no real system access.
 */
export interface ScheduleReadContext {
  coordRoot: string;
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  platform: NodeJS.Platform;
  /** This machine's label; the default `account` and `runs_on.host` for local sources. */
  machine: string;
  /** Milliseconds since the epoch. */
  now: () => number;
  /** How the os-timer reader runs `systemctl` and `crontab`. */
  runCommand: ScheduleCommandRunner;
  /** A writable folder for copies of a store (the SQLite helper copies there). */
  tmpDir: string;
  /** Overrides a reader's store location (a database file or folder) for tests. */
  storePaths?: Partial<Record<ScheduleSource, string>>;
}

/**
 * A reader of one source. Registered in `core/schedule/registry.ts`.
 *
 * A reader never throws and never writes to the store it reads. It checks the
 * layout is one it knows and returns `unsupported` instead of guessing, and
 * returns `unreadable` when the store cannot be read.
 */
export interface ScheduleReader {
  id: ScheduleReaderId;
  read(ctx: ScheduleReadContext): Promise<ScheduleReadResult>;
}

/**
 * The tool families capture recognises, normalised across spellings
 * (`mcp__t3-code__schedule_task` from Claude Code and
 * `mcp__t3_code__schedule_task` from Codex both map to
 * `t3-code.schedule_task`).
 */
export type ScheduleObservationTool =
  | "t3-code.schedule_task"
  | "t3-code.delete_scheduled_task"
  | "claude-code.cron_create"
  | "claude-code.cron_delete"
  | "claude-code.remote_trigger";

export const SCHEDULE_OBSERVATION_TOOLS: readonly ScheduleObservationTool[] = [
  "t3-code.schedule_task",
  "t3-code.delete_scheduled_task",
  "claude-code.cron_create",
  "claude-code.cron_delete",
  "claude-code.remote_trigger",
];

export type ScheduleObservationOperation = "create" | "update" | "delete";

/**
 * One line of `.harnery/private/schedule/observed.jsonl`: an agent's tool
 * call that created, changed or deleted a schedule. It never carries the
 * prompt, the request body, or a webhook token.
 */
export interface ScheduleObservation {
  schema_version: 1;
  /** ISO instant the hook saw the finished tool call. */
  observed_at: string;
  instance_id: string;
  agent_name?: string;
  task?: string;
  tool: ScheduleObservationTool;
  operation: ScheduleObservationOperation;
  /** The id the tool returned or was given; null when the result carried none. */
  native_id: string | null;
  /** The schedule's title from the call, when it had one. Never the prompt. */
  title: string | null;
  trigger: ScheduleTrigger | null;
  /** True for an in-session timer that dies with its session (a CronCreate). */
  expires_with_session: boolean;
}

/**
 * The source an observed tool's schedules belong to. T3 Code tasks also have
 * a reader, so an observation can annotate its record; Claude Code's
 * schedules have no reader and appear as `captured` records.
 */
export function scheduleObservationSource(tool: ScheduleObservationTool): ScheduleSource {
  return tool.startsWith("t3-code.") ? "t3-code" : "captured";
}

/** The join key for records: source, account and id as one stable string. */
export function scheduleRecordKey(
  record: Pick<ScheduleRecord, "source" | "account" | "id">,
): string {
  return JSON.stringify([record.source, record.account, record.id]);
}

/** The `created_by` an observation contributes. */
export function scheduleCreatedByFromObservation(
  observation: ScheduleObservation,
): ScheduleCreatedBy {
  const out: ScheduleCreatedBy = {
    instance_id: observation.instance_id,
    observed_at: observation.observed_at,
  };
  if (observation.agent_name !== undefined) out.agent_name = observation.agent_name;
  if (observation.task !== undefined) out.task = observation.task;
  return out;
}

/**
 * Attach an observation's creator to a reader record. Pure: returns the same
 * record when the observation does not apply, or a copy with `created_by`
 * set. It applies when the observation is a create or update from the same
 * source with the same native id and the record has no creator yet; the
 * observation has no account, so the join here is source and id. Feed
 * observations oldest first, so the first creator wins.
 */
export function applyScheduleObservation(
  record: ScheduleRecord,
  observation: ScheduleObservation,
): ScheduleRecord {
  if (record.created_by !== null) return record;
  if (observation.operation === "delete") return record;
  if (observation.native_id === null || observation.native_id !== record.id) return record;
  if (scheduleObservationSource(observation.tool) !== record.source) return record;
  return { ...record, created_by: scheduleCreatedByFromObservation(observation) };
}

// ---------------------------------------------------------------------------
// Validation. Pure helpers shared by this file and job-types.ts. They collect
// every problem as "<path>: <message>" so a person can fix a file in one pass.
// ---------------------------------------------------------------------------

/** The result every schedule validator returns. */
export type ScheduleValidation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** An ISO 8601 date-time with an explicit `Z` or offset that parses to a real instant. */
export function isScheduleIsoInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * Field checks that record errors instead of throwing. Internal to the
 * schedule module; exported only so job-types.ts shares one implementation.
 */
export class ScheduleFieldChecker {
  readonly errors: string[] = [];

  fail(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }

  object(value: unknown, path: string): Record<string, unknown> | null {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    this.fail(path, "must be an object");
    return null;
  }

  /** Report keys outside `allowed`, so a typo in a field name is caught. */
  onlyKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) this.fail(`${path}.${key}`, "is not a known field");
    }
  }

  string(value: unknown, path: string, opts: { optional?: boolean } = {}): boolean {
    if (value === undefined && opts.optional) return true;
    if (typeof value === "string" && value.trim().length > 0) return true;
    this.fail(
      path,
      opts.optional ? "must be a non-empty string when set" : "must be a non-empty string",
    );
    return false;
  }

  nullableString(value: unknown, path: string): boolean {
    if (value === null) return true;
    if (typeof value === "string") return true;
    this.fail(path, "must be a string or null");
    return false;
  }

  boolean(
    value: unknown,
    path: string,
    opts: { optional?: boolean; nullable?: boolean } = {},
  ): boolean {
    if (value === undefined && opts.optional) return true;
    if (value === null && opts.nullable) return true;
    if (typeof value === "boolean") return true;
    this.fail(path, opts.nullable ? "must be true, false or null" : "must be true or false");
    return false;
  }

  integer(
    value: unknown,
    path: string,
    min: number,
    max: number,
    opts: { optional?: boolean; nullable?: boolean } = {},
  ): boolean {
    if (value === undefined && opts.optional) return true;
    if (value === null && opts.nullable) return true;
    if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) {
      return true;
    }
    this.fail(path, `must be a whole number from ${min} to ${max}`);
    return false;
  }

  instant(
    value: unknown,
    path: string,
    opts: { optional?: boolean; nullable?: boolean } = {},
  ): boolean {
    if (value === undefined && opts.optional) return true;
    if (value === null && opts.nullable) return true;
    if (isScheduleIsoInstant(value)) return true;
    this.fail(
      path,
      "must be an ISO 8601 date-time with Z or an offset, such as 2026-01-01T06:00:00Z",
    );
    return false;
  }

  oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): value is T {
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return true;
    this.fail(path, `must be one of ${allowed.map((v) => `"${v}"`).join(", ")}`);
    return false;
  }

  literal(value: unknown, expected: number | string, path: string): boolean {
    if (value === expected) return true;
    this.fail(path, `must be ${JSON.stringify(expected)}`);
    return false;
  }

  result<T>(value: unknown): ScheduleValidation<T> {
    return this.errors.length === 0
      ? { ok: true, value: value as T }
      : { ok: false, errors: [...this.errors] };
  }
}

const TRIGGER_KINDS: readonly ScheduleTriggerKind[] = [
  "once",
  "interval",
  "cron",
  "rrule",
  "event",
];

function checkTrigger(c: ScheduleFieldChecker, value: unknown, path: string): void {
  const t = c.object(value, path);
  if (!t) return;
  if (!c.oneOf(t.kind, TRIGGER_KINDS, `${path}.kind`)) return;
  if (typeof t.raw !== "string") c.fail(`${path}.raw`, "must be a string");
  switch (t.kind) {
    case "once":
      c.onlyKeys(t, ["kind", "at", "raw"], path);
      c.instant(t.at, `${path}.at`);
      break;
    case "interval":
      c.onlyKeys(t, ["kind", "everyMs", "raw"], path);
      c.integer(t.everyMs, `${path}.everyMs`, 1, Number.MAX_SAFE_INTEGER);
      break;
    case "cron":
      c.onlyKeys(t, ["kind", "expr", "zone", "raw"], path);
      c.string(t.expr, `${path}.expr`);
      c.string(t.zone, `${path}.zone`, { optional: true });
      break;
    case "rrule":
      c.onlyKeys(t, ["kind", "rule", "raw"], path);
      c.string(t.rule, `${path}.rule`);
      break;
    case "event":
      c.onlyKeys(t, ["kind", "description", "raw"], path);
      c.string(t.description, `${path}.description`);
      break;
  }
}

/** Validate a trigger. */
export function validateScheduleTrigger(value: unknown): ScheduleValidation<ScheduleTrigger> {
  const c = new ScheduleFieldChecker();
  checkTrigger(c, value, "trigger");
  return c.result(value);
}

const RUN_STATUSES: readonly ScheduleRunStatus[] = [
  "succeeded",
  "failed",
  "skipped",
  "attention",
  "unknown",
];

function checkCreatedBy(c: ScheduleFieldChecker, value: unknown, path: string): void {
  if (value === null) return;
  const cb = c.object(value, path);
  if (!cb) return;
  c.onlyKeys(cb, ["instance_id", "agent_name", "task", "observed_at"], path);
  c.string(cb.instance_id, `${path}.instance_id`);
  c.string(cb.agent_name, `${path}.agent_name`, { optional: true });
  if (cb.task !== undefined && typeof cb.task !== "string")
    c.fail(`${path}.task`, "must be a string");
  c.instant(cb.observed_at, `${path}.observed_at`);
}

/** Validate a record, including the rule that it holds schedule fields only. */
export function validateScheduleRecord(value: unknown): ScheduleValidation<ScheduleRecord> {
  const c = new ScheduleFieldChecker();
  const r = c.object(value, "record");
  if (!r) return c.result(value);
  c.onlyKeys(
    r,
    [
      "source",
      "account",
      "id",
      "title",
      "description",
      "trigger",
      "runs_on",
      "enabled",
      "next_run_at",
      "last_run",
      "created_by",
      "job",
    ],
    "record",
  );
  c.oneOf(r.source, SCHEDULE_SOURCES, "record.source");
  c.string(r.account, "record.account");
  c.string(r.id, "record.id");
  if (typeof r.title !== "string") c.fail("record.title", "must be a string");
  c.string(r.description, "record.description", { optional: true });
  checkTrigger(c, r.trigger, "record.trigger");
  const runsOn = c.object(r.runs_on, "record.runs_on");
  if (runsOn) {
    c.onlyKeys(runsOn, ["host", "project", "thread"], "record.runs_on");
    c.string(runsOn.host, "record.runs_on.host");
    c.string(runsOn.project, "record.runs_on.project", { optional: true });
    c.string(runsOn.thread, "record.runs_on.thread", { optional: true });
  }
  c.boolean(r.enabled, "record.enabled", { nullable: true });
  c.instant(r.next_run_at, "record.next_run_at", { nullable: true });
  if (r.last_run !== null) {
    const lr = c.object(r.last_run, "record.last_run");
    if (lr) {
      c.onlyKeys(lr, ["at", "status"], "record.last_run");
      c.instant(lr.at, "record.last_run.at", { nullable: true });
      c.oneOf(lr.status, RUN_STATUSES, "record.last_run.status");
    }
  }
  checkCreatedBy(c, r.created_by, "record.created_by");
  if (r.job !== undefined) {
    if (r.source !== "harnery") c.fail("record.job", "is set only on harnery records");
    else checkHarneryJob(c, r.job, "record.job");
  }
  return c.result(value);
}

const ENROLLMENT_STATES: readonly ScheduleHarneryEnrollmentState[] = [
  "enrolled",
  "not-enrolled",
  "changed",
  "wrong-machine",
  "wrong-checkout",
];

function checkStringList(c: ScheduleFieldChecker, value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    c.fail(path, "must be a list");
    return;
  }
  value.forEach((v, i) => {
    if (typeof v !== "string") c.fail(`${path}[${i}]`, "must be a string");
  });
}

function checkHarneryJob(c: ScheduleFieldChecker, value: unknown, path: string): void {
  const j = c.object(value, path);
  if (!j) return;
  c.onlyKeys(
    j,
    [
      "commands",
      "agent",
      "enrollment",
      "owner",
      "timeout_minutes",
      "max_launches_per_day",
      "zone",
      "latest_run",
    ],
    path,
  );
  if (!Array.isArray(j.commands)) c.fail(`${path}.commands`, "must be a list");
  else
    j.commands.forEach((cmd, i) => {
      const p = `${path}.commands[${i}]`;
      const o = c.object(cmd, p);
      if (!o) return;
      c.onlyKeys(o, ["name", "argv", "env", "finding_exit_codes"], p);
      c.string(o.name, `${p}.name`);
      checkStringList(c, o.argv, `${p}.argv`);
      checkStringList(c, o.env, `${p}.env`);
      if (!Array.isArray(o.finding_exit_codes)) c.fail(`${p}.finding_exit_codes`, "must be a list");
      else
        o.finding_exit_codes.forEach((code, k) => {
          c.integer(code, `${p}.finding_exit_codes[${k}]`, 1, 255);
        });
    });
  if (j.agent !== null) {
    const a = c.object(j.agent, `${path}.agent`);
    if (a) {
      c.onlyKeys(a, ["adapter", "model", "effort", "prompt"], `${path}.agent`);
      c.string(a.adapter, `${path}.agent.adapter`);
      c.nullableString(a.model, `${path}.agent.model`);
      c.nullableString(a.effort, `${path}.agent.effort`);
      if (typeof a.prompt !== "string") c.fail(`${path}.agent.prompt`, "must be a string");
    }
  }
  const e = c.object(j.enrollment, `${path}.enrollment`);
  if (e) {
    c.onlyKeys(e, ["state", "detail", "enrolled_at"], `${path}.enrollment`);
    c.oneOf(e.state, ENROLLMENT_STATES, `${path}.enrollment.state`);
    c.nullableString(e.detail, `${path}.enrollment.detail`);
    c.instant(e.enrolled_at, `${path}.enrollment.enrolled_at`, { nullable: true });
  }
  c.nullableString(j.owner, `${path}.owner`);
  c.integer(j.timeout_minutes, `${path}.timeout_minutes`, 1, Number.MAX_SAFE_INTEGER);
  c.integer(j.max_launches_per_day, `${path}.max_launches_per_day`, 1, Number.MAX_SAFE_INTEGER);
  c.string(j.zone, `${path}.zone`);
  if (j.latest_run !== null) checkHarneryRun(c, j.latest_run, `${path}.latest_run`);
}

function checkHarneryRun(c: ScheduleFieldChecker, value: unknown, path: string): void {
  const r = c.object(value, path);
  if (!r) return;
  c.onlyKeys(
    r,
    [
      "run_id",
      "kind",
      "result",
      "started_at",
      "finished_at",
      "duration_ms",
      "commands",
      "agent",
      "report_path",
    ],
    path,
  );
  c.string(r.run_id, `${path}.run_id`);
  c.oneOf(r.kind, ["scheduled", "catch-up", "manual"] as const, `${path}.kind`);
  c.oneOf(r.result, ["ok", "attention", "failed"] as const, `${path}.result`);
  c.instant(r.started_at, `${path}.started_at`);
  c.instant(r.finished_at, `${path}.finished_at`);
  c.integer(r.duration_ms, `${path}.duration_ms`, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(r.commands)) c.fail(`${path}.commands`, "must be a list");
  else
    r.commands.forEach((cmd, i) => {
      const p = `${path}.commands[${i}]`;
      const o = c.object(cmd, p);
      if (!o) return;
      c.onlyKeys(o, ["name", "state", "exit_code"], p);
      c.string(o.name, `${p}.name`);
      c.oneOf(o.state, ["ok", "finding", "error"] as const, `${p}.state`);
      c.integer(o.exit_code, `${p}.exit_code`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, {
        nullable: true,
      });
    });
  if (r.agent !== null) {
    const a = c.object(r.agent, `${path}.agent`);
    if (a) {
      c.onlyKeys(a, ["adapter", "ok", "status_line"], `${path}.agent`);
      c.string(a.adapter, `${path}.agent.adapter`);
      c.boolean(a.ok, `${path}.agent.ok`);
      c.oneOf(a.status_line, ["ok", "attention", "missing"] as const, `${path}.agent.status_line`);
    }
  }
  c.nullableString(r.report_path, `${path}.report_path`);
}

/** Whether `value` is a valid `ScheduleRecord`. */
export function isScheduleRecord(value: unknown): value is ScheduleRecord {
  return validateScheduleRecord(value).ok;
}

const COVERAGE_STATES: readonly ScheduleCoverageState[] = [
  "current",
  "stale",
  "unreadable",
  "unsupported",
  "disabled",
];

/** Validate a reader's whole answer: its coverage and every record. */
export function validateScheduleReadResult(value: unknown): ScheduleValidation<ScheduleReadResult> {
  const c = new ScheduleFieldChecker();
  const r = c.object(value, "result");
  if (!r) return c.result(value);
  c.onlyKeys(r, ["coverage", "records"], "result");
  const cov = c.object(r.coverage, "result.coverage");
  if (cov) {
    c.onlyKeys(cov, ["source", "account", "state", "detail", "read_at"], "result.coverage");
    c.oneOf(cov.source, SCHEDULE_SOURCES, "result.coverage.source");
    c.string(cov.account, "result.coverage.account");
    c.oneOf(cov.state, COVERAGE_STATES, "result.coverage.state");
    if (cov.detail !== undefined && typeof cov.detail !== "string") {
      c.fail("result.coverage.detail", "must be a string");
    }
    c.instant(cov.read_at, "result.coverage.read_at");
  }
  if (!Array.isArray(r.records)) {
    c.fail("result.records", "must be an array");
  } else {
    r.records.forEach((record, i) => {
      const v = validateScheduleRecord(record);
      if (!v.ok)
        for (const e of v.errors) c.errors.push(e.replace(/^record/, `result.records[${i}]`));
    });
  }
  return c.result(value);
}

/** Validate one line of `observed.jsonl` after `JSON.parse`. */
export function validateScheduleObservation(
  value: unknown,
): ScheduleValidation<ScheduleObservation> {
  const c = new ScheduleFieldChecker();
  const o = c.object(value, "observation");
  if (!o) return c.result(value);
  c.onlyKeys(
    o,
    [
      "schema_version",
      "observed_at",
      "instance_id",
      "agent_name",
      "task",
      "tool",
      "operation",
      "native_id",
      "title",
      "trigger",
      "expires_with_session",
    ],
    "observation",
  );
  c.literal(o.schema_version, 1, "observation.schema_version");
  c.instant(o.observed_at, "observation.observed_at");
  c.string(o.instance_id, "observation.instance_id");
  c.string(o.agent_name, "observation.agent_name", { optional: true });
  if (o.task !== undefined && typeof o.task !== "string")
    c.fail("observation.task", "must be a string");
  c.oneOf(o.tool, SCHEDULE_OBSERVATION_TOOLS, "observation.tool");
  c.oneOf(o.operation, ["create", "update", "delete"] as const, "observation.operation");
  c.nullableString(o.native_id, "observation.native_id");
  c.nullableString(o.title, "observation.title");
  if (o.trigger !== null) checkTrigger(c, o.trigger, "observation.trigger");
  c.boolean(o.expires_with_session, "observation.expires_with_session");
  return c.result(value);
}
