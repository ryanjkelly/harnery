/**
 * The permanent claim for one due time of one job in one checkout.
 *
 * A claim file is created exclusively (the `wx` open flag), so a second tick
 * cannot create it, and it is never deleted. A no-clobber lease per job
 * guards only the moment a claim is created or rewritten; it is not the
 * record, because a lease removes its own file on release.
 *
 * States move `claimed` to `started` to `finished`, or `claimed` to
 * `abandoned`. Each change is an atomic rewrite that first re-reads the file
 * and checks the state it expects, so two writers cannot both win.
 *
 * A claim with no start is retried once. The contract has no attempt field,
 * so the retry is recorded as a second permanent file beside the claim,
 * `<claim file>.retry`, also created exclusively. A claim that started and
 * never finished is never rerun; the warning track reports it.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { processMayBeAlive } from "../../lib/process-alive.ts";
import { writePrivateJsonAtomic } from "../storage/atomic-json.ts";
import { fsyncDirectory } from "../storage/durable-record.ts";
import { stateDirMode, stateFileMode } from "../storage/modes.ts";
import { acquireNoClobberLease, type NoClobberLease } from "../storage/no-clobber-lease.ts";
import {
  parseScheduleClaimFileName,
  type ScheduleClaim,
  type ScheduleClaimKind,
  type ScheduleClaimState,
  validateScheduleClaim,
} from "./job-types.ts";
import { scheduleClaimPath, scheduleClaimsDir, scheduleStateDir } from "./paths.ts";

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

const LEASE_BUSY = "is held by a live or unexpired owner";

/** True when `error` is the lease module's refusal for a live holder. */
export function isScheduleLeaseBusy(error: unknown): boolean {
  return error instanceof Error && error.message.includes(LEASE_BUSY);
}

