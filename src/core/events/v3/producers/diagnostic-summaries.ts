import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { coordEnv } from "../../../../lib/env.ts";
import { fsyncParentDirectory } from "../../../workflow/durable-record.ts";
import { acquireNoClobberLease } from "../../../workflow/workspaces/leases.ts";
import { EVENT_V3_LEDGER_RELATIVE_ROOT } from "../writer.ts";

/**
 * Producer-side bound on duplicate diagnostic file creation.
 *
 * A producer fault can emit the same diagnostic thousands of times per day,
 * and every emission used to become one loose file in the diagnostics spool.
 * This module keeps the first bounded loose exemplars per
 * (category, reason, instance) key and UTC day unchanged, then coalesces
 * further identical emissions into one deterministic summary file per key and
 * window, preserving the exact logical count, first and last times,
 * represented bytes, hourly rate buckets, and bounded exemplar digests.
 *
 * Below the bound the gate creates no state at all: admitted loose filenames
 * carry the key digest as a suffix, and the gate counts a key's emissions for
 * the window from those filenames alone. A summary file and its short-lived
 * per-key lease exist only for a key that actually crossed the bound, so a
 * healthy spool gains zero files and zero directories from this mitigation.
 *
 * The mitigation is fail-open: any count, lease, read, or publish failure
 * admits the loose diagnostic exactly as before and appends to a lock-free,
 * size-capped emergency log. It never deletes, moves, or rewrites an existing
 * loose diagnostic, and it never calls back into the diagnostic writer.
 */

export const DIAGNOSTIC_SUMMARY_FORMAT = "harnery-v3-diagnostic-summary" as const;
export const DIAGNOSTIC_SUMMARY_VERSION = 1 as const;

/**
 * Loose exemplars admitted per (category, reason, instance) key per UTC day
 * before identical emissions coalesce into the key's summary. Frozen from a
 * whole-history measurement: healthy categories peak well under this value
 * per day across ALL keys combined, while a producer fault exceeds it within
 * minutes. The bound is enforced from filename counts without cross-process
 * locking, so simultaneous writers straddling the crossing can admit a few
 * extra exemplars; the bound is a flood stop, not an exact quota.
 */
export const DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT = 32;

/** Bounded exemplar digests retained inside one summary. */
const SUMMARY_EXEMPLAR_LIMIT = 4;
/**
 * Hourly rate buckets retained inside one summary. One summary covers one UTC
 * day, so at most 24 buckets are reachable; the margin absorbs clock skew.
 * Consumer windows wider than a day (doctor reads 48h) span multiple
 * day-scoped summary files, not more buckets in one file.
 */
const SUMMARY_HOUR_BUCKET_LIMIT = 26;
/** Refuse to publish a summary larger than this; falls open to loose writes. */
const SUMMARY_MAX_BYTES = 128 * 1024;
/** Coalesce updates fsync only every Nth increment; a crash between durable
 * points can lose at most this many recent increments from the summary. */
const SUMMARY_DURABLE_EVERY = 32;
/** Stop appending to the emergency fail-open log past this size. */
const MITIGATION_HEALTH_MAX_BYTES = 256 * 1024;
export const DIAGNOSTIC_MITIGATION_HEALTH_FILE = "mitigation-health.ndjson";
const LEASE_STALE_AFTER_MS = 5_000;
const LEASE_RETRIES = 4;
const LEASE_RETRY_MS = 10;
const METADATA_KEY_LIMIT = 16;
const METADATA_VALUE_LIMIT = 256;
/** Extracts the 15-digit epoch-ms segment of a loose diagnostic order key. */
const LOOSE_ORDER_KEY_TIMESTAMP = /-(\d{15})-\d{20}-/;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export interface DiagnosticContentFingerprint {
  bytes: number;
  sha256: string;
}

export interface DiagnosticGateInputV3 {
  /** Already sanitized by the diagnostic writer. */
  category: string;
  reason?: string;
  instanceId?: string;
  fingerprint: DiagnosticContentFingerprint;
  /** Approved scalar metadata only; stored once per summary. */
  metadata: Record<string, string | number | boolean | null>;
}

