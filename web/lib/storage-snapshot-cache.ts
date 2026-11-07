import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { type FileHandle, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { processMayBeAlive } from "../../src/lib/process-alive";

const MAX_BYTES = 4 * 1024 * 1024;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function snapshotDirectory(root: string): string {
  return join(root, ".harnery", "cache", "storage-footprint");
}

export function storageSnapshotPath(root: string): string {
  return join(snapshotDirectory(root), "snapshot.json");
}

export function storageRefreshLeasePath(root: string): string {
  return join(snapshotDirectory(root), "refresh.lease");
}

/**
 * One bounded, disposable display snapshot. It never authorizes maintenance.
 *
 * Age is not a validity test here: the reader serves whatever valid snapshot
 * exists and refreshes in the background, because on a large `.harnery` the
 * fresh inventory can take minutes and a day-old footprint beats a blocked
 * page. The page shows the capture time. A snapshot from the future is still
 * rejected as corrupt.
 *
 * `allowOtherKey` also accepts a snapshot of this same root taken under other
 * storage settings (a changed catalog or policy). The caller may show it as
 * stale while it measures again; it is never served as current. A snapshot
 * that belongs to another checkout is still rejected because its root differs.
 */
export async function readStorageSnapshot(
  root: string,
  key: string,
  now: number,
  options: { allowOtherKey?: boolean } = {},
): Promise<{ savedAt: number; inventory: unknown; exactKey: boolean } | null> {
  let file: FileHandle | undefined;
  try {
    file = await open(
      storageSnapshotPath(root),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    const envelope = JSON.parse(bytes.toString("utf8"));
    const exactKey = envelope.key === key;
    if (
      envelope.version !== 1 ||
      typeof envelope.key !== "string" ||
      (!exactKey && !(options.allowOtherKey && envelope.root === root)) ||
      !Number.isFinite(envelope.savedAt) ||
      envelope.savedAt > now ||
      typeof envelope.body !== "string" ||
      digest(envelope.body) !== envelope.sha256
    )
      return null;
    return { savedAt: envelope.savedAt, inventory: JSON.parse(envelope.body), exactKey };
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}

export async function writeStorageSnapshot(
  root: string,
  key: string,
  savedAt: number,
  inventory: unknown,
): Promise<void> {
  let temporary: string | undefined;
  try {
    const body = JSON.stringify(inventory);
    const bytes = JSON.stringify({ version: 1, key, root, savedAt, body, sha256: digest(body) });
    if (Buffer.byteLength(bytes) > MAX_BYTES) return;
    let directory = root;
    for (const part of [".harnery", "cache", "storage-footprint"]) {
      directory = join(directory, part);
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      if (!(await lstat(directory)).isDirectory()) return;
    }
    const target = storageSnapshotPath(root);
    temporary = join(directory, `.snapshot-${process.pid}-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    await rename(temporary, target);
  } catch {
    // A read-only/full cache directory must never make the fresh report fail.
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
  }
}

export interface StorageRefreshLease {
  pid: number;
  startedAt: number;
  token: string;
}

export type StorageRefreshLeaseAttempt =
  | { acquired: true; release: () => void }
  | { acquired: false; holder: StorageRefreshLease };

/**
 * One storage walk per project at a time, across dashboard processes.
 *
 * A warm handover runs two dashboard processes side by side, and each has its
 * own in-memory record of the walk it started. Without a shared lease both
 * would walk the same tree for a minute. The lease names the dashboard process
 * that holds it; a holder that has exited, or a lease older than `staleMs`,
 * is reclaimed. A lease this process wrote is only honoured while
 * `ownWalkRunning` says one of its walks is still going.
 *
 * Lease files are tiny, so the calls are synchronous: the caller can check its
 * own in-flight table and take the lease with no await in between. When the
 * cache directory cannot be written, the walk proceeds without a lease.
 */
export function acquireStorageRefreshLease(
  root: string,
  now: number,
  staleMs: number,
  ownWalkRunning: boolean,
): StorageRefreshLeaseAttempt {
  const path = storageRefreshLeasePath(root);
  const lease: StorageRefreshLease = { pid: process.pid, startedAt: now, token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(snapshotDirectory(root), { recursive: true, mode: 0o700 });
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(lease));
      } finally {
        closeSync(fd);
      }
      return { acquired: true, release: () => releaseLease(path, lease.token) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return { acquired: true, release: () => {} };
      }
    }
    const holder = readStorageRefreshLease(root, now, staleMs, ownWalkRunning);
    if (holder) return { acquired: false, holder };
    try {
      unlinkSync(path);
    } catch {
      // Another process may have reclaimed it first; the next open decides.
    }
  }
  return { acquired: true, release: () => {} };
}

/** The live holder of the walk lease, or null when nobody holds a valid one. */
export function readStorageRefreshLease(
  root: string,
  now: number,
  staleMs: number,
  ownWalkRunning: boolean,
): StorageRefreshLease | null {
  try {
    const lease = JSON.parse(readFileSync(storageRefreshLeasePath(root), "utf8"));
    if (
      !Number.isInteger(lease.pid) ||
      !Number.isFinite(lease.startedAt) ||
      typeof lease.token !== "string" ||
      now - lease.startedAt >= staleMs
    )
      return null;
    if (lease.pid === process.pid) return ownWalkRunning ? lease : null;
    return processMayBeAlive(lease.pid) ? lease : null;
  } catch {
    return null;
  }
}

function releaseLease(path: string, token: string): void {
  try {
    if (JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path);
  } catch {
    // Missing or replaced: nothing of ours to release.
  }
}