/** The folder that holds the scheduler's lease directories. */
export function scheduleLeasesDir(coordRoot: string): string {
  return join(scheduleStateDir(coordRoot), "leases");
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface AcquireScheduleLeaseOptions {
  /** Tries before giving up while a live owner holds it. 1 means no waiting. */
  attempts?: number;
  /** Wait between tries. */
  waitMs?: number;
  /** A crashed holder's lease becomes takeable after this long. */
  staleAfterMs?: number;
}

/**
 * Take a scheduler lease. A holder on this host whose process is gone can be
 * taken over once the lease is stale. Throws the lease module's busy error
 * when a live owner still holds it after every try.
 */
export function acquireScheduleLease(
  coordRoot: string,
  name: string,
  opts: AcquireScheduleLeaseOptions = {},
): NoClobberLease {
  const attempts = Math.max(1, opts.attempts ?? 1);
  const path = join(scheduleLeasesDir(coordRoot), name);
  const authoritySha256 = createHash("sha256")
    .update(resolve(coordRoot))
    .update("\0")
    .update(name)
    .digest("hex");
  for (let attempt = 0; ; attempt += 1) {
    try {
      return acquireNoClobberLease({
        path,
        scope: `schedule-${name}`,
        authoritySha256,
        staleAfterMs: opts.staleAfterMs ?? 30_000,
        validateStaleOwner: (owner) => owner.host === hostname() && !processMayBeAlive(owner.pid),
      });
    } catch (error) {
      if (!isScheduleLeaseBusy(error) || attempt >= attempts - 1) throw error;
      sleepMs(opts.waitMs ?? 25);
    }
  }
}

/** Run `fn` while holding the job's claim-write lease. */
function withClaimLease<T>(coordRoot: string, jobId: string, fn: () => T): T {
  const lease = acquireScheduleLease(coordRoot, `claims-${jobId}`, { attempts: 200, waitMs: 25 });
  try {
    return fn();
  } finally {
    lease.release();
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ScheduleClaimRead =
  | { state: "missing" }
  | { state: "invalid"; errors: string[] }
  | { state: "ok"; claim: ScheduleClaim };

function readClaimFile(path: string, jobId: string, scheduledFor: string): ScheduleClaimRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "invalid", errors: [(error as Error).message] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { state: "invalid", errors: [(error as Error).message] };
  }
  const checked = validateScheduleClaim(parsed);
  if (!checked.ok) return { state: "invalid", errors: checked.errors };
  if (checked.value.job_id !== jobId || checked.value.scheduled_for !== scheduledFor) {
    return { state: "invalid", errors: ["claim: job or time does not match its file name"] };
  }
  return { state: "ok", claim: checked.value };
}

/** Read one claim, validated. */
export function readScheduleClaim(
  coordRoot: string,
  jobId: string,
  scheduledFor: string,
): ScheduleClaimRead {
  return readClaimFile(scheduleClaimPath(coordRoot, jobId, scheduledFor), jobId, scheduledFor);
}

export interface ScheduleClaimEntry {
  job_id: string;
  scheduled_for: string;
  path: string;
  /** Null when the file could not be read or failed validation; such a claim never runs again. */
  claim: ScheduleClaim | null;
  /** Whether the one retry of a claim with no start has been taken. */
  retried: boolean;
}

/**
 * The job's claims, oldest first. `sinceMs` skips claims whose scheduled
 * instant is older, judged from the file name alone, so a long history is
 * not read on every tick.
 */
export function listScheduleClaims(
  coordRoot: string,
  jobId: string,
  opts: { sinceMs?: number } = {},
): ScheduleClaimEntry[] {
  const dir = scheduleClaimsDir(coordRoot, jobId);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const nameSet = new Set(names);
  const entries: ScheduleClaimEntry[] = [];
  for (const name of names) {
    const parsed = parseScheduleClaimFileName(name);
    if (!parsed || parsed.job_id !== jobId) continue;
    if (opts.sinceMs !== undefined && Date.parse(parsed.scheduled_for) < opts.sinceMs) continue;
    const path = join(dir, name);
    const read = readClaimFile(path, jobId, parsed.scheduled_for);
    entries.push({
      job_id: jobId,
      scheduled_for: parsed.scheduled_for,
      path,
      claim: read.state === "ok" ? read.claim : null,
      retried: nameSet.has(`${name}.retry`),
    });
  }
  entries.sort((a, b) => Date.parse(a.scheduled_for) - Date.parse(b.scheduled_for));
  return entries;
}

/** The calendar day of an instant in a zone, as `YYYY-MM-DD`. */
export function scheduleLocalDay(ms: number, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** Claims older than this cannot have started today, even after a catch-up. */
const LAUNCH_COUNT_LOOKBACK_MS = 9 * 24 * 60 * 60 * 1000;

/**
 * Launches of the job that started on the same local day as `now` in
 * `zone`: every claim with a `started_at` that day, whatever its kind or
 * final state. Scheduled, catch-up, retried and manual runs all count.
 */
export function countScheduleLaunchesToday(
  coordRoot: string,
  jobId: string,
  now: Date,
  zone: string,
): number {
  const today = scheduleLocalDay(now.getTime(), zone);
  return listScheduleClaims(coordRoot, jobId, {
    sinceMs: now.getTime() - LAUNCH_COUNT_LOOKBACK_MS,
  }).filter((entry) => {
    const started = entry.claim?.started_at;
    return started !== undefined && scheduleLocalDay(Date.parse(started), zone) === today;
  }).length;
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

function writeExclusive(path: string, text: string): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: stateDirMode() });
  let fd: number;
  try {
    fd = openSync(path, "wx", stateFileMode());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
  return true;
}

export interface CreateScheduleClaimOptions {
  coordRoot: string;
  jobId: string;
  /** Any ISO instant; stored in UTC `toISOString()` form. */
  scheduledFor: string;
  kind: ScheduleClaimKind;
  now: Date;
  /** Refuse, without creating anything, when the job already launched this many times today. */
  limit?: { maxLaunchesPerDay: number; zone: string };
}

export type CreateScheduleClaimResult =
  | { ok: true; claim: ScheduleClaim; path: string }
  | { ok: false; reason: "exists"; path: string }
  | { ok: false; reason: "daily-limit"; launchesToday: number; path: string };

/**
 * Create the permanent claim exclusively. `exists` means another tick or
 * run already holds this instant. With `limit`, the count and the create
 * happen under one lease, so two callers cannot both take the last launch.
 */
export function createScheduleClaim(opts: CreateScheduleClaimOptions): CreateScheduleClaimResult {
  const scheduledFor = new Date(Date.parse(opts.scheduledFor)).toISOString();
  const path = scheduleClaimPath(opts.coordRoot, opts.jobId, scheduledFor);
  return withClaimLease(opts.coordRoot, opts.jobId, () => {
    if (opts.limit) {
      const launchesToday = countScheduleLaunchesToday(
        opts.coordRoot,
        opts.jobId,
        opts.now,
        opts.limit.zone,
      );
      if (launchesToday >= opts.limit.maxLaunchesPerDay) {
        return { ok: false as const, reason: "daily-limit" as const, launchesToday, path };
      }
    }
    const claim: ScheduleClaim = {
      schema_version: 1,
      job_id: opts.jobId,
      scheduled_for: scheduledFor,
      kind: opts.kind,
      state: "claimed",
      claimed_at: opts.now.toISOString(),
      run_id: randomUUID(),
    };
    if (!writeExclusive(path, `${JSON.stringify(claim)}\n`)) {
      return { ok: false as const, reason: "exists" as const, path };
    }
    return { ok: true as const, claim, path };
  });
}

/**
 * Take the one retry of a claim that never started, by creating its
 * `.retry` file exclusively. False when the retry was already taken.
 */
export function takeScheduleClaimRetry(
  coordRoot: string,
  claim: ScheduleClaim,
  now: Date,
): boolean {
  const path = `${scheduleClaimPath(coordRoot, claim.job_id, claim.scheduled_for)}.retry`;
  return withClaimLease(coordRoot, claim.job_id, () =>
    writeExclusive(path, `${JSON.stringify({ retried_at: now.toISOString() })}\n`),
  );
}

// ---------------------------------------------------------------------------
// State changes
// ---------------------------------------------------------------------------

const ALLOWED: Record<ScheduleClaimState, readonly ScheduleClaimState[]> = {
  claimed: ["started", "abandoned"],
  started: ["finished"],
  finished: [],
  abandoned: [],
};

function transition(
  coordRoot: string,
  claim: ScheduleClaim,
  next: ScheduleClaimState,
  fields: Partial<Pick<ScheduleClaim, "started_at" | "finished_at" | "pid">>,
): ScheduleClaim {
  return withClaimLease(coordRoot, claim.job_id, () => {
    const path = scheduleClaimPath(coordRoot, claim.job_id, claim.scheduled_for);
    const current = readClaimFile(path, claim.job_id, claim.scheduled_for);
    if (current.state !== "ok") {
      throw new Error(
        `schedule claim ${claim.job_id} ${claim.scheduled_for}: cannot move to ${next}; the claim is ${current.state}`,
      );
    }
    if (current.claim.run_id !== claim.run_id) {
      throw new Error(
        `schedule claim ${claim.job_id} ${claim.scheduled_for}: run id changed underneath`,
      );
    }
    if (!ALLOWED[current.claim.state].includes(next)) {
      throw new Error(
        `schedule claim ${claim.job_id} ${claim.scheduled_for}: cannot move from ${current.claim.state} to ${next}`,
      );
    }
    const updated: ScheduleClaim = { ...current.claim, ...fields, state: next };
    const checked = validateScheduleClaim(updated);
    if (!checked.ok) {
      throw new Error(`schedule claim: invalid update: ${checked.errors.join("; ")}`);
    }
    writePrivateJsonAtomic(path, checked.value);
    return checked.value;
  });
}

/** `claimed` to `started`, recording the launching process. */
export function markScheduleClaimStarted(
  coordRoot: string,
  claim: ScheduleClaim,
  opts: { now: Date; pid?: number },
): ScheduleClaim {
  return transition(coordRoot, claim, "started", {
    started_at: opts.now.toISOString(),
    pid: opts.pid ?? process.pid,
  });
}

/** `started` to `finished`: the run record exists. */
export function markScheduleClaimFinished(
  coordRoot: string,
  claim: ScheduleClaim,
  opts: { now: Date },
): ScheduleClaim {
  return transition(coordRoot, claim, "finished", { finished_at: opts.now.toISOString() });
}

/** `claimed` to `abandoned`: given up without a launch. */
export function markScheduleClaimAbandoned(
  coordRoot: string,
  claim: ScheduleClaim,
  opts: { now: Date },
): ScheduleClaim {
  return transition(coordRoot, claim, "abandoned", { finished_at: opts.now.toISOString() });
}
