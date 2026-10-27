// Append-only history of admission slot use. The queue files in admission.ts
// describe only the present: a waiter or holder disappears the moment it is
// admitted, released, or pruned. This module keeps one JSON line per finished
// ticket so a later reader can answer how long work queued, behind what, and
// how long each holder kept its slot.
//
// Layout: <history dir>/<resource>.jsonl, rotated to <resource>.1.jsonl once
// it passes HISTORY_ROTATE_BYTES. Each line is a complete record appended in a
// single write, so concurrent writers on one machine never interleave.
//
// Toolkit tier: this module must not import src/core (layering check).

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { coordEnv } from "./env.ts";

export const ADMISSION_HISTORY_SCHEMA_VERSION = 1;

/** Rotate a resource's history once it passes this size; one older file is kept. */
const HISTORY_ROTATE_BYTES = 8 * 1024 * 1024;

/**
 * How a ticket ended.
 * - `released`: the holder ran and gave the slot back.
 * - `timeout`: no slot freed before the waiter's deadline.
 * - `abandoned`: the process died while waiting or holding; a peer pruned it.
 * - `expired`: the entry outlived the queue TTL and a peer pruned it.
 */
export type AdmissionHistoryOutcome = "released" | "timeout" | "abandoned" | "expired";

export interface AdmissionHistoryRecord {
  v: typeof ADMISSION_HISTORY_SCHEMA_VERSION;
  resource: string;
  label: string;
  pid: number;
  /** Working directory of the process that queued, when known. */
  cwd?: string;
  capacity?: number;
  outcome: AdmissionHistoryOutcome;
  enqueued_at: string;
  acquired_at?: string;
  /** When the slot was released, the wait gave up, or a peer pruned the entry. */
  ended_at: string;
  /** Time spent in the queue. For an entry pruned while waiting, an upper bound. */
  wait_ms: number;
  /** Time the slot was held. For an entry pruned while holding, an upper bound. */
  hold_ms?: number;
  /** Labels of the holders when this ticket first had to wait. */
  waited_behind?: string[];
  /** Time spent deferring for memory pressure before joining the queue. */
  pressure_wait_ms?: number;
  exit_code?: number | null;
  signal?: string | null;
}

/** Outcome details a caller can attach when it releases its slot. */
export interface AdmissionReleaseResult {
  exitCode?: number | null;
  signal?: string | null;
}

/**
 * Persistent machine-wide history directory used for the default admission
 * queue root. The queues live in tmpdir and correctly vanish at reboot; the
 * history is evidence and must survive one.
 */
export function defaultAdmissionHistoryDir(): string {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "harnery", "admission-history");
}

/** Directory name of a machine-wide queue root (see admissionBaseDir). */
const SHARED_QUEUE_DIRNAME = "harnery-admission";

/**
 * Where history for a given queue root is written, or null when disabled.
 * HARNERY_ADMISSION_HISTORY=off disables recording; HARNERY_ADMISSION_HISTORY_DIR
 * overrides the location. A machine-wide queue root, named `harnery-admission`
 * under any temp directory, records to the persistent state directory. Any
 * other root (an isolated test queue, for example) records beside itself as
 * `<root>-history`, so isolated queues never write into the
 * machine-wide history and the history directory is never listed as a resource.
 */
export function resolveAdmissionHistoryDir(queueDir: string): string | null {
  const toggle = coordEnv("ADMISSION_HISTORY")?.trim().toLowerCase();
  if (toggle === "off" || toggle === "0" || toggle === "false") return null;
  const override = coordEnv("ADMISSION_HISTORY_DIR");
  if (override) return override;
  return basename(queueDir) === SHARED_QUEUE_DIRNAME
    ? defaultAdmissionHistoryDir()
    : `${queueDir}-history`;
}

function historyFile(dir: string, resource: string, generation = 0): string {
  return join(dir, generation === 0 ? `${resource}.jsonl` : `${resource}.${generation}.jsonl`);
}

/**
 * Append one record. History is diagnostic: a write failure never fails the
 * caller's admission, so errors are swallowed.
 */
export function appendAdmissionHistory(dir: string | null, record: AdmissionHistoryRecord): void {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const path = historyFile(dir, record.resource);
    try {
      if (statSync(path).size > HISTORY_ROTATE_BYTES) {
        renameSync(path, historyFile(dir, record.resource, 1));
      }
    } catch {
      // no file yet, or a peer rotated it first
    }
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    // diagnostic only
  }
}

