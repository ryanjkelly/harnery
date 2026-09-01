// Durable job records: a small on-disk representation of "a job that outlives
// the client that launched it". A supervisor process owns the record; a client
// only reads it. A bridge drop, a closed terminal, or a killed client
// therefore interrupts the *view* of the job, never the job itself.
//
// Layout, under a caller-supplied base directory:
//
//   <base>/jobs/<job_id>/job.json      immutable description (argv, cwd, resource)
//   <base>/jobs/<job_id>/status.json   mutable state, rewritten atomically
//   <base>/jobs/<job_id>/job.log       merged child stdout + stderr
//
// Classification is fail-closed, mirroring qa-status: liveness is proven by the
// PID, never assumed from the status document. A non-terminal state whose PID
// is dead classifies as "dead", never as "running".
//
// Toolkit tier: this module must not import src/core (layering check).

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const DURABLE_JOB_SCHEMA_VERSION = 1;

/** How often the supervisor rewrites status.json while a job runs. */
export const DURABLE_JOB_HEARTBEAT_MS = 15_000;

/** A running job whose heartbeat is older than this earns a staleness warning,
 * but stays "running" while its PID is alive. */
export const DURABLE_JOB_HEARTBEAT_STALE_MS = 120_000;

export const DURABLE_JOB_DOCUMENT_FILENAME = "job.json";
export const DURABLE_JOB_STATUS_FILENAME = "status.json";
export const DURABLE_JOB_LOG_FILENAME = "job.log";

const JOBS_DIRNAME = "jobs";

/** States a supervisor writes. "completed" is the only terminal one. */
export type DurableJobState = "launching" | "queued" | "running" | "completed";

/** States a reader can observe. "dead" is derived, never written. */
export type DurableJobObservedState = DurableJobState | "dead";

const WRITTEN_STATES = new Set<string>(["launching", "queued", "running", "completed"]);

export interface DurableJobDocument {
  schema_version: number;
  job_id: string;
  /** Admission resource the job queues on. */
  resource: string;
  /** Concurrent holders allowed on that resource. */
  capacity: number;
  /** Human-readable description shown in listings. */
  label: string;
  /** Argument vector of the wrapped command; argv[0] is the executable. */
  argv: string[];
  /** Directory the wrapped command runs in. */
  cwd: string;
  created_at: string;
}

export interface DurableJobStatus {
  schema_version: number;
  job_id: string;
  /** PID of the supervisor, not of the wrapped command. */
  pid: number;
  state: DurableJobState;
  started_at: string;
  updated_at: string;
  /** Present while the supervisor waits for an admission slot. */
  queue?: { resource: string; waiting_since: string };
  exit_code?: number | null;
  signal?: string | null;
}

export interface DurableJobReport {
  state: DurableJobObservedState;
  /** The job reached "completed"; exit_code and signal are final. */
  terminal: boolean;
  job_id: string | null;
  pid: number | null;
  resource: string | null;
  label: string | null;
  argv: string[] | null;
  exit_code: number | null;
  signal: string | null;
  created_at: string | null;
  started_at: string | null;
  updated_at: string | null;
  /** now minus status.updated_at; null without a parseable heartbeat. */
  heartbeat_age_ms: number | null;
  queue?: { resource: string; waiting_since: string };
  job_dir: string;
  log_path: string;
  warnings: string[];
}

export interface DurableJobDeps {
  /** PID liveness probe (injectable for tests). Default: process.kill(pid, 0). */
  pidAlive?: (pid: number) => boolean;
  /** Evaluation instant in epoch milliseconds. Default: Date.now(). */
  now?: () => number;
}

export type DurableJobClassification =
  | { ok: true; report: DurableJobReport }
  | { ok: false; error: string };

