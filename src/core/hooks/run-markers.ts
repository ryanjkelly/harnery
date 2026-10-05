/**
 * Start markers for hook runs on adapters that kill a hook at its `timeout`
 * (ADR 0197). A Codex hook that times out has its process tree killed and the
 * tool proceeds without that hook's checks, and the killed process never
 * reaches the completion receipt in `health.ts`. A small marker written at
 * start and removed at completion leaves evidence of that case for doctor.
 *
 * Observer-only: every write, read, and removal swallows its own errors so a
 * marker can never change hook behavior.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Markers older than this are pruned when a new one is written. */
const MARKER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** A run is unfinished once its marker outlives the timeout by this much. */
const UNFINISHED_GRACE_MS = 30_000;

export interface HookRunMarker {
  event: string;
  adapter: string;
  pid: number;
  started_at: string;
  timeout_sec: number;
}

export function hookRunMarkerDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "active", "hook-runs");
}

/** Write this run's marker; returns its path, or null when it could not be written. */
export function writeHookRunMarker(
  coordRoot: string,
  marker: Omit<HookRunMarker, "started_at">,
  now = new Date(),
): string | null {
  try {
    const dir = hookRunMarkerDir(coordRoot);
    mkdirSync(dir, { recursive: true });
    pruneHookRunMarkers(dir, now.getTime());
    const path = join(dir, `${marker.pid}-${safeName(marker.event)}.json`);
    const body: HookRunMarker = { ...marker, started_at: now.toISOString() };
    writeFileSync(path, `${JSON.stringify(body)}\n`);
    return path;
  } catch {
    return null;
  }
}

export function clearHookRunMarker(path: string | null): void {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // Observer-only.
  }
}

export interface UnfinishedHookRuns {
  count: number;
  /** Count per event name, most frequent first. */
  events: Array<{ event: string; count: number }>;
  latest: string | null;
}

/**
 * Markers whose run outlived its timeout plus a grace period and whose
 * process is gone, within the window. A live process past its timeout is
 * still running and is not counted.
 */
export function findUnfinishedHookRuns(
  coordRoot: string,
  nowMs = Date.now(),
  windowMs = 24 * 60 * 60 * 1000,
  isAlive: (pid: number) => boolean = processAlive,
): UnfinishedHookRuns {
  const counts = new Map<string, number>();
  let latest: string | null = null;
  let count = 0;
  let names: string[] = [];
  try {
    names = readdirSync(hookRunMarkerDir(coordRoot)).filter((n) => n.endsWith(".json"));
  } catch {
    return { count: 0, events: [], latest: null };
  }
  for (const name of names) {
    let marker: HookRunMarker;
    try {
      marker = JSON.parse(
        readFileSync(join(hookRunMarkerDir(coordRoot), name), "utf8"),
      ) as HookRunMarker;
    } catch {
      continue;
    }
    const started = Date.parse(marker.started_at);
    if (!Number.isFinite(started) || nowMs - started > windowMs) continue;
    if (nowMs - started < marker.timeout_sec * 1000 + UNFINISHED_GRACE_MS) continue;
    if (isAlive(marker.pid)) continue;
    count++;
    counts.set(marker.event, (counts.get(marker.event) ?? 0) + 1);
    if (!latest || marker.started_at > latest) latest = marker.started_at;
  }
  const events = [...counts.entries()]
    .map(([event, n]) => ({ event, count: n }))
    .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event));
  return { count, events, latest };
}

function pruneHookRunMarkers(dir: string, nowMs: number): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (nowMs - statSync(path).mtimeMs > MARKER_RETENTION_MS) rmSync(path, { force: true });
    } catch {
      // Observer-only.
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 64) || "unknown";
}