export type DiagnosticGateDecisionV3 =
  | {
      admit: true;
      /**
       * Appended to the loose filename before `.json` so future gate calls
       * can count the key's admitted exemplars from the directory listing.
       * Empty when the gate is disabled.
       */
      loose_name_suffix: string;
    }
  | {
      admit: false;
      /** The summary file the emission was durably coalesced into. */
      summary_path: string;
    };

export interface DiagnosticSummaryV3 {
  format: typeof DIAGNOSTIC_SUMMARY_FORMAT;
  format_version: typeof DIAGNOSTIC_SUMMARY_VERSION;
  category: string;
  reason: string;
  instance_id: string;
  /** UTC day this summary covers, as YYYY-MM-DD. */
  window: string;
  /** Loose exemplar files observed for the key when the bound was crossed. */
  loose_count: number;
  /** Identical emissions coalesced here instead of becoming loose files. */
  summarized_count: number;
  first_summarized_at: string | null;
  last_summarized_at: string | null;
  /** Sum of content-fingerprint bytes across summarized emissions. */
  represented_bytes: number;
  /** Digests of the first summarized emissions, bounded. */
  exemplars: DiagnosticContentFingerprint[];
  /** Approved scalar metadata from the first summarized emission. */
  metadata: Record<string, string | number | boolean | null>;
  /** Summarized-only counts per UTC hour ("YYYY-MM-DDTHH"), pruned. */
  recent_hours: Record<string, number>;
}

/** Aggregate of the append-only emergency fail-open log. */
export interface DiagnosticMitigationHealthV3 {
  fail_open_count: number;
  last_fail_open_at: string | null;
  by_stage: Record<string, number>;
  /** True when the log hit its size cap and later fail-opens were dropped. */
  truncated: boolean;
}

export function diagnosticSummariesRootV3(coordRoot: string): string {
  return join(resolve(coordRoot), EVENT_V3_LEDGER_RELATIVE_ROOT, "diagnostic-summaries");
}

function looseDiagnosticsRootV3(coordRoot: string): string {
  return join(resolve(coordRoot), EVENT_V3_LEDGER_RELATIVE_ROOT, "diagnostics");
}

export function diagnosticSummariesEnabledV3(): boolean {
  return coordEnv("V3_DIAGNOSTIC_SUMMARIES") !== "0";
}

function sanitizeComponent(value: string | undefined, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  return safe.length > 0 ? safe : fallback;
}

function keyDigest(category: string, reason: string, instanceId: string): string {
  return createHash("sha256")
    .update(`${category}\n${reason}\n${instanceId}`)
    .digest("hex")
    .slice(0, 16);
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function utcHour(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 13);
}

function summaryPath(root: string, category: string, window: string, digest: string): string {
  return join(root, `${category}-${window.replaceAll("-", "")}-${digest}.json`);
}

function ensureOwnerOnlyDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function publishOwnerOnlyJson(path: string, value: unknown, durable: boolean): void {
  const contents = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(contents, "utf8") > SUMMARY_MAX_BYTES) {
    throw new Error("diagnostic summary exceeds its size bound");
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, contents, "utf8");
    if (durable) fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    if (durable) fsyncParentDirectory(path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function withKeyLease<T>(root: string, digest: string, operation: () => T): T {
  const leasesDir = join(root, "leases");
  ensureOwnerOnlyDirectory(leasesDir);
  const leaseDir = join(leasesDir, digest);
  const authority = createHash("sha256").update(resolve(root)).digest("hex");
  let lease: ReturnType<typeof acquireNoClobberLease> | undefined;
  for (let attempt = 0; attempt < LEASE_RETRIES; attempt += 1) {
    try {
      lease = acquireNoClobberLease({
        path: leaseDir,
        scope: "event-v3-diagnostic-summary",
        authoritySha256: authority,
        staleAfterMs: LEASE_STALE_AFTER_MS,
        validateStaleOwner: (owner) => owner.host === hostname() && !pidIsAlive(owner.pid),
      });
      break;
    } catch (error) {
      if (attempt === LEASE_RETRIES - 1) throw error;
      Atomics.wait(sleepCell, 0, 0, LEASE_RETRY_MS);
    }
  }
  if (!lease) throw new Error("diagnostic summary lease is busy");
  try {
    return operation();
  } finally {
    // A durably published result must survive release-time faults (an epoch
    // rotation can remove the lease state mid-operation); stale takeover
    // recovers any residue. The empty lease directory is removed so per-key
    // lease state never outlives the contention that needed it.
    try {
      lease.release();
    } catch {
      // Swallowed: the operation's outcome already stands.
    }
    try {
      rmdirSync(leaseDir);
    } catch {
      // A concurrent acquirer repopulated it, or release left residue.
    }
  }
}

/**
 * Count the key's admitted loose exemplars for a UTC-day window from their
 * digest-suffixed filenames. Files written before this mitigation carry no
 * suffix and are not counted, so a pre-existing flood does not consume the
 * window's exemplar budget.
 */
function countLooseExemplars(coordRoot: string, digest: string, window: string): number {
  const directory = looseDiagnosticsRootV3(coordRoot);
  if (!existsSync(directory)) return 0;
  const windowStartMs = Date.parse(`${window}T00:00:00.000Z`);
  const windowEndMs = windowStartMs + 24 * 60 * 60 * 1000;
  const suffix = `-${digest}.json`;
  let count = 0;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(suffix)) continue;
    const epochMs = Number(LOOSE_ORDER_KEY_TIMESTAMP.exec(name)?.[1]);
    if (Number.isFinite(epochMs) && epochMs >= windowStartMs && epochMs < windowEndMs) {
      count += 1;
    }
  }
  return count;
}

function boundedMetadata(
  metadata: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const bounded: Record<string, string | number | boolean | null> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(metadata)) {
    if (kept >= METADATA_KEY_LIMIT) break;
    if (typeof value === "string" && value.length > METADATA_VALUE_LIMIT) continue;
    bounded[key] = value;
    kept += 1;
  }
  return bounded;
}

function pruneHourBuckets(buckets: Record<string, number>, nowMs: number): Record<string, number> {
  const keys = Object.keys(buckets).sort();
  const horizon = utcHour(nowMs - SUMMARY_HOUR_BUCKET_LIMIT * 60 * 60 * 1000);
  const pruned: Record<string, number> = {};
  for (const key of keys) {
    if (key >= horizon) pruned[key] = buckets[key] as number;
  }
  // A pathological clock can still grow the map; hard-cap by newest keys.
  const capped = Object.keys(pruned).sort().slice(-SUMMARY_HOUR_BUCKET_LIMIT);
  const result: Record<string, number> = {};
  for (const key of capped) result[key] = pruned[key] as number;
  return result;
}

function freshSummary(
  category: string,
  reason: string,
  instanceId: string,
  window: string,
): DiagnosticSummaryV3 {
  return {
    format: DIAGNOSTIC_SUMMARY_FORMAT,
    format_version: DIAGNOSTIC_SUMMARY_VERSION,
    category,
    reason,
    instance_id: instanceId,
    window,
    loose_count: 0,
    summarized_count: 0,
    first_summarized_at: null,
    last_summarized_at: null,
    represented_bytes: 0,
    exemplars: [],
    metadata: {},
    recent_hours: {},
  };
}

function readSummaryFile(path: string): DiagnosticSummaryV3 | undefined {
  let parsed: unknown;
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const summary = parsed as DiagnosticSummaryV3;
  if (
    summary.format !== DIAGNOSTIC_SUMMARY_FORMAT ||
    summary.format_version !== DIAGNOSTIC_SUMMARY_VERSION ||
    typeof summary.category !== "string" ||
    typeof summary.reason !== "string" ||
    typeof summary.instance_id !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(summary.window) ||
    !Number.isSafeInteger(summary.loose_count) ||
    summary.loose_count < 0 ||
    !Number.isSafeInteger(summary.summarized_count) ||
    summary.summarized_count < 0 ||
    !Number.isSafeInteger(summary.represented_bytes) ||
    summary.represented_bytes < 0 ||
    !Array.isArray(summary.exemplars) ||
    !summary.recent_hours ||
    typeof summary.recent_hours !== "object" ||
    Array.isArray(summary.recent_hours)
  ) {
    return undefined;
  }
  // Drop malformed rate buckets so a corrupt value can neither poison later
  // increments nor silently diverge windowed counts from the total.
  const hours: Record<string, number> = {};
  for (const [key, value] of Object.entries(summary.recent_hours)) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(key) && Number.isSafeInteger(value) && value >= 0) {
      hours[key] = value;
    }
  }
  summary.recent_hours = hours;
  return summary;
}

