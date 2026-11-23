/**
 * The job subcommands of `schedule`: `add`, `enroll`, `pause`, `resume`,
 * `remove`, `run` and `history`. They edit the tracked job file
 * (`.harnery/schedules.jsonc`), pin a job to this machine, run it once now,
 * and list its past runs.
 *
 * No subcommand prints a job's prompt text. `enroll` shows its length and
 * first line only, so a prompt never lands in a list, a log or a history.
 */

import { readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import type { Command } from "commander";
import { defaultEmit, type EmitContext } from "../../commander.ts";
import { monorepoRoot } from "../../core/agents/coord-client.ts";
import { resolveBinName, resolveTimeZone } from "../../core/config.ts";
import {
  enrollScheduleJob,
  readScheduleEnrollment,
  removeScheduleEnrollment,
} from "../../core/schedule/enrollment.ts";
import {
  hashScheduleJob,
  isScheduleJobEnabled,
  isScheduleKebabId,
  SCHEDULE_JOB_FILE_VERSION,
  type ScheduleGatherCommand,
  type ScheduleJob,
  type ScheduleJobExecutionFields,
  type ScheduleJobFile,
  type ScheduleJobTrigger,
  type ScheduleLauncher,
  type ScheduleRunRecord,
  scheduleJobExecutionFields,
  validateScheduleJob,
} from "../../core/schedule/job-types.ts";
import {
  ensureScheduleJobFileTracked,
  findScheduleJob,
  loadScheduleJobFile,
  resolveScheduleJob,
  type SchedulePathLookup,
  writeScheduleJobFile,
} from "../../core/schedule/jobs.ts";
import { scheduleRunDir, scheduleRunStamp, scheduleStateDir } from "../../core/schedule/paths.ts";
import { listScheduleRuns } from "../../core/schedule/report.ts";
import {
  type ManualScheduleRunOptions,
  type ManualScheduleRunResult,
  runScheduleJobManually,
} from "../../core/schedule/tick.ts";
import { writePrivateJsonAtomic } from "../../core/storage/atomic-json.ts";
import { stableDigest } from "../../core/storage/durable-record.ts";
import { resolveMachineLabel } from "../../lib/machine.ts";

/** Exit codes shared by the job subcommands. */
export const SCHEDULE_JOBS_EXIT = {
  ok: 0,
  /** Invalid input, an unknown job, or a refused change. */
  refused: 1,
  /** `run`: the run finished and needs attention. */
  attention: 3,
  /** `run`: the run finished and failed. */
  failed: 4,
  /** `run`: the run was refused before it started. */
  runRefused: 5,
} as const;

/** Defaults for `add` when the option is not given. */
const DEFAULT_TIMEOUT_MINUTES = 30;
const DEFAULT_LAUNCHES_PER_DAY = 24;

/** Test seams; every field defaults to the real thing. */
export interface ScheduleJobsCommandDeps {
  emit?: EmitContext;
  coordRoot?: () => string | null;
  machine?: () => string;
  now?: () => Date;
  env?: Readonly<Record<string, string | undefined>>;
  pathLookup?: SchedulePathLookup;
  /** The machine-wide enrollment registry directory. */
  registryDir?: string;
  runManually?: (opts: ManualScheduleRunOptions) => Promise<ManualScheduleRunResult>;
  launcher?: ScheduleLauncher;
}

interface Ctx {
  emit: EmitContext;
  deps: ScheduleJobsCommandDeps;
  bin: string;
}

class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: string[] = [],
    readonly exitCode: number = SCHEDULE_JOBS_EXIT.refused,
  ) {
    super(message);
  }
}

function refuse(ctx: Ctx, error: unknown): void {
  if (error instanceof Refusal) {
    const hint = error.details.length > 0 ? error.details.join("\n") : undefined;
    ctx.emit.error({ code: error.code, message: error.message, ...(hint ? { hint } : {}) });
    ctx.emit.setExitCode(error.exitCode);
    return;
  }
  ctx.emit.error(error);
  ctx.emit.setExitCode(SCHEDULE_JOBS_EXIT.refused);
}

function action<A extends unknown[]>(ctx: Ctx, fn: (...args: A) => void | Promise<void>) {
  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      refuse(ctx, error);
    }
  };
}

function rootOf(ctx: Ctx): string {
  const root = (ctx.deps.coordRoot ?? monorepoRoot)();
  if (!root) throw new Refusal("no_coord_root", "not in a coord-aware repo (no .harnery/ found)");
  return root;
}

