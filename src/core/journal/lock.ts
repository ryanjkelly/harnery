/**
 * One lock for every journal mutation in a project: append, entry edit and
 * delete, wholesale replace, archive, archive pruning, and migration. Without
 * it, an append that reads, rewrites, and renames the whole file can silently
 * drop an entry a concurrent writer added in between.
 *
 * The lock is a directory (`<journal dir>/.lock`), created atomically with
 * mkdir, holding a small owner record. It is reentrant within one process, so
 * a locked operation may call another (an entry edit archives first). A lock
 * whose owner process is gone on this host, or one older than the stale limit
 * with no verifiable owner, is broken by renaming it aside so two breakers
 * cannot both win.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { isHeldLockFailure, type LockDirSeam, realLockDirSeam } from "../../lib/held-lock.ts";

export const JOURNAL_LOCK_DIR = ".lock";
const OWNER_FILE = "owner.json";
/** Journal mutations take milliseconds; an older lock with no verifiable owner is abandoned. */
const STALE_MS = 10_000;
/** Give up waiting after this long; the caller reports the busy lock. */
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_MS = 10;

interface LockOwner {
  pid: number;
  host: string;
  at: string;
  token: string;
}

export class JournalLockBusyError extends Error {
  readonly code = "JOURNAL_LOCK_BUSY";
  constructor(lockDir: string, waitedMs: number) {
    super(
      `journal lock busy: ${lockDir} is still held after ${waitedMs} ms; ` +
        "another journal write is in progress (retry shortly)",
    );
    this.name = "JournalLockBusyError";
  }
}

const held = new Map<string, number>();

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readOwner(lockDir: string): LockOwner | null {
  try {
    const raw = JSON.parse(readFileSync(join(lockDir, OWNER_FILE), "utf8")) as Partial<LockOwner>;
    if (
      typeof raw.pid === "number" &&
      typeof raw.host === "string" &&
      typeof raw.at === "string" &&
      typeof raw.token === "string"
    ) {
      return raw as LockOwner;
    }
  } catch {
    // Not written yet, or unreadable.
  }
  return null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when the lock at `lockDir` can be broken safely. */
function abandoned(lockDir: string): boolean {
  const owner = readOwner(lockDir);
  if (owner && owner.host === hostname()) {
    // A live process on this host may be mid-write; never evict it.
    return !processAlive(owner.pid);
  }
  let ageMs: number;
  if (owner) {
    ageMs = Date.now() - Date.parse(owner.at);
  } else {
    try {
      ageMs = Date.now() - statSync(lockDir).mtimeMs;
    } catch {
      return false; // released between our mkdir and this check
    }
  }
  return Number.isFinite(ageMs) && ageMs > STALE_MS;
}

function breakLock(lockDir: string): void {
  const grave = `${lockDir}.stale.${process.pid}.${randomUUID()}`;
  try {
    renameSync(lockDir, grave);
  } catch {
    return; // someone else broke or released it
  }
  rmSync(grave, { recursive: true, force: true });
}

function release(lockDir: string, token: string): void {
  const owner = readOwner(lockDir);
  if (owner && owner.token !== token) return; // broken and re-taken by someone else
  rmSync(lockDir, { recursive: true, force: true });
}

/** True while this process holds the journal lock for `journalDir`. */
export function holdsJournalLock(journalDir: string): boolean {
  return (held.get(join(journalDir, JOURNAL_LOCK_DIR)) ?? 0) > 0;
}

/**
 * Run `fn` while holding the journal lock for `journalDir`. Synchronous,
 * because every journal mutation is a handful of file operations.
 */
export function withJournalLock<T>(
  journalDir: string,
  fn: () => T,
  opts: {
    timeoutMs?: number;
    /** The lock's mkdir and platform; tests substitute them. */
    lockSeam?: LockDirSeam;
  } = {},
): T {
  const lockDir = join(journalDir, JOURNAL_LOCK_DIR);
  const depth = held.get(lockDir) ?? 0;
  if (depth > 0) {
    held.set(lockDir, depth + 1);
    try {
      return fn();
    } finally {
      held.set(lockDir, depth);
    }
  }

  mkdirSync(journalDir, { recursive: true });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const seam = opts.lockSeam ?? realLockDirSeam;
  const started = Date.now();
  for (;;) {
    try {
      seam.mkdir(lockDir);
      break;
    } catch (error) {
      if (!isHeldLockFailure(error, seam)) throw error;
    }
    if (abandoned(lockDir)) {
      breakLock(lockDir);
      continue;
    }
    const waited = Date.now() - started;
    if (waited > timeoutMs) throw new JournalLockBusyError(lockDir, waited);
    sleepSync(RETRY_MS);
  }

  const token = randomUUID();
  try {
    writeFileSync(
      join(lockDir, OWNER_FILE),
      JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), token }),
    );
  } catch {
    // The mkdir already granted the lock; the owner record only aids recovery.
  }
  held.set(lockDir, 1);
  try {
    return fn();
  } finally {
    held.delete(lockDir);
    release(lockDir, token);
  }
}