/**
 * Append one line to the emergency fail-open log. Lock-free by design: an
 * O_APPEND write of one small line is atomic, so concurrent fail-opens never
 * serialize on shared state. Best-effort, size-capped, and nonrecursive: a
 * failure here is swallowed, never diagnosed, and never blocks the loose
 * fallback write.
 */
function recordFailOpen(root: string, stage: string, nowMs: number): void {
  try {
    ensureOwnerOnlyDirectory(root);
    const path = join(root, DIAGNOSTIC_MITIGATION_HEALTH_FILE);
    try {
      if (statSync(path).size >= MITIGATION_HEALTH_MAX_BYTES) return;
    } catch {
      // Missing log starts fresh.
    }
    const line = JSON.stringify({ at: new Date(nowMs).toISOString(), stage, pid: process.pid });
    appendFileSync(path, `${line}\n`, { mode: 0o600 });
  } catch {
    // The emergency log may undercount when storage is unavailable; it is a
    // signal, not accounting, and must never throw into the producer path.
  }
}

function readMitigationHealth(path: string): DiagnosticMitigationHealthV3 | null {
  let contents: string;
  let size = 0;
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    size = metadata.size;
    contents = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const health: DiagnosticMitigationHealthV3 = {
    fail_open_count: 0,
    last_fail_open_at: null,
    by_stage: {},
    truncated: size >= MITIGATION_HEALTH_MAX_BYTES,
  };
  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    // Every non-empty line was one fail-open, even a torn one.
    health.fail_open_count += 1;
    try {
      const row = JSON.parse(line) as { at?: unknown; stage?: unknown };
      if (typeof row.at === "string") health.last_fail_open_at = row.at;
      if (typeof row.stage === "string" && row.stage.length <= 32) {
        if (Object.keys(health.by_stage).length < 16 || health.by_stage[row.stage] !== undefined) {
          health.by_stage[row.stage] = (health.by_stage[row.stage] ?? 0) + 1;
        }
      }
    } catch {
      // A torn tail line still counts above.
    }
  }
  return health;
}

/**
 * Decide whether one diagnostic emission may become a loose file.
 *
 * Below the per-key bound (counted from digest-suffixed loose filenames) the
 * emission is admitted with the suffix to append, and no summary or lease
 * state is created. At or past the bound the emission is durably coalesced
 * into the key's summary under a short per-key lease and `admit: false` is
 * returned with the summary path. Any mitigation failure, and the disabled
 * gate, admit the loose write exactly as before.
 */
