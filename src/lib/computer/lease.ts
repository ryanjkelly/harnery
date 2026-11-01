/**
 * Desktop lease for `harn computer` (ADR 0228).
 *
 * One JSON file per desktop records which agent may drive it. Callers are
 * short-lived CLI invocations from WSL distros and native Windows shells that
 * share the file through `/mnt/<drive>` (drvfs) or the native path, so this
 * module relies on nothing that breaks across that boundary:
 *
 * - No flock and no pid liveness. Owner identity is `LeaseOwner.id`; a lease
 *   ends when its owner releases it or when it sits idle past `expires_at`.
 * - The read-modify-write critical section is an atomic `mkdir` of
 *   `<dir>/lease.lock`. The holder writes `owner.json` ({pid, at, token}) into
 *   it and keeps it for milliseconds. A lock older than 10 seconds belongs to
 *   a crashed holder and is broken.
 * - Lease writes go to a temporary file in the same directory and are renamed
 *   over the target, so a reader never sees a partial record.
 *
 * Generation rule: every acquisition of a free or expired lease increments
 * `generation`, including an owner re-taking its own lease after it expired.
 * A refresh of an unexpired lease by the same owner keeps the generation.
 *
 * Internal module: not exported from package.json.
 */
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  DesktopLease,
  LeaseAcquireResult,
  LeaseApi,
  LeaseOptions,
  LeaseOwner,
} from "./types.ts";

/** Idle expiry when `LeaseOptions.idleMs` is omitted. */
export const DEFAULT_LEASE_IDLE_MS = 120_000;
const DEFAULT_POLL_MS = 500;
const LEASE_FILE = "desktop-lease.json";
const LOCK_DIR = "lease.lock";
const LOCK_OWNER_FILE = "owner.json";
/** A critical-section lock older than this belongs to a crashed holder. */
const LOCK_STALE_MS = 10_000;
/** Give up on the critical section after this long (stale break happens first). */
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_RETRY_MS = 10;

/** Directory holding the lease file for a desktop state dir. */
export function leaseDir(desktopStateDir: string): string {
  return join(desktopStateDir, "computer");
}

function leaseFile(dir: string): string {
  return join(dir, LEASE_FILE);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Parse a lease record; anything malformed counts as no lease. */
function parseLease(text: string): DesktopLease | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const lease = value as Partial<DesktopLease>;
  if (
    lease.schema !== 1 ||
    typeof lease.owner_id !== "string" ||
    typeof lease.owner_label !== "string" ||
    typeof lease.generation !== "number" ||
    !Number.isFinite(lease.generation) ||
    typeof lease.acquired_at !== "string" ||
    typeof lease.refreshed_at !== "string" ||
    typeof lease.expires_at !== "string" ||
    Number.isNaN(Date.parse(lease.expires_at))
  ) {
    return null;
  }
  return lease as DesktopLease;
}

/** The lease record on disk, expired or not; null when missing or corrupt. */
function readRaw(dir: string): DesktopLease | null {
  try {
    return parseLease(readFileSync(leaseFile(dir), "utf8"));
  } catch {
    return null;
  }
}

function isExpired(lease: DesktopLease, nowMs: number): boolean {
  return nowMs >= Date.parse(lease.expires_at);
}

function writeLease(dir: string, lease: DesktopLease): void {
  const tmp = join(dir, `${LEASE_FILE}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(lease, null, 2)}\n`);
  try {
    renameSync(tmp, leaseFile(dir));
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort
    }
    throw error;
  }
}

/** Age of a lock dir: owner.json `at`, else the directory mtime. */
function lockAgeMs(lockDir: string): number | undefined {
  try {
    const owner = JSON.parse(readFileSync(join(lockDir, LOCK_OWNER_FILE), "utf8")) as {
      at?: unknown;
    };
    const at = typeof owner.at === "string" ? Date.parse(owner.at) : Number.NaN;
    if (!Number.isNaN(at)) return Date.now() - at;
  } catch {
    // owner.json not written yet or unreadable: fall back to the dir itself
  }
  try {
    return Date.now() - statSync(lockDir).mtimeMs;
  } catch {
    return undefined; // lock vanished
  }
}

/** Break a stale lock. Rename first so two breakers cannot both win. */
function breakLock(lockDir: string): void {
  const grave = `${lockDir}.stale.${process.pid}.${randomUUID()}`;
  try {
    renameSync(lockDir, grave);
  } catch {
    return; // someone else broke or released it
  }
  rmSync(grave, { recursive: true, force: true });
}

/**
 * Run `fn` while holding the critical-section lock in `dir` (which must
 * exist). Synchronous: the section is a few file operations, and release()
 * is synchronous in the contract.
 */