function machineOf(ctx: Ctx): string {
  return (ctx.deps.machine ?? resolveMachineLabel)();
}

function nowOf(ctx: Ctx): Date {
  return (ctx.deps.now ?? (() => new Date()))();
}

function envOf(ctx: Ctx): Readonly<Record<string, string | undefined>> {
  return ctx.deps.env ?? process.env;
}

function out(ctx: Ctx, json: boolean | undefined, payload: unknown, lines: string[]): void {
  if (json) ctx.emit.data(payload);
  else ctx.emit.text(`${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// The job file
// ---------------------------------------------------------------------------

function readJobFile(root: string, { allowMissing }: { allowMissing: boolean }): ScheduleJobFile {
  const load = loadScheduleJobFile(root);
  if (load.ok) return load.file;
  if (load.reason === "missing") {
    if (allowMissing) return { version: SCHEDULE_JOB_FILE_VERSION, jobs: [] };
    throw new Refusal("schedule_no_job_file", `no job file at ${load.path}`);
  }
  throw new Refusal(
    "schedule_job_file_invalid",
    `the job file ${load.path} is invalid`,
    load.errors,
  );
}

function requireJob(file: ScheduleJobFile, id: string): ScheduleJob {
  const job = findScheduleJob(file, id);
  if (!job) throw new Refusal("schedule_unknown_job", `no job "${id}" in the job file`);
  return job;
}

function describeTrigger(trigger: ScheduleJobTrigger): string {
  switch (trigger.type) {
    case "once":
      return `once at ${trigger.at}`;
    case "every":
      return `every ${trigger.minutes} minutes`;
    case "cron":
      return `cron "${trigger.expr}"`;
  }
}

function promptFirstLine(prompt: string): string {
  return (
    prompt
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

/** A job's shape for output, with the prompt reduced to its length. */
function jobSummary(job: ScheduleJob): Record<string, unknown> {
  return {
    id: job.id,
    title: job.title,
    host: job.host,
    trigger: job.trigger,
    enabled: isScheduleJobEnabled(job),
    timeout_minutes: job.timeout_minutes,
    max_launches_per_day: job.max_launches_per_day,
    ...(job.owner ? { owner: job.owner } : {}),
    gather: (job.gather ?? []).map((g) => ({
      name: g.name,
      argv: g.argv,
      ...(g.finding_exit_codes ? { finding_exit_codes: g.finding_exit_codes } : {}),
      ...(g.env ? { env: g.env } : {}),
    })),
    agent: job.agent
      ? {
          adapter: job.agent.adapter,
          model: job.agent.model ?? null,
          effort: job.agent.effort ?? null,
          prompt_chars: job.agent.prompt.length,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

interface AddOptions {
  title?: string;
  once?: string;
  every?: string;
  cron?: string;
  host?: string;
  gather?: string[];
  gatherJson?: string;
  adapter?: string;
  model?: string;
  effort?: string;
  prompt?: string;
  promptFile?: string;
  timeoutMinutes?: string;
  launchesPerDay?: string;
  owner?: string;
  fromFile?: string;
  json?: boolean;
}

function readJsonFile(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Refusal(
      "schedule_read_failed",
      `cannot read ${what} ${path}: ${(error as Error).message}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Refusal(
      "schedule_bad_json",
      `${what} ${path} is not valid JSON: ${(error as Error).message}`,
    );
  }
}

function isArgv(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
}

/** `name=["exe","arg"]`: a JSON argv array, never a shell string. */
function parseGatherFlag(raw: string): ScheduleGatherCommand {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new Refusal(
      "schedule_bad_gather",
      `--gather "${raw}" must be <name>=<JSON array of arguments>, for example status='["git","status"]'`,
    );
  }
  const name = raw.slice(0, eq);
  let argv: unknown;
  try {
    argv = JSON.parse(raw.slice(eq + 1));
  } catch {
    argv = undefined;
  }
  if (!isArgv(argv)) {
    throw new Refusal(
      "schedule_bad_gather",
      `--gather "${name}" must give a JSON array of strings (the executable, then each argument), not a command line`,
    );
  }
  return { name, argv };
}

function parseGatherJson(path: string): ScheduleGatherCommand[] {
  const value = readJsonFile(path, "gather file");
  if (!Array.isArray(value)) {
    throw new Refusal(
      "schedule_bad_gather",
      `the gather file ${path} must hold a JSON array of gather commands`,
    );
  }
  value.forEach((entry, i) => {
    const argv = (entry as { argv?: unknown } | null)?.argv;
    if (!isArgv(argv)) {
      throw new Refusal(
        "schedule_bad_gather",
        `gather entry ${i} in ${path} needs "argv" as an array of strings, not a command line`,
      );
    }
  });
  return value as ScheduleGatherCommand[];
}

function parseNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n))
    throw new Refusal("schedule_bad_number", `${flag} must be a number, got "${raw}"`);
  return n;
}

const JOB_FIELD_OPTIONS: (keyof AddOptions)[] = [
  "title",
  "once",
  "every",
  "cron",
  "host",
  "gather",
  "gatherJson",
  "adapter",
  "model",
  "effort",
  "prompt",
  "promptFile",
  "timeoutMinutes",
  "launchesPerDay",
  "owner",
];

function jobFromFile(ctx: Ctx, id: string, opts: AddOptions): unknown {
  const given = JOB_FIELD_OPTIONS.filter((k) => opts[k] !== undefined);
  if (given.length > 0) {
    throw new Refusal(
      "schedule_conflicting_options",
      "--from-file holds the whole job; do not combine it with job field options",
    );
  }
  const value = readJsonFile(opts.fromFile as string, "job file");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Refusal("schedule_bad_job", `${opts.fromFile} must hold one JSON job object`);
  }
  const job = { ...(value as Record<string, unknown>) };
  if (job.id === undefined) job.id = id;
  if (job.id !== id) {
    throw new Refusal(
      "schedule_id_mismatch",
      `the job in ${opts.fromFile} has id "${String(job.id)}", not "${id}"`,
    );
  }
  if (job.host === undefined) job.host = machineOf(ctx);
  return job;
}

function jobFromOptions(ctx: Ctx, id: string, opts: AddOptions): unknown {
  const triggers = [opts.once, opts.every, opts.cron].filter((v) => v !== undefined);
  if (triggers.length !== 1) {
    throw new Refusal(
      "schedule_bad_trigger",
      'give exactly one of --once <iso>, --every <minutes> or --cron "<5 fields>"',
    );
  }
  const trigger: ScheduleJobTrigger =
    opts.once !== undefined
      ? { type: "once", at: opts.once }
      : opts.every !== undefined
        ? { type: "every", minutes: parseNumber(opts.every, "--every") as number }
        : { type: "cron", expr: opts.cron as string };

  const gather: ScheduleGatherCommand[] = [
    ...(opts.gatherJson ? parseGatherJson(opts.gatherJson) : []),
    ...(opts.gather ?? []).map(parseGatherFlag),
  ];

  if (opts.prompt !== undefined && opts.promptFile !== undefined) {
    throw new Refusal("schedule_conflicting_options", "give --prompt or --prompt-file, not both");
  }
  let prompt = opts.prompt;
  if (opts.promptFile !== undefined) {
    try {
      prompt = readFileSync(opts.promptFile, "utf8");
    } catch (error) {
      throw new Refusal(
        "schedule_read_failed",
        `cannot read --prompt-file ${opts.promptFile}: ${(error as Error).message}`,
      );
    }
  }
  const wantsAgent =
    opts.adapter !== undefined ||
    opts.model !== undefined ||
    opts.effort !== undefined ||
    prompt !== undefined;
  if (wantsAgent && opts.adapter === undefined) {
    throw new Refusal("schedule_bad_agent", "an agent needs --adapter");
  }
  if (wantsAgent && prompt === undefined) {
    throw new Refusal("schedule_bad_agent", "an agent needs --prompt or --prompt-file");
  }

  return {
    id,
    title: opts.title ?? id,
    host: opts.host ?? machineOf(ctx),
    trigger,
    timeout_minutes:
      parseNumber(opts.timeoutMinutes, "--timeout-minutes") ?? DEFAULT_TIMEOUT_MINUTES,
    max_launches_per_day:
      parseNumber(opts.launchesPerDay, "--launches-per-day") ?? DEFAULT_LAUNCHES_PER_DAY,
    ...(opts.owner ? { owner: opts.owner } : {}),
    ...(gather.length > 0 ? { gather } : {}),
    ...(wantsAgent
      ? {
          agent: {
            adapter: opts.adapter,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.effort ? { effort: opts.effort } : {}),
            prompt,
          },
        }
      : {}),
  };
}