/** Resources with recorded history in a history directory. */
export function listAdmissionHistoryResources(dir: string): string[] {
  try {
    const names = new Set<string>();
    for (const name of readdirSync(dir)) {
      const match = /^(.+?)(?:\.1)?\.jsonl$/.exec(name);
      if (match?.[1]) names.add(match[1]);
    }
    return [...names].sort();
  } catch {
    return [];
  }
}

function parseRecord(line: string): AdmissionHistoryRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Partial<AdmissionHistoryRecord>;
    if (
      typeof record.resource !== "string" ||
      typeof record.outcome !== "string" ||
      typeof record.enqueued_at !== "string" ||
      typeof record.ended_at !== "string" ||
      typeof record.wait_ms !== "number"
    ) {
      return undefined;
    }
    return record as AdmissionHistoryRecord;
  } catch {
    return undefined;
  }
}

export interface AdmissionHistoryQuery {
  resource?: string;
  /** Keep records that ended at or after this epoch-ms. */
  sinceMs?: number;
  /** Keep records whose label contains this text (case-insensitive). */
  labelContains?: string;
}

/** Read history records, oldest first, across the current and rotated files. */
export function readAdmissionHistory(
  dir: string | null,
  query: AdmissionHistoryQuery = {},
): AdmissionHistoryRecord[] {
  if (!dir) return [];
  const resources =
    query.resource !== undefined ? [query.resource] : listAdmissionHistoryResources(dir);
  const needle = query.labelContains?.toLowerCase();
  const records: AdmissionHistoryRecord[] = [];
  for (const resource of resources) {
    for (const path of [historyFile(dir, resource, 1), historyFile(dir, resource)]) {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        const record = parseRecord(line);
        if (!record) continue;
        if (query.sinceMs !== undefined && Date.parse(record.ended_at) < query.sinceMs) continue;
        if (needle && !record.label.toLowerCase().includes(needle)) continue;
        records.push(record);
      }
    }
  }
  return records.sort((a, b) => Date.parse(a.ended_at) - Date.parse(b.ended_at));
}

export interface AdmissionHistoryGroup {
  resource: string;
  label: string;
  count: number;
  /** Records that waited at least one second for a slot. */
  queued: number;
  wait_ms: { p50: number; p90: number; max: number; total: number };
  /** Hold statistics over released records only. */
  hold_ms: { p50: number; p90: number; max: number } | null;
  outcomes: Partial<Record<AdmissionHistoryOutcome, number>>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

const QUEUED_THRESHOLD_MS = 1_000;

/**
 * Group records by resource and label, most total wait first, so the work
 * that spends the longest queueing leads the report.
 */
export function summarizeAdmissionHistory(
  records: AdmissionHistoryRecord[],
): AdmissionHistoryGroup[] {
  const groups = new Map<string, AdmissionHistoryRecord[]>();
  for (const record of records) {
    const key = `${record.resource}\u0000${record.label}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(record);
    else groups.set(key, [record]);
  }
  const summaries: AdmissionHistoryGroup[] = [];
  for (const bucket of groups.values()) {
    const first = bucket[0] as AdmissionHistoryRecord;
    const waits = bucket.map((record) => record.wait_ms).sort((a, b) => a - b);
    const holds = bucket
      .filter((record) => record.outcome === "released" && typeof record.hold_ms === "number")
      .map((record) => record.hold_ms as number)
      .sort((a, b) => a - b);
    const outcomes: Partial<Record<AdmissionHistoryOutcome, number>> = {};
    for (const record of bucket) outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1;
    summaries.push({
      resource: first.resource,
      label: first.label,
      count: bucket.length,
      queued: waits.filter((wait) => wait >= QUEUED_THRESHOLD_MS).length,
      wait_ms: {
        p50: percentile(waits, 0.5),
        p90: percentile(waits, 0.9),
        max: waits[waits.length - 1] ?? 0,
        total: waits.reduce((sum, wait) => sum + wait, 0),
      },
      hold_ms:
        holds.length > 0
          ? {
              p50: percentile(holds, 0.5),
              p90: percentile(holds, 0.9),
              max: holds[holds.length - 1] ?? 0,
            }
          : null,
      outcomes,
    });
  }
  return summaries.sort((a, b) => b.wait_ms.total - a.wait_ms.total);
}