function withLock<T>(dir: string, fn: () => T): T {
  const lockDir = join(dir, LOCK_DIR);
  const token = randomUUID();
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if (errCode(error) !== "EEXIST") throw error;
    }
    const age = lockAgeMs(lockDir);
    if (age !== undefined && age > LOCK_STALE_MS) {
      breakLock(lockDir);
      continue;
    }
    if (Date.now() - started > LOCK_TIMEOUT_MS) {
      throw new Error(`desktop lease: timed out waiting for ${lockDir}`);
    }
    sleepSync(LOCK_RETRY_MS);
  }
  try {
    writeFileSync(
      join(lockDir, LOCK_OWNER_FILE),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }),
    );
  } catch {
    // The mkdir already gave us the lock; owner.json only aids stale detection.
  }
  try {
    return fn();
  } finally {
    releaseLock(lockDir, token);
  }
}

/** Remove the lock only if it is still ours (a slow holder may have been broken). */
function releaseLock(lockDir: string, token: string): void {
  try {
    const owner = JSON.parse(readFileSync(join(lockDir, LOCK_OWNER_FILE), "utf8")) as {
      token?: unknown;
    };
    if (owner.token !== token) return;
  } catch (error) {
    if (errCode(error) !== "ENOENT") return; // unreadable owner.json: leave it for stale breaking
    // owner.json missing: our write failed or the lock is gone; fall through
  }
  rmSync(lockDir, { recursive: true, force: true });
}

type TryResult =
  | { ok: true; lease: DesktopLease; fresh: boolean }
  | { ok: false; holder: DesktopLease };

function tryAcquire(owner: LeaseOwner, dir: string, nowMs: number, idleMs: number): TryResult {
  return withLock(dir, () => {
    const current = readRaw(dir);
    const nowIso = new Date(nowMs).toISOString();
    const expiresIso = new Date(nowMs + idleMs).toISOString();
    if (current && !isExpired(current, nowMs)) {
      if (current.owner_id !== owner.id) return { ok: false, holder: current };
      const refreshed: DesktopLease = { ...current, refreshed_at: nowIso, expires_at: expiresIso };
      writeLease(dir, refreshed);
      return { ok: true, lease: refreshed, fresh: false };
    }
    const lease: DesktopLease = {
      schema: 1,
      owner_id: owner.id,
      owner_label: owner.label,
      ...(owner.project !== undefined ? { project: owner.project } : {}),
      generation: (current?.generation ?? 0) + 1,
      acquired_at: nowIso,
      refreshed_at: nowIso,
      expires_at: expiresIso,
    };
    writeLease(dir, lease);
    return { ok: true, lease, fresh: true };
  });
}

export interface DesktopLeaseDeps {
  /** Async sleep used while waiting for another owner's lease. */
  sleep?: (ms: number) => Promise<void>;
}

/** Build a lease API; tests inject `sleep` (and `LeaseOptions.now`). */
export function createDesktopLease(deps: DesktopLeaseDeps = {}): LeaseApi {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    async acquire(owner: LeaseOwner, opts: LeaseOptions): Promise<LeaseAcquireResult> {
      const now = opts.now ?? Date.now;
      const idleMs = opts.idleMs ?? DEFAULT_LEASE_IDLE_MS;
      const waitMs = Math.max(0, opts.waitMs ?? 0);
      const pollMs = Math.max(1, opts.pollMs ?? DEFAULT_POLL_MS);
      mkdirSync(opts.dir, { recursive: true });
      const started = now();
      // Track slept time too, so a frozen injected clock cannot wait forever.
      let slept = 0;
      for (;;) {
        const result = tryAcquire(owner, opts.dir, now(), idleMs);
        const waited = Math.max(now() - started, slept);
        if (result.ok) return result;
        const remaining = waitMs - waited;
        if (remaining <= 0) return { ok: false, holder: result.holder, waitedMs: waited };
        const step = Math.min(pollMs, remaining);
        await sleep(step);
        slept += step;
      }
    },

    release(owner: LeaseOwner, opts: LeaseOptions): boolean {
      try {
        if (!statSync(opts.dir).isDirectory()) return false;
      } catch {
        return false;
      }
      return withLock(opts.dir, () => {
        const current = readRaw(opts.dir);
        if (!current || current.owner_id !== owner.id) return false;
        const nowMs = (opts.now ?? Date.now)();
        if (isExpired(current, nowMs)) return false;
        // Expire the record instead of deleting it, so the next owner's
        // generation still counts up from this one.
        const nowIso = new Date(nowMs).toISOString();
        writeLease(opts.dir, { ...current, refreshed_at: nowIso, expires_at: nowIso });
        return true;
      });
    },

    read(opts: LeaseOptions): DesktopLease | null {
      const now = opts.now ?? Date.now;
      const lease = readRaw(opts.dir);
      return lease && !isExpired(lease, now()) ? lease : null;
    },
  };
}

export const desktopLease: LeaseApi = createDesktopLease();