function runAdd(ctx: Ctx, id: string, opts: AddOptions): void {
  const root = rootOf(ctx);
  const candidate = opts.fromFile ? jobFromFile(ctx, id, opts) : jobFromOptions(ctx, id, opts);
  const checked = validateScheduleJob(candidate);
  if (!checked.ok) {
    throw new Refusal("schedule_invalid_job", `job "${id}" is invalid`, checked.errors);
  }
  const job = checked.value;
  const file = readJobFile(root, { allowMissing: true });
  if (findScheduleJob(file, job.id)) {
    throw new Refusal("schedule_duplicate_job", `a job "${job.id}" already exists in the job file`);
  }
  writeScheduleJobFile(root, { ...file, jobs: [...file.jobs, job] });
  const tracked = ensureScheduleJobFileTracked(root);
  const enroll = `${ctx.bin} schedule enroll ${job.id}`;
  out(
    ctx,
    opts.json,
    {
      ok: true,
      action: "added",
      job: jobSummary(job),
      gitignore_exception_added: tracked.changed,
      enrolled: false,
      enroll_command: enroll,
    },
    [
      `Added job "${job.id}" (${describeTrigger(job.trigger)}, host ${job.host}) to .harnery/schedules.jsonc.`,
      ...(tracked.changed
        ? ["Added !schedules.jsonc to .harnery/.gitignore so the job file is tracked."]
        : []),
      `The job is not enrolled, so it will not run. To enroll it on this machine, run: ${enroll}`,
    ],
  );
}

// ---------------------------------------------------------------------------
// enroll
// ---------------------------------------------------------------------------

/**
 * The execution fields as last enrolled, kept privately so a re-enroll
 * preview can name what changed. The enrollment record holds only the hash.
 */
interface EnrolledFieldsSnapshot {
  schema_version: 1;
  job_hash: string;
  fields: ScheduleJobExecutionFields;
}

function enrolledFieldsPath(root: string, jobId: string): string {
  return join(scheduleStateDir(root), "enrolled-fields", `${jobId}.json`);
}