export interface DurableJobListEntry {
  job_id: string;
  job_dir: string;
  created_at: string | null;
  document: DurableJobDocument | null;
  report: DurableJobReport | null;
  /** Set when the directory exists but its status document is unusable. */
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Default PID liveness probe. EPERM counts as alive; only ESRCH is dead. */
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Directory holding every job record under a base directory. */
export function jobsRoot(base: string): string {
  return join(resolve(base), JOBS_DIRNAME);
}

/** Directory of one job record. Does not create it. */
export function jobDirFor(base: string, jobId: string): string {
  return join(jobsRoot(base), jobId);
}

/** Create (idempotently) the directory for one job and return its path. */
export function createJobDir(base: string, jobId: string): string {
  const dir = jobDirFor(base, jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function jobLogPath(jobDir: string): string {
  return join(resolve(jobDir), DURABLE_JOB_LOG_FILENAME);
}

function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

/** Write the immutable job description. */
export function writeJobDocument(jobDir: string, document: DurableJobDocument): void {
  writeAtomic(
    join(resolve(jobDir), DURABLE_JOB_DOCUMENT_FILENAME),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}

/** Replace the status document atomically, so a reader never sees a torn file. */
export function writeJobStatus(jobDir: string, status: DurableJobStatus): void {
  writeAtomic(
    join(resolve(jobDir), DURABLE_JOB_STATUS_FILENAME),
    `${JSON.stringify(status, null, 2)}\n`,
  );
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Read the job description, or null when it is missing or unusable. */
export function readJobDocument(jobDir: string): DurableJobDocument | null {
  const path = join(resolve(jobDir), DURABLE_JOB_DOCUMENT_FILENAME);
  let parsed: unknown;
  try {
    parsed = readJson(path);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.job_id !== "string") return null;
  return {
    schema_version:
      typeof parsed.schema_version === "number"
        ? parsed.schema_version
        : DURABLE_JOB_SCHEMA_VERSION,
    job_id: parsed.job_id,
    resource: typeof parsed.resource === "string" ? parsed.resource : "",
    capacity: typeof parsed.capacity === "number" ? parsed.capacity : 1,
    label: typeof parsed.label === "string" ? parsed.label : "",
    argv: Array.isArray(parsed.argv)
      ? parsed.argv.filter((a): a is string => typeof a === "string")
      : [],
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
    created_at: typeof parsed.created_at === "string" ? parsed.created_at : "",
  };
}

/** Read the status document, or null when it is missing or unusable. */
export function readJobStatus(jobDir: string): DurableJobStatus | null {
  const path = join(resolve(jobDir), DURABLE_JOB_STATUS_FILENAME);
  let parsed: unknown;
  try {
    parsed = readJson(path);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.job_id !== "string") return null;
  if (typeof parsed.state !== "string" || !WRITTEN_STATES.has(parsed.state)) return null;
  const queue = parsed.queue;
  return {
    schema_version:
      typeof parsed.schema_version === "number"
        ? parsed.schema_version
        : DURABLE_JOB_SCHEMA_VERSION,
    job_id: parsed.job_id,
    pid: typeof parsed.pid === "number" ? parsed.pid : 0,
    state: parsed.state as DurableJobState,
    started_at: typeof parsed.started_at === "string" ? parsed.started_at : "",
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
    ...(isRecord(queue) &&
    typeof queue.resource === "string" &&
    typeof queue.waiting_since === "string"
      ? { queue: { resource: queue.resource, waiting_since: queue.waiting_since } }
      : {}),
    ...(typeof parsed.exit_code === "number" || parsed.exit_code === null
      ? { exit_code: parsed.exit_code as number | null }
      : {}),
    ...(typeof parsed.signal === "string" || parsed.signal === null
      ? { signal: parsed.signal as string | null }
      : {}),
  };
}

/**
 * Classify one job directory, fail-closed. "completed" is terminal and carries
 * the wrapped command's exit code. Any other written state is trusted only
 * while the supervisor PID is alive; otherwise the job is "dead" — the record
 * outlived the process that owned it.
 */
export function classifyJob(jobDir: string, deps: DurableJobDeps = {}): DurableJobClassification {
  const isAlive = deps.pidAlive ?? defaultPidAlive;
  const nowMs = deps.now ? deps.now() : Date.now();
  const abs = resolve(jobDir);
  if (!existsSync(abs)) return { ok: false, error: `no such job directory: ${abs}` };

  const statusPath = join(abs, DURABLE_JOB_STATUS_FILENAME);
  if (!existsSync(statusPath)) {
    return {
      ok: false,
      error: `${abs} carries no ${DURABLE_JOB_STATUS_FILENAME}: not a job directory`,
    };
  }
  const status = readJobStatus(abs);
  if (!status) {
    return { ok: false, error: `${statusPath} is not a readable job status document` };
  }
  const document = readJobDocument(abs);

  let heartbeatAgeMs: number | null = null;
  const updatedMs = Date.parse(status.updated_at);
  if (!Number.isNaN(updatedMs)) heartbeatAgeMs = Math.max(0, nowMs - updatedMs);

  const base = {
    job_id: status.job_id,
    pid: status.pid > 0 ? status.pid : null,
    resource: document?.resource ?? null,
    label: document?.label ?? null,
    argv: document?.argv ?? null,
    created_at: document?.created_at ?? null,
    started_at: status.started_at || null,
    updated_at: status.updated_at || null,
    heartbeat_age_ms: heartbeatAgeMs,
    job_dir: abs,
    log_path: jobLogPath(abs),
  };

  if (status.state === "completed") {
    return {
      ok: true,
      report: {
        ...base,
        state: "completed",
        terminal: true,
        exit_code: status.exit_code ?? null,
        signal: status.signal ?? null,
        warnings: [],
      },
    };
  }

  if (!(status.pid > 0 && isAlive(status.pid))) {
    return {
      ok: true,
      report: {
        ...base,
        state: "dead",
        terminal: false,
        exit_code: null,
        signal: null,
        ...(status.queue ? { queue: status.queue } : {}),
        warnings: [],
      },
    };
  }

  const warnings: string[] = [];
  if (
    status.state === "running" &&
    heartbeatAgeMs !== null &&
    heartbeatAgeMs > DURABLE_JOB_HEARTBEAT_STALE_MS
  ) {
    warnings.push(
      `heartbeat stale: last update ${Math.round(heartbeatAgeMs / 1000)}s ago ` +
        `(threshold ${DURABLE_JOB_HEARTBEAT_STALE_MS / 1000}s), but pid ${status.pid} is alive`,
    );
  }
  return {
    ok: true,
    report: {
      ...base,
      state: status.state,
      terminal: false,
      exit_code: null,
      signal: null,
      ...(status.queue ? { queue: status.queue } : {}),
      warnings,
    },
  };
}

/**
 * Every job record under a base directory, newest first. Ordering keys on the
 * description's created_at, falling back to the status document's started_at,
 * then to the directory name, so a record missing its description still lists.
 */
export function listJobs(base: string, deps: DurableJobDeps = {}): DurableJobListEntry[] {
  const root = jobsRoot(base);
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const entries: { entry: DurableJobListEntry; sortKey: number }[] = [];
  for (const name of names) {
    const dir = join(root, name);
    const document = readJobDocument(dir);
    const classified = classifyJob(dir, deps);
    const createdAt =
      document?.created_at || (classified.ok ? classified.report.started_at : null) || null;
    const parsed = createdAt !== null ? Date.parse(createdAt) : Number.NaN;
    entries.push({
      entry: {
        job_id: document?.job_id ?? name,
        job_dir: dir,
        created_at: createdAt,
        document,
        report: classified.ok ? classified.report : null,
        ...(classified.ok ? {} : { error: classified.error }),
      },
      sortKey: Number.isNaN(parsed) ? 0 : parsed,
    });
  }
  entries.sort((a, b) => {
    if (b.sortKey !== a.sortKey) return b.sortKey - a.sortKey;
    return b.entry.job_id.localeCompare(a.entry.job_id);
  });
  return entries.map((item) => item.entry);
}

/** Describe a job's outcome as a process exit code: the wrapped command's own
 * code, 1 when it died on a signal, 4 when the record is dead. */
export function jobExitCode(report: DurableJobReport): number {
  if (report.state === "dead") return 4;
  if (!report.terminal) return 5;
  if (report.signal !== null) return 1;
  return report.exit_code ?? 1;
}

/** Format a duration the way the status commands do. */
export function formatJobAge(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
