import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RunQualitySnapshot } from "./types.ts";

export interface CanonicalGuardEvent {
  schema_version: number;
  event_id: string;
  event_type: string;
  ts: string;
  instance_id: string;
  session_id: string;
  adapter: string;
  data: Record<string, unknown>;
  segment: string;
}

export interface GuardCursor {
  schema_version: 1;
  segment: string;
  last_event_id?: string;
  next_eligible_at: string;
  config_digest: string;
  updated_at: string;
}

export interface EvaluationLock {
  pid: number;
  acquired_at: string;
  nonce: string;
}

export function guardDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "guard");
}

export function snapshotPath(coordRoot: string, instanceId: string): string {
  return join(guardDir(coordRoot), `${instanceId}.json`);
}

export function readRunQualitySnapshot(
  coordRoot: string,
  instanceId: string,
): RunQualitySnapshot | null {
  return readBoundedJson<RunQualitySnapshot>(snapshotPath(coordRoot, instanceId), 1024 * 1024);
}

export function readFreshRunQualitySnapshot(
  coordRoot: string,
  instanceId: string,
  now: Date = new Date(),
): RunQualitySnapshot | null {
  const snapshot = readRunQualitySnapshot(coordRoot, instanceId);
  return snapshot && Date.parse(snapshot.expires_at) > now.getTime() ? snapshot : null;
}

export function readGuardCursor(coordRoot: string): GuardCursor | null {
  return readBoundedJson<GuardCursor>(join(guardDir(coordRoot), "cursor.json"), 64 * 1024);
}

export function writeGuardCursor(coordRoot: string, cursor: GuardCursor, nonce: string): void {
  writeAtomicJson(join(guardDir(coordRoot), "cursor.json"), cursor, nonce, () =>
    evaluationLockOwned(coordRoot, nonce),
  );
}

export function writeRunQualitySnapshot(
  coordRoot: string,
  snapshot: RunQualitySnapshot,
  nonce: string,
): void {
  writeAtomicJson(snapshotPath(coordRoot, snapshot.instance_id), snapshot, nonce, () =>
    evaluationLockOwned(coordRoot, nonce),
  );
}

export function acquireEvaluationLock(
  coordRoot: string,
  now: Date,
  staleSeconds: number,
): EvaluationLock | null {
  const path = join(guardDir(coordRoot), "evaluate.lock");
  mkdirSync(dirname(path), { recursive: true });
  const lock: EvaluationLock = {
    pid: process.pid,
    acquired_at: now.toISOString(),
    nonce: randomUUID(),
  };
  if (createExclusive(path, lock)) return lock;
  const existing = readBoundedJson<EvaluationLock>(path, 16 * 1024);
  const age = existing
    ? now.getTime() - Date.parse(existing.acquired_at)
    : Number.POSITIVE_INFINITY;
  if (existing && processAlive(existing.pid) && age <= staleSeconds * 1000) return null;
  try {
    unlinkSync(path);
  } catch {
    return null;
  }
  return createExclusive(path, lock) ? lock : null;
}

export function evaluationLockOwned(coordRoot: string, nonce: string): boolean {
  return (
    readBoundedJson<EvaluationLock>(join(guardDir(coordRoot), "evaluate.lock"), 16 * 1024)
      ?.nonce === nonce
  );
}

export function releaseEvaluationLock(coordRoot: string, nonce: string): void {
  const path = join(guardDir(coordRoot), "evaluate.lock");
  if (!evaluationLockOwned(coordRoot, nonce)) return;
  try {
    unlinkSync(path);
  } catch {
    // A replacement owner won the race; nonce ownership already prevents removal.
  }
}

export function readGuardEventWindow(
  coordRoot: string,
  maxBytes: number,
): { events: CanonicalGuardEvent[]; truncated: boolean; segment: string } {
  const dir = join(coordRoot, ".harnery");
  const live = join(dir, "events.ndjson");
  const archives = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => /^events-.+\.ndjson$/.test(name))
        .map((name) => join(dir, name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || b.localeCompare(a))
    : [];
  const paths = [...archives.slice(0, 1).reverse(), ...(existsSync(live) ? [live] : [])];
  const events: CanonicalGuardEvent[] = [];
  let truncated = false;
  let segment = ".harnery/events.ndjson";
  for (const path of paths) {
    const read = readTail(path, maxBytes);
    truncated ||= read.truncated;
    const relativeSegment = `.harnery/${basename(path)}`;
    segment = relativeSegment;
    for (const line of read.text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Omit<CanonicalGuardEvent, "segment">;
        if (
          typeof event.event_id === "string" &&
          typeof event.event_type === "string" &&
          typeof event.instance_id === "string" &&
          event.data &&
          typeof event.data === "object"
        ) {
          events.push({ ...event, segment: relativeSegment });
        }
      } catch {
        // An incomplete or malformed ledger line is not evidence.
      }
    }
  }
  return { events, truncated, segment };
}

export function cleanupOrphanSnapshots(coordRoot: string, liveIds: Set<string>): void {
  const dir = guardDir(coordRoot);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name === "cursor.json" || name === "config-invalid.json")
      continue;
    const instanceId = name.slice(0, -5);
    if (liveIds.has(instanceId)) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Cleanup is advisory and retries on the next evaluation.
    }
  }
}

export function writeAtomicJson(
  path: string,
  value: unknown,
  nonce: string,
  beforeRename?: () => boolean,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${nonce}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (beforeRename && !beforeRename()) throw new Error("run_quality_lock_stolen");
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function createExclusive(path: string, value: EvaluationLock): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readTail(path: string, maxBytes: number): { text: string; truncated: boolean } {
  const size = statSync(path).size;
  const length = Math.min(size, maxBytes);
  const start = size - length;
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  let offset = 0;
  try {
    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, start + offset);
      if (count === 0) break;
      offset += count;
    }
  } finally {
    closeSync(fd);
  }
  let text = buffer.toString("utf8", 0, offset);
  const truncated = start > 0;
  if (truncated) {
    const newline = text.indexOf("\n");
    text = newline >= 0 ? text.slice(newline + 1) : "";
  }
  return { text, truncated };
}

function readBoundedJson<T>(path: string, maxBytes: number): T | null {
  if (!existsSync(path)) return null;
  try {
    const size = statSync(path).size;
    if (size <= 0 || size > maxBytes) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
