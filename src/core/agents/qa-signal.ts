/**
 * Per-session page-QA signal: the pointer that lets `agents status` report a
 * verdict with the runner's own clock instead of leaving an operator to read
 * session age as if it were QA time.
 *
 * The problem this closes: a status box showing `session 58m` invites the
 * reading "page QA took 58 minutes". Session age measures the agent, not the
 * run. So the runner's wall time is recorded here and rendered beside the
 * verdict, and admission-queue wait is carried as a separate number because
 * `wall_time_ms.total` is runner stages only and never includes the queue
 * (see QaRunResult.wall_time_ms in the toolkit contracts).
 *
 * Layering: the qa-run matrix runner is toolkit tier (`src/lib/browser/**`)
 * and must not import `src/core`, so the runner cannot write this pointer
 * itself. The command layer owns the write and calls `recordQaSignal()` after
 * a run finishes. Core importing toolkit *types* is the permitted direction.
 *
 * Storage: `<coordRoot>/.harnery/qa/<instance-id>.json`, one file per session
 * generation, atomic temp+rename so a concurrent status read never sees a
 * torn write. Last run wins; each run directory remains the authoritative
 * record of the run itself.
 *
 * Every function here is best-effort by contract. A missing, unreadable,
 * malformed, or partial pointer yields null rather than throwing: the status
 * box must render even when QA state is broken.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  QaRunEvidenceSource,
  QaRunResult,
  QaRunVerdict,
} from "../../lib/browser/qa-run-contracts.ts";
import { resolveCoordRoot, resolveOwner } from "./coord-client.ts";

export const QA_SIGNAL_SCHEMA_VERSION = 1 as const;

/** Pointers older than this render as `stale (<age>)` and nothing else: an
 * age-of-day-old verdict says nothing about the page as it stands now, and
 * showing its timings beside a current session invites the same conflation
 * this signal exists to prevent. */
export const QA_SIGNAL_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Timings split the way the result contract splits them: `total` is runner
 * stages only, `queue` is admission wait before any browser work and is never
 * part of `total`. */
export interface QaSignalWallTime {
  total: number;
  queue?: number;
}

export interface QaSignalPointer {
  schema_version: typeof QA_SIGNAL_SCHEMA_VERSION;
  run_id: string;
  verdict: QaRunVerdict;
  evidence_source: QaRunEvidenceSource;
  /** ISO-8601 UTC instant the run completed. */
  completed_at: string;
  /** Absolute run directory holding the authoritative result document. */
  out_dir: string;
  wall_time_ms: QaSignalWallTime;
  target: string;
}

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const VERDICTS: readonly QaRunVerdict[] = ["passed", "failed", "incomplete"];
const EVIDENCE_SOURCES: readonly QaRunEvidenceSource[] = ["runner", "manual"];

/**
 * Absolute path of one session's QA pointer. Throws on an instance id that
 * could escape the directory; callers in this module treat that as "no
 * pointer" rather than propagating it.
 */
export function qaSignalPath(coordRoot: string, instanceId: string): string {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error("instance_id must be 1-128 ASCII letters, digits, hyphens, or underscores");
  }
  const directory = resolve(coordRoot, ".harnery", "qa");
  const candidate = resolve(directory, `${instanceId}.json`);
  if (!candidate.startsWith(`${directory}/`)) {
    throw new Error("resolved qa signal path escapes the qa directory");
  }
  return candidate;
}

export interface QaSignalTarget {
  /** Defaults to the resolved coordination root. */
  coordRoot?: string | null;
  /** Defaults to the current session's instance id. */
  instanceId?: string | null;
}

function resolveTarget(target: QaSignalTarget): { coordRoot: string; instanceId: string } | null {
  const coordRoot = target.coordRoot ?? resolveCoordRoot();
  const instanceId = target.instanceId ?? resolveOwner();
  if (!coordRoot || !instanceId) return null;
  return { coordRoot, instanceId };
}

/**
 * Write the pointer for one completed run. Returns what was written, or null
 * when the session/root could not be resolved or the write failed — a QA run
 * must never fail because its status breadcrumb could not be recorded.
 */
