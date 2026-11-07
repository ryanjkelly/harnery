/**
 * Freshness helpers shared by `harn backup snapshot` and the session-start
 * scheduler. The host cache is a local, best-effort record of this machine's
 * newest known snapshot: the scheduler reads it to skip a remote restic round
 * trip when the host is plainly current, and restic stays the authority
 * whenever the cache is missing, stale, or written by another host.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { parseDurationMs } from "../../lib/duration.ts";

/** Parse an `--if-stale` window such as `24h` or `7d`; null when unreadable. */
export function parseBackupDuration(value: string): number | null {
  return parseDurationMs(value);
}

/** Newest snapshot time (epoch ms) in `restic snapshots --json` output, or null. */
export function newestSnapshotTime(output: string): number | null {
  try {
    const rows = JSON.parse(output) as Array<{ time?: string }>;
    const newest = rows.reduce((latest, row) => {
      const time = typeof row.time === "string" ? Date.parse(row.time) : Number.NaN;
      return Number.isFinite(time) ? Math.max(latest, time) : latest;
    }, Number.NEGATIVE_INFINITY);
    return Number.isFinite(newest) ? newest : null;
  } catch {
    return null;
  }
}

export interface HostSnapshotCache {
  host: string;
  snapshotAt: number;
}

export function hostSnapshotCachePath(harneryDir: string): string {
  return path.join(harneryDir, "logs", "backup-host-snapshot.json");
}

export function readHostSnapshotCache(harneryDir: string): HostSnapshotCache | null {
  try {
    const parsed = JSON.parse(readFileSync(hostSnapshotCachePath(harneryDir), "utf8")) as {
      host?: unknown;
      snapshot_at?: unknown;
    };
    const snapshotAt =
      typeof parsed.snapshot_at === "string" ? Date.parse(parsed.snapshot_at) : Number.NaN;
    if (typeof parsed.host !== "string" || !Number.isFinite(snapshotAt)) return null;
    return { host: parsed.host, snapshotAt };
  } catch {
    return null;
  }
}

export function recordHostSnapshot(harneryDir: string, snapshotAt: number): void {
  try {
    const file = hostSnapshotCachePath(harneryDir);
    mkdirSync(path.dirname(file), { recursive: true });
    const body = `${JSON.stringify({
      host: hostname(),
      snapshot_at: new Date(snapshotAt).toISOString(),
      recorded_at: new Date().toISOString(),
    })}\n`;
    writeFileSync(`${file}.tmp`, body, "utf8");
    renameSync(`${file}.tmp`, file);
  } catch {
    // The cache is an optimisation; a failed write only costs a restic query later.
  }
}
