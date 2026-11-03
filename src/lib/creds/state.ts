/**
 * Small state files and pure helpers behind credential heal and verify.
 *
 * Revisions: heal restores missing files at session start, but a file that
 * exists and holds a revoked key looks healthy. A registry entry can carry a
 * `revision`; bumping it in a commit tells every clone that its copy predates
 * a rotation. Heal compares the entry's revision with the one recorded when
 * this clone last pulled the file and refreshes when the entry is newer.
 * Files pulled before the record existed count as revision 1.
 *
 * Backoff: when a pull fails for a reason a retry cannot fix (an item the
 * account cannot see, or one never created), retrying at every session start
 * means an approval prompt every time, for a credential that will fail again.
 * The failure is recorded and the key skipped until the delay passes. The
 * delay ends early when the pull script changes after the failure, because a
 * fix to the script is the usual repair.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CredManifestEntry, ItemGroup } from "./types.ts";

function loadObject<T>(path: string): T {
  if (!existsSync(path)) return {} as T;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : ({} as T);
  } catch {
    return {} as T;
  }
}

function saveObject(path: string, state: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // Losing the record costs one extra pull or retry, nothing more.
  }
}

export type RevisionState = Record<string, number>;

/** Key under which a file's pulled revision is recorded. */
export function revisionKey(repo: string, path: string): string {
  return `${repo}:${path}`;
}

export function loadRevisions(path: string): RevisionState {
  return loadObject<RevisionState>(path);
}

export function saveRevisions(path: string, state: RevisionState): void {
  saveObject(path, state);
}

/** True when the registry's revision is newer than what this clone last pulled. */
export function isStaleRevision(wanted: number | undefined, pulled: number | undefined): boolean {
  return (wanted ?? 1) > (pulled ?? 1);
}

export interface HealFailure {
  failed_at: string;
  detail?: string;
}

export type HealBackoffState = Record<string, HealFailure>;

export const DEFAULT_HEAL_BACKOFF_HOURS = 24;

/** Retry delay in hours from `envName`, or the default when unset or invalid. */
export function healBackoffHours(envName: string, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[envName];
  const hours = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_HEAL_BACKOFF_HOURS;
}

export function loadHealBackoff(path: string): HealBackoffState {
  return loadObject<HealBackoffState>(path);
}

export function saveHealBackoff(path: string, state: HealBackoffState): void {
  saveObject(path, state);
}

/**
 * When the key may be retried, or null if it may be retried now.
 * `scriptMtimeMs` is the newest mtime among the key's pull scripts.
 */
export function healRetryAfter(
  failure: HealFailure | undefined,
  nowMs: number,
  hours: number,
  scriptMtimeMs: number | null,
): Date | null {
  if (!failure) return null;
  const failedMs = Date.parse(failure.failed_at);
  if (!Number.isFinite(failedMs)) return null;
  // failed_at keeps whole milliseconds while mtimeMs can carry a fraction.
  // Compare at the coarser precision, or a script written earlier in the same
  // millisecond would count as changed after the failure.
  if (scriptMtimeMs !== null && Math.floor(scriptMtimeMs) > failedMs) return null;
  const retryMs = failedMs + hours * 3_600_000;
  return retryMs > nowMs ? new Date(retryMs) : null;
}

/**
 * Group manifest entries by item, merging fields and scripts, so verify makes
 * one `op` call per item. A field is pending when every entry naming it is.
 */
export function groupByItem(entries: CredManifestEntry[]): ItemGroup[] {
  const map = new Map<string, ItemGroup>();
  for (const e of entries) {
    const key = `${e.vault}\0${e.item}`;
    let g = map.get(key);
    if (!g) {
      g = {
        vault: e.vault,
        item: e.item,
        fields: [],
        scripts: [],
        pendingFields: [],
        pending: true,
        kind: e.kind ?? "fields",
      };
      map.set(key, g);
    }
    for (const f of e.fields) if (!g.fields.includes(f)) g.fields.push(f);
    for (const s of e.scripts) if (!g.scripts.includes(s)) g.scripts.push(s);
    if (e.kind === "document") g.kind = "document";
    if (e.pending !== true) g.pending = false;
  }
  for (const g of map.values()) {
    for (const f of g.fields) {
      const refs = entries.filter(
        (e) => e.vault === g.vault && e.item === g.item && e.fields.includes(f),
      );
      if (refs.length > 0 && refs.every((e) => e.pending === true)) g.pendingFields.push(f);
    }
  }
  return [...map.values()];
}

const OP_TRANSPORT_FAILURES = [
  /UtilAcceptVsock/i,
  /accept4 failed/i,
  /connection (refused|reset)/i,
  /could not connect/i,
  /error communicating with/i,
  /broken pipe/i,
  /timed out/i,
  /EOF$/i,
];

/** True when a 1Password call failed in transit instead of returning a vault verdict. */
export function isTransportFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message.trim() : String(error ?? "").trim();
  if (!text) return false;
  return OP_TRANSPORT_FAILURES.some((rx) => rx.test(text));
}

/** Retry only reads whose failure says nothing about the item itself. */
export async function readItemWithRetry<T>(
  read: () => Promise<T>,
  attempts = 3,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (!isTransportFailure(error) || attempt === attempts) throw error;
      await wait(250 * attempt);
    }
  }
  throw lastError;
}