export function gateProducerDiagnosticV3(
  coordRoot: string,
  input: DiagnosticGateInputV3,
  nowMs = Date.now(),
): DiagnosticGateDecisionV3 {
  if (!diagnosticSummariesEnabledV3()) return { admit: true, loose_name_suffix: "" };
  const at = Number.isFinite(nowMs) ? nowMs : Date.now();
  const category = sanitizeComponent(input.category, "unknown");
  const reason = sanitizeComponent(input.reason, "none");
  const instanceId = sanitizeComponent(input.instanceId, "unknown");
  const window = utcDay(at);
  const digest = keyDigest(category, reason, instanceId);
  const admitLoose: DiagnosticGateDecisionV3 = { admit: true, loose_name_suffix: `-${digest}` };
  const root = diagnosticSummariesRootV3(coordRoot);
  let stage = "peek";
  try {
    const path = summaryPath(root, category, window, digest);
    if (!readSummaryFile(path)) {
      stage = "count";
      if (countLooseExemplars(coordRoot, digest, window) < DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT) {
        return admitLoose;
      }
    }
    stage = "coalesce";
    ensureOwnerOnlyDirectory(root);
    return withKeyLease(root, digest, () => {
      const existing = readSummaryFile(path);
      const state = existing ?? freshSummary(category, reason, instanceId, window);
      if (!existing) state.loose_count = countLooseExemplars(coordRoot, digest, window);
      const atIso = new Date(at).toISOString();
      state.summarized_count += 1;
      state.first_summarized_at ??= atIso;
      state.last_summarized_at = atIso;
      if (Number.isSafeInteger(input.fingerprint?.bytes) && input.fingerprint.bytes >= 0) {
        state.represented_bytes += input.fingerprint.bytes;
      }
      if (state.exemplars.length < SUMMARY_EXEMPLAR_LIMIT && input.fingerprint) {
        state.exemplars.push({
          bytes: input.fingerprint.bytes,
          sha256: input.fingerprint.sha256,
        });
      }
      if (Object.keys(state.metadata).length === 0) {
        state.metadata = boundedMetadata(input.metadata ?? {});
      }
      const hour = utcHour(at);
      state.recent_hours[hour] = (state.recent_hours[hour] ?? 0) + 1;
      state.recent_hours = pruneHourBuckets(state.recent_hours, at);
      const durable = !existing || state.summarized_count % SUMMARY_DURABLE_EVERY === 0;
      publishOwnerOnlyJson(path, state, durable);
      return { admit: false, summary_path: path };
    });
  } catch {
    recordFailOpen(root, stage, at);
    return admitLoose;
  }
}

export interface DiagnosticSummaryListingV3 {
  summaries: DiagnosticSummaryV3[];
  /** Physical summary files, including any that failed validation. */
  file_count: number;
  unreadable_count: number;
  mitigation_health: DiagnosticMitigationHealthV3 | null;
}

/**
 * Read every summary in the active epoch's `diagnostic-summaries/` subtree.
 * Skips lease state, temp files, and the mitigation health log (which is
 * aggregated into `mitigation_health` instead). Never throws; a missing
 * subtree returns an empty listing.
 */
export function listDiagnosticSummariesV3(coordRoot: string): DiagnosticSummaryListingV3 {
  const root = diagnosticSummariesRootV3(coordRoot);
  const listing: DiagnosticSummaryListingV3 = {
    summaries: [],
    file_count: 0,
    unreadable_count: 0,
    mitigation_health: null,
  };
  let names: string[];
  try {
    const metadata = lstatSync(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return listing;
    names = readdirSync(root);
  } catch {
    return listing;
  }
  for (const name of names.sort()) {
    if (name === "leases" || name.includes(".tmp-")) continue;
    if (name.startsWith("mitigation-health")) {
      if (name === DIAGNOSTIC_MITIGATION_HEALTH_FILE) {
        listing.mitigation_health = readMitigationHealth(join(root, name));
      }
      continue;
    }
    if (!name.endsWith(".json")) continue;
    listing.file_count += 1;
    const summary = readSummaryFile(join(root, name));
    if (summary) listing.summaries.push(summary);
    else listing.unreadable_count += 1;
  }
  return listing;
}

/**
 * Sum summarized-only occurrences inside a lookback window, from hour
 * buckets. Hour-granular and conservative: a bucket is counted only when its
 * whole hour lies inside `[sinceMs, nowMs]`, so a boundary bucket is excluded
 * (up to 59 minutes undercounted) rather than fully included (up to 59
 * minutes overcounted), and a future-dated bucket from clock skew never
 * inflates a window.
 */
export function countSummarizedSinceV3(
  summaries: readonly DiagnosticSummaryV3[],
  sinceMs: number,
  filter?: (summary: DiagnosticSummaryV3) => boolean,
  nowMs = Date.now(),
): number {
  let count = 0;
  for (const summary of summaries) {
    if (filter && !filter(summary)) continue;
    for (const [hour, value] of Object.entries(summary.recent_hours)) {
      const hourStartMs = Date.parse(`${hour}:00:00.000Z`);
      if (
        Number.isFinite(hourStartMs) &&
        hourStartMs >= sinceMs &&
        hourStartMs <= nowMs &&
        Number.isSafeInteger(value) &&
        value > 0
      ) {
        count += value;
      }
    }
  }
  return count;
}