export function recordQaSignal(
  result: QaRunResult,
  target: QaSignalTarget = {},
): QaSignalPointer | null {
  try {
    const resolved = resolveTarget(target);
    if (!resolved) return null;
    const pointer: QaSignalPointer = {
      schema_version: QA_SIGNAL_SCHEMA_VERSION,
      run_id: result.run.run_id,
      verdict: result.verdict,
      evidence_source: result.evidence_source,
      completed_at: result.run.completed_at,
      out_dir: result.run.out_dir,
      wall_time_ms: {
        total: result.wall_time_ms.total,
        ...(typeof result.wall_time_ms.queue === "number"
          ? { queue: result.wall_time_ms.queue }
          : {}),
      },
      target: result.target,
    };
    const path = qaSignalPath(resolved.coordRoot, resolved.instanceId);
    mkdirSync(resolve(path, ".."), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
    return pointer;
  } catch {
    return null;
  }
}

/** Read one session's pointer. Null when absent, unreadable, or malformed. */
export function readQaSignal(target: QaSignalTarget = {}): QaSignalPointer | null {
  try {
    const resolved = resolveTarget(target);
    if (!resolved) return null;
    const path = qaSignalPath(resolved.coordRoot, resolved.instanceId);
    if (!existsSync(path)) return null;
    return parseQaSignal(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Validate an untrusted pointer document. Fail-closed: a partial document —
 * the shape a torn write or a schema change produces — is not a pointer, and
 * renders no row at all rather than a half-true one.
 */
export function parseQaSignal(document: unknown): QaSignalPointer | null {
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const value = document as Record<string, unknown>;
  if (value.schema_version !== QA_SIGNAL_SCHEMA_VERSION) return null;
  if (typeof value.run_id !== "string" || value.run_id.length === 0) return null;
  if (!VERDICTS.includes(value.verdict as QaRunVerdict)) return null;
  if (!EVIDENCE_SOURCES.includes(value.evidence_source as QaRunEvidenceSource)) return null;
  if (typeof value.completed_at !== "string" || Number.isNaN(Date.parse(value.completed_at))) {
    return null;
  }
  if (typeof value.out_dir !== "string" || value.out_dir.length === 0) return null;
  if (typeof value.target !== "string" || value.target.length === 0) return null;
  const wall = value.wall_time_ms;
  if (!wall || typeof wall !== "object" || Array.isArray(wall)) return null;
  const { total, queue } = wall as Record<string, unknown>;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return null;
  if (queue !== undefined && (typeof queue !== "number" || !Number.isFinite(queue) || queue < 0)) {
    return null;
  }
  return {
    schema_version: QA_SIGNAL_SCHEMA_VERSION,
    run_id: value.run_id,
    verdict: value.verdict as QaRunVerdict,
    evidence_source: value.evidence_source as QaRunEvidenceSource,
    completed_at: value.completed_at,
    out_dir: value.out_dir,
    wall_time_ms: { total, ...(typeof queue === "number" ? { queue } : {}) },
    target: value.target,
  };
}

/**
 * Coarse single-unit age, matching the status box's existing age vocabulary
 * (`4m`, `3h`, `2d`). Deliberately coarser than the duration formatter: an
 * operator reads age to judge relevance, not to compare timings.
 */
export function formatQaSignalAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Duration in the units an operator compares runs by. Seconds stay seconds up
 * to two minutes so a 90-second run reads `90s` rather than being rounded into
 * a minute bucket that hides the difference between fast runs.
 */
export function formatQaSignalDuration(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 120_000) return `${Math.round(value / 1000)}s`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`;
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.round((value % 3_600_000) / 60_000);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Render the status-box `qa` value, or null when there is nothing honest to
 * say. Three shapes:
 *   - fresh runner evidence: `passed 4m ago · 90s runner (2m queued)`
 *   - fresh manual evidence: `manual 12m ago · not a pass`
 *   - anything over the staleness horizon: `stale (2d)`
 *
 * Manual evidence never reports a verdict or a runner clock: nothing
 * re-executable ran, so the contract caps it below a pass and there is no
 * runner time to attribute.
 */
export function formatQaSignalRow(
  pointer: QaSignalPointer | null,
  now: number = Date.now(),
): string | null {
  if (!pointer) return null;
  const completedAt = Date.parse(pointer.completed_at);
  if (Number.isNaN(completedAt)) return null;
  const ageMs = Math.max(0, now - completedAt);
  const age = formatQaSignalAge(ageMs);
  if (ageMs > QA_SIGNAL_STALE_AFTER_MS) return `stale (${age})`;
  if (pointer.evidence_source === "manual") return `manual ${age} ago · not a pass`;
  const runner = `${formatQaSignalDuration(pointer.wall_time_ms.total)} runner`;
  const queued =
    typeof pointer.wall_time_ms.queue === "number" && pointer.wall_time_ms.queue > 0
      ? ` (${formatQaSignalDuration(pointer.wall_time_ms.queue)} queued)`
      : "";
  return `${pointer.verdict} ${age} ago · ${runner}${queued}`;
}

/**
 * The whole status-box contribution in one best-effort call: read this
 * session's pointer and render its row. Null means render no `qa` row.
 */
export function qaSignalStatusRow(
  target: QaSignalTarget = {},
  now: number = Date.now(),
): { value: string; pointer: QaSignalPointer } | null {
  try {
    const pointer = readQaSignal(target);
    const value = formatQaSignalRow(pointer, now);
    if (!pointer || !value) return null;
    return { value, pointer };
  } catch {
    return null;
  }
}