function readEnrolledFields(
  root: string,
  jobId: string,
  hash: string,
): ScheduleJobExecutionFields | null {
  try {
    const value = JSON.parse(
      readFileSync(enrolledFieldsPath(root, jobId), "utf8"),
    ) as EnrolledFieldsSnapshot;
    if (value?.schema_version === 1 && value.job_hash === hash && value.fields) return value.fields;
  } catch {
    // Missing or unreadable: the preview says the old fields are not on record.
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Names of the execution fields that differ, one level deep for objects. */
export function changedExecutionFields(
  before: ScheduleJobExecutionFields,
  after: ScheduleJobExecutionFields,
): string[] {
  const changed: string[] = [];
  const a = before as unknown as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (stableDigest(a[key] ?? null) === stableDigest(b[key] ?? null)) continue;
    const x = a[key];
    const y = b[key];
    if (isPlainObject(x) && isPlainObject(y)) {
      for (const sub of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
        if (stableDigest(x[sub] ?? null) !== stableDigest(y[sub] ?? null))
          changed.push(`${key}.${sub}`);
      }
    } else {
      changed.push(key);
    }
  }
  return changed;
}

function pinnedLines(job: ScheduleJob, fields: ScheduleJobExecutionFields, hash: string): string[] {
  const lines = [
    `  trigger: ${describeTrigger(job.trigger)} (zone ${fields.zone})`,
    `  host: ${job.host}`,
  ];
  for (const g of fields.gather) {
    lines.push(`  gather ${g.name}: ${JSON.stringify(g.argv)}`);
    lines.push(`    executable: ${g.executable}`);
    lines.push(`    variables passed: ${g.env.length > 0 ? g.env.join(", ") : "none"}`);
    if (g.finding_exit_codes.length > 0)
      lines.push(`    finding exit codes: ${g.finding_exit_codes.join(", ")}`);
  }
  if (fields.agent) {
    lines.push(
      `  agent: ${fields.agent.adapter}, model ${fields.agent.model ?? "default"}${fields.agent.effort ? `, effort ${fields.agent.effort}` : ""}`,
    );
    lines.push(
      `    prompt: ${fields.agent.prompt.length} characters, first line "${promptFirstLine(fields.agent.prompt)}"`,
    );
  } else {
    lines.push("  agent: none (gather only)");
  }
  lines.push(`  timeout: ${fields.timeout_minutes} minutes for the whole job`);
  lines.push(`  launches per day: at most ${fields.max_launches_per_day}`);
  lines.push(`  hash: ${hash}`);
  return lines;
}

function pinnedPayload(fields: ScheduleJobExecutionFields, hash: string): Record<string, unknown> {
  return {
    trigger: fields.trigger,
    zone: fields.zone,
    host: fields.host,
    gather: fields.gather.map((g) => ({
      name: g.name,
      argv: g.argv,
      executable: g.executable,
      env: g.env,
      finding_exit_codes: g.finding_exit_codes,
    })),
    agent: fields.agent
      ? {
          adapter: fields.agent.adapter,
          model: fields.agent.model,
          effort: fields.agent.effort,
          prompt_chars: fields.agent.prompt.length,
          prompt_first_line: promptFirstLine(fields.agent.prompt),
        }
      : null,
    timeout_minutes: fields.timeout_minutes,
    max_launches_per_day: fields.max_launches_per_day,
    hash,
  };
}

function runEnroll(ctx: Ctx, id: string, opts: { yes?: boolean; json?: boolean }): void {
  const root = rootOf(ctx);
  const job = requireJob(readJobFile(root, { allowMissing: false }), id);
  const machine = machineOf(ctx);
  const resolved = resolveScheduleJob(job, {
    coordRoot: root,
    env: envOf(ctx),
    pathLookup: ctx.deps.pathLookup,
  });

  if (job.host !== machine) {
    throw new Refusal(
      "schedule_enroll_wrong-host",
      `job "${job.id}" runs on host "${job.host}", and this machine is "${machine}"`,
    );
  }
  if (resolved.missing.length > 0) {
    throw new Refusal(
      "schedule_enroll_missing-executable",
      `cannot find ${resolved.missing.map((m) => `"${m}"`).join(", ")} for job "${job.id}"`,
    );
  }

  const fields = scheduleJobExecutionFields(job, resolved);
  const hash = hashScheduleJob(job, resolved);
  const existing = readScheduleEnrollment(root, job.id);

  if (existing && existing.job_hash === hash) {
    out(
      ctx,
      opts.json,
      {
        ok: true,
        action: "unchanged",
        job_id: job.id,
        enrolled_at: existing.enrolled_at,
        pinned: pinnedPayload(fields, hash),
      },
      [
        `Job "${job.id}" is already enrolled on this machine as it is now (since ${existing.enrolled_at}). Nothing changed.`,
      ],
    );
    return;
  }

  const reenroll = existing !== null;
  let changed: string[] | null = null;
  if (reenroll) {
    const before = readEnrolledFields(root, job.id, existing.job_hash);
    changed = before ? changedExecutionFields(before, fields) : null;
  }

  if (reenroll && !opts.yes) {
    out(
      ctx,
      opts.json,
      {
        ok: true,
        action: "preview",
        applied: false,
        job_id: job.id,
        previous_hash: existing.job_hash,
        changed_fields: changed,
        pinned: pinnedPayload(fields, hash),
        confirm_command: `${ctx.bin} schedule enroll ${job.id} --yes`,
      },
      [
        `Job "${job.id}" changed since it was enrolled, so it will not run until it is enrolled again.`,
        changed
          ? `Changed execution fields: ${changed.length > 0 ? changed.join(", ") : "none recorded"}`
          : "The previously enrolled fields are not on record, so every pinned field is shown below.",
        "Enrolling again would pin:",
        ...pinnedLines(job, fields, hash),
        `Nothing was changed. To enroll it again, run: ${ctx.bin} schedule enroll ${job.id} --yes`,
      ],
    );
    return;
  }

  const result = enrollScheduleJob({
    coordRoot: root,
    job,
    resolved,
    machine,
    now: nowOf(ctx),
    ...(ctx.deps.registryDir ? { registryDir: ctx.deps.registryDir } : {}),
  });
  if (!result.ok) {
    throw new Refusal(`schedule_enroll_${result.reason}`, result.detail);
  }
  const snapshot: EnrolledFieldsSnapshot = {
    schema_version: 1,
    job_hash: result.enrollment.job_hash,
    fields,
  };
  writePrivateJsonAtomic(enrolledFieldsPath(root, job.id), snapshot);
  out(
    ctx,
    opts.json,
    {
      ok: true,
      action: reenroll ? "re-enrolled" : "enrolled",
      job_id: job.id,
      enrollment: result.enrollment,
      ...(reenroll ? { changed_fields: changed } : {}),
      pinned: pinnedPayload(fields, result.enrollment.job_hash),
    },
    [
      `${reenroll ? "Enrolled again" : "Enrolled"} job "${job.id}" on ${machine}. Nothing due before ${result.enrollment.enrolled_at} runs.`,
      "Pinned:",
      ...pinnedLines(job, fields, result.enrollment.job_hash),
      ...(isScheduleJobEnabled(job)
        ? []
        : [`The job is paused; run ${ctx.bin} schedule resume ${job.id} to let it run.`]),
    ],
  );
}

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

/** Whether `enabled` is outside the enrollment hash, checked against the contract. */
function enabledIsHashed(job: ScheduleJob): boolean {
  const resolution = { executables: (job.gather ?? []).map(() => ""), zone: "UTC" };
  return (
    hashScheduleJob({ ...job, enabled: true }, resolution) !==
    hashScheduleJob({ ...job, enabled: false }, resolution)
  );
}

function runSetEnabled(ctx: Ctx, id: string, enabled: boolean, opts: { json?: boolean }): void {
  const root = rootOf(ctx);
  const file = readJobFile(root, { allowMissing: false });
  const job = requireJob(file, id);
  const hashed = enabledIsHashed(job);
  const verb = enabled ? "resumed" : "paused";
  const already = isScheduleJobEnabled(job) === enabled;
  if (!already) {
    const next: ScheduleJob = { ...job };
    if (enabled) delete next.enabled;
    else next.enabled = false;
    writeScheduleJobFile(root, { ...file, jobs: file.jobs.map((j) => (j.id === id ? next : j)) });
  }
  const hashNote = hashed
    ? `The enabled flag is part of the enrollment hash, so run ${ctx.bin} schedule enroll ${id} --yes before it runs again.`
    : "The enabled flag is not part of the enrollment hash, so the enrollment still holds; no need to enroll again.";
  out(
    ctx,
    opts.json,
    { ok: true, action: already ? "unchanged" : verb, job_id: id, enabled, needs_enroll: hashed },
    [
      already ? `Job "${id}" was already ${verb}; nothing changed.` : `Job "${id}" is ${verb}.`,
      hashNote,
    ],
  );
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

function runRemove(ctx: Ctx, id: string, opts: { yes?: boolean; json?: boolean }): void {
  const root = rootOf(ctx);
  const load = loadScheduleJobFile(root);
  if (!load.ok && load.reason === "invalid") {
    throw new Refusal(
      "schedule_job_file_invalid",
      `the job file ${load.path} is invalid`,
      load.errors,
    );
  }
  const file = load.ok ? load.file : null;
  const inFile = file ? findScheduleJob(file, id) !== null : false;
  const enrollment = readScheduleEnrollment(root, id);
  if (!inFile && !enrollment) {
    throw new Refusal(
      "schedule_unknown_job",
      `no job "${id}" in the job file and no enrollment on this machine`,
    );
  }
  const plan = [
    ...(inFile ? [`remove job "${id}" from .harnery/schedules.jsonc`] : []),
    ...(enrollment
      ? [`remove its enrollment on this machine (enrolled ${enrollment.enrolled_at})`]
      : []),
  ];
  const keep = "Run reports and claim files are kept.";
  if (!opts.yes) {
    out(
      ctx,
      opts.json,
      {
        ok: true,
        action: "preview",
        applied: false,
        job_id: id,
        in_file: inFile,
        enrolled: enrollment !== null,
        confirm_command: `${ctx.bin} schedule remove ${id} --yes`,
      },
      [
        `Would ${plan.join(" and ")}.`,
        keep,
        `Nothing was changed. To remove it, run: ${ctx.bin} schedule remove ${id} --yes`,
      ],
    );
    return;
  }
  if (file && inFile) {
    writeScheduleJobFile(root, { ...file, jobs: file.jobs.filter((j) => j.id !== id) });
  }
  const removed = removeScheduleEnrollment(
    root,
    id,
    ctx.deps.registryDir ? { registryDir: ctx.deps.registryDir } : {},
  );
  rmSync(enrolledFieldsPath(root, id), { force: true });
  out(
    ctx,
    opts.json,
    {
      ok: true,
      action: "removed",
      job_id: id,
      removed_from_file: inFile,
      enrollment_removed: removed.removed,
    },
    [`Removed: ${plan.join(" and ")}.`, keep],
  );
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

function relativeToRoot(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}

async function runNow(ctx: Ctx, id: string, opts: { json?: boolean }): Promise<void> {
  const root = rootOf(ctx);
  const run = ctx.deps.runManually ?? runScheduleJobManually;
  const result = await run({
    coordRoot: root,
    jobId: id,
    now: nowOf(ctx),
    machine: machineOf(ctx),
    env: envOf(ctx),
    ...(ctx.deps.launcher ? { launcher: ctx.deps.launcher } : {}),
  });
  if (!result.ok) {
    throw new Refusal(
      "schedule_run_refused",
      `job "${id}" did not run: ${result.reason}`,
      [],
      SCHEDULE_JOBS_EXIT.runRefused,
    );
  }
  const { record } = result;
  const report = relativeToRoot(root, result.reportPath);
  out(
    ctx,
    opts.json,
    {
      ok: true,
      job_id: id,
      run_id: record.run_id,
      result: record.result,
      started_at: record.started_at,
      finished_at: record.finished_at,
      gather: record.gather,
      agent: record.agent,
      report_path: report,
    },
    [
      `Job "${id}" ran: ${record.result}.`,
      ...record.gather.map(
        (g) =>
          `  gather ${g.name}: ${g.state}${g.exit_code !== null ? ` (exit ${g.exit_code})` : ""}${g.truncated ? ", output truncated" : ""}${g.error ? `: ${g.error}` : ""}`,
      ),
      ...(record.agent
        ? [
            `  agent ${record.agent.adapter}: ${record.agent.ok ? "ran" : "failed"}, status ${record.agent.status_line}${record.agent.error ? `: ${record.agent.error}` : ""}`,
          ]
        : []),
      `Report: ${report}`,
    ],
  );
  if (record.result === "attention") ctx.emit.setExitCode(SCHEDULE_JOBS_EXIT.attention);
  else if (record.result === "failed") ctx.emit.setExitCode(SCHEDULE_JOBS_EXIT.failed);
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

function formatLocal(iso: string, zone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
    timeZone: zone,
  }).format(d);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function historyRow(root: string, record: ScheduleRunRecord) {
  const durationMs = Date.parse(record.finished_at) - Date.parse(record.started_at);
  let report: string | null = null;
  try {
    report = relativeToRoot(
      root,
      join(
        scheduleRunDir(root, record.job_id, scheduleRunStamp(record.started_at)),
        record.report_file,
      ),
    );
  } catch {
    report = null;
  }
  return {
    run_id: record.run_id,
    scheduled_for: record.scheduled_for,
    kind: record.kind,
    started_at: record.started_at,
    finished_at: record.finished_at,
    duration_ms: durationMs,
    result: record.result,
    report_path: report,
  };
}

function runHistory(ctx: Ctx, id: string, opts: { limit?: string; json?: boolean }): void {
  const root = rootOf(ctx);
  let limit: number | undefined;
  if (opts.limit !== undefined) {
    limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Refusal(
        "schedule_bad_number",
        `--limit must be a whole number of at least 1, got "${opts.limit}"`,
      );
    }
  }
  // An id that could never name a job has no run folder to look in.
  if (!isScheduleKebabId(id)) {
    throw new Refusal("schedule_unknown_job", `"${id}" is not a valid job id`);
  }
  const all = listScheduleRuns(root, id).map((r) => historyRow(root, r));
  // Whether the job file still defines the job: true, false, or null when the
  // job file cannot be read. Runs of a removed job stay listable, because the
  // reports outlive the definition; an id with neither a definition nor a run
  // is a mistake, and saying "no runs" for it would hide a typo.
  const load = loadScheduleJobFile(root);
  let defined: boolean | null;
  if (load.ok) defined = findScheduleJob(load.file, id) !== null;
  else if (load.reason === "missing") defined = false;
  else defined = null;
  if (all.length === 0 && defined === null && !load.ok) {
    throw new Refusal(
      "schedule_job_file_invalid",
      `the job file ${load.path} is invalid`,
      load.errors,
    );
  }
  if (all.length === 0 && defined === false) {
    throw new Refusal(
      "schedule_unknown_job",
      `no job "${id}" in the job file and no recorded runs on this machine`,
    );
  }
  const rows = limit === undefined ? all : all.slice(0, limit);
  if (opts.json) {
    ctx.emit.data({ job_id: id, defined, rows, meta: { total: all.length, shown: rows.length } });
    return;
  }
  if (rows.length === 0) {
    ctx.emit.text(`No runs recorded for job "${id}".\n`);
    return;
  }
  const zone = resolveTimeZone(root);
  const note =
    defined === false
      ? [`Job "${id}" is no longer in the job file; these are its recorded runs.`]
      : defined === null
        ? [`The job file is invalid, so whether job "${id}" is still defined is unknown.`]
        : [];
  ctx.emit.text(
    [
      ...note,
      `Runs of job "${id}", newest first (${rows.length} of ${all.length}):`,
      ...rows.map(
        (r) =>
          `  ${formatLocal(r.scheduled_for, zone)}  ${r.kind}  started ${formatLocal(r.started_at, zone)}  ${formatDuration(r.duration_ms)}  ${r.result}  ${r.report_path ?? "(no report path)"}`,
      ),
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** Attach the job subcommands to the parent `schedule` command. */
export function registerScheduleJobsCommands(
  schedule: Command,
  deps: ScheduleJobsCommandDeps = {},
): void {
  const ctx: Ctx = { emit: deps.emit ?? defaultEmit, deps, bin: resolveBinName() };

  schedule
    .command("add <id>")
    .description(
      "Add a job to the tracked job file (.harnery/schedules.jsonc); it runs only after `enroll`",
    )
    .option("--title <text>", "a human title (default: the id)")
    .option("--once <iso>", "trigger: run once at this ISO instant (with Z or an offset)")
    .option(
      "--every <minutes>",
      "trigger: run every N minutes (at least 5), counted from enrollment",
    )
    .option("--cron <expr>", 'trigger: a 5-field cron expression, for example "0 3 * * *"')
    .option("--host <label>", "the machine label that may run the job (default: this machine)")
    .option(
      "--gather <name=argv>",
      'a gather command as name=<JSON argv array>, for example status=\'["git","status"]\' (repeatable)',
      collect,
    )
    .option(
      "--gather-json <file>",
      "a JSON file holding the gather array (name, argv, finding_exit_codes, env)",
    )
    .option("--adapter <id>", "the agent adapter that judges the gathered output")
    .option("--model <model>", "the agent's model")
    .option("--effort <level>", "the agent's reasoning effort")
    .option("--prompt <text>", "the agent's prompt")
    .option("--prompt-file <file>", "read the agent's prompt from a file")
    .option(
      "--timeout-minutes <n>",
      `one deadline for the whole job, 1 to 240 (default ${DEFAULT_TIMEOUT_MINUTES})`,
    )
    .option(
      "--launches-per-day <n>",
      `launches allowed per day, 1 to 48 (default ${DEFAULT_LAUNCHES_PER_DAY})`,
    )
    .option("--owner <agent>", "agent name to ping when a run needs attention")
    .option("--from-file <job.json>", "read the whole job object from a JSON file")
    .option("--json", "print JSON")
    .action(action(ctx, (id: string, opts: AddOptions) => runAdd(ctx, id, opts)));

  schedule
    .command("enroll <id>")
    .description("Pin a job's execution fields to this machine and checkout so it may run here")
    .option("--yes", "enroll again after the job changed (otherwise a preview)")
    .option("--json", "print JSON")
    .action(
      action(ctx, (id: string, opts: { yes?: boolean; json?: boolean }) =>
        runEnroll(ctx, id, opts),
      ),
    );

  schedule
    .command("pause <id>")
    .description("Stop a job from running without removing it")
    .option("--json", "print JSON")
    .action(
      action(ctx, (id: string, opts: { json?: boolean }) => runSetEnabled(ctx, id, false, opts)),
    );

  schedule
    .command("resume <id>")
    .description("Let a paused job run again")
    .option("--json", "print JSON")
    .action(
      action(ctx, (id: string, opts: { json?: boolean }) => runSetEnabled(ctx, id, true, opts)),
    );

  schedule
    .command("remove <id>")
    .description(
      "Remove a job from the job file and its enrollment on this machine (a preview unless --yes)",
    )
    .option("--yes", "make the change")
    .option("--json", "print JSON")
    .action(
      action(ctx, (id: string, opts: { yes?: boolean; json?: boolean }) =>
        runRemove(ctx, id, opts),
      ),
    );

  schedule
    .command("run <id>")
    .description(
      `Run a job once now. Exit ${SCHEDULE_JOBS_EXIT.ok} ok, ${SCHEDULE_JOBS_EXIT.attention} attention, ${SCHEDULE_JOBS_EXIT.failed} failed, ${SCHEDULE_JOBS_EXIT.runRefused} refused`,
    )
    .option("--json", "print JSON")
    .action(action(ctx, (id: string, opts: { json?: boolean }) => runNow(ctx, id, opts)));

  schedule
    .command("history <id>")
    .description("List a job's runs, newest first")
    .option("--limit <n>", "show at most N runs")
    .option("--json", "print JSON")
    .action(
      action(ctx, (id: string, opts: { limit?: string; json?: boolean }) =>
        runHistory(ctx, id, opts),
      ),
    );
}
