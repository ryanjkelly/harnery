import { lstatSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { processMayBeAlive } from "../../../lib/process-alive.ts";
import {
  type LeaseRecoveryStep,
  type NoClobberLeaseOwner,
  reclaimNoClobberLeaseOfExitedThread,
} from "../../storage/no-clobber-lease.ts";
import { currentThreadId } from "../../storage/thread-identity.ts";
import { eventV3ArchivesRoot } from "./archive-retention.ts";

// This module stays free of the ledger's reader and writer so an embedding
// host can load it on the thread that supervises its recorder workers.

const LEDGER_ROOT_SEGMENTS = [".harnery", "ledgers", "v3"] as const;
const PRODUCER_SCOPES = [
  "event-v3-hook-producer",
  "event-v3-command-producer",
  "event-v3-coordination-producer",
] as const;

/** Fixed lease directories under the coordination root's private state. */
export function eventV3PrivateLeasePathsV3(coordRoot: string) {
  const privateDir = join(resolve(coordRoot), ".harnery", "private");
  return {
    append: join(privateDir, "event-v3-append-lease"),
    publication: join(privateDir, "event-v3-publication-lease"),
    bootstrap: join(privateDir, "event-v3-bootstrap-lease"),
    fingerprintKey: join(privateDir, "fingerprint-key-lease"),
  };
}

export interface ExitedThreadLeaseReleaseV3 {
  /** Lease scopes reclaimed, in the order they were checked. */
  released: string[];
  /** Lease scopes whose reclaim failed; the lease is left as it was. */
  failed: string[];
}

/** Fault-injection hooks for tests, called with the lease scope being released. */
export interface ExitedThreadLeaseReleaseOptionsV3 {
  onRecoveryStep?: (scope: string, step: LeaseRecoveryStep) => void;
  onRelease?: (scope: string) => void;
}

/**
 * Release every event ledger lease that a thread of this process left held
 * when it exited. A terminated or crashed worker thread runs no `finally`
 * block, so it cannot release its leases, and because the process is still
 * alive no stale-owner check will ever reclaim them: every later write in the
 * process would fail until it restarts.
 *
 * The caller asserts that `threadId` has exited (for example from a Worker
 * `exit` event, using the id captured when the worker started). Only a lease
 * whose owner record names this host, this process and that thread is
 * reclaimed; leases held by other processes or by other live threads are
 * untouched.
 */
export function releaseEventV3LeasesHeldByExitedThreadV3(
  coordRoot: string,
  threadId: number,
  options: ExitedThreadLeaseReleaseOptionsV3 = {},
): ExitedThreadLeaseReleaseV3 {
  if (!Number.isSafeInteger(threadId) || threadId < 0) {
    throw new Error("exited thread id is invalid");
  }
  if (threadId === currentThreadId) {
    throw new Error("the current thread cannot release its own leases as exited");
  }
  const result: ExitedThreadLeaseReleaseV3 = { released: [], failed: [] };
  const scan = ledgerLeaseCandidates(coordRoot);
  // A folder that exists but cannot be listed may hide a lease the exited
  // thread held, so the release is not clean and the caller must retry.
  if (scan.unreadable) result.failed.push(LEASE_SCAN_SCOPE);
  for (const { path, scope } of scan.candidates) {
    try {
      if (
        reclaimNoClobberLeaseOfExitedThread({
          path,
          scope,
          threadId,
          validateStaleOwner: sameHostOwnerExited,
          onRecoveryStep:
            options.onRecoveryStep && ((step) => options.onRecoveryStep?.(scope, step)),
          onRelease: options.onRelease && (() => options.onRelease?.(scope)),
        })
      ) {
        result.released.push(scope);
      }
    } catch {
      result.failed.push(scope);
    }
  }
  return result;
}

function sameHostOwnerExited(owner: NoClobberLeaseOwner): boolean {
  return owner.host === hostname() && !processMayBeAlive(owner.pid);
}

/** Reported in `failed` when a lease folder exists but cannot be listed. */
export const LEASE_SCAN_SCOPE = "event-v3-lease-scan";

interface LeaseScanV3 {
  candidates: Array<{ path: string; scope: string }>;
  /** True when a folder that may hold leases exists but could not be read. */
  unreadable: boolean;
}

function ledgerLeaseCandidates(coordRoot: string): LeaseScanV3 {
  const scan = { unreadable: false };
  const entries = (dir: string) => listEntries(dir, scan);
  const directories = (dir: string) => listDirectories(dir, scan);
  const root = resolve(coordRoot);
  const fixed = eventV3PrivateLeasePathsV3(root);
  const candidates: Array<{ path: string; scope: string }> = [
    { path: fixed.append, scope: "event-v3-append" },
    { path: fixed.publication, scope: "event-v3-publication" },
    { path: fixed.bootstrap, scope: "event-v3-bootstrap" },
    { path: fixed.fingerprintKey, scope: "event-v3-fingerprint-key" },
  ];
  const ledger = join(root, ...LEDGER_ROOT_SEGMENTS);
  for (const adapterDir of directories(join(ledger, "private-producers"))) {
    for (const name of entries(adapterDir)) {
      if (!name.endsWith(".lease")) continue;
      for (const scope of PRODUCER_SCOPES) candidates.push({ path: join(adapterDir, name), scope });
    }
  }
  for (const leaseDir of directories(join(ledger, "diagnostic-summaries", "leases"))) {
    candidates.push({ path: leaseDir, scope: "event-v3-diagnostic-summary" });
  }
  for (const epochDir of directories(eventV3ArchivesRoot(root))) {
    const leaseDir = join(epochDir, "ready-history-import-lease");
    if (presentInScan(leaseDir, scan)) {
      candidates.push({ path: leaseDir, scope: "event-v3-ready-history-import" });
    }
  }
  return { candidates, unreadable: scan.unreadable };
}

/** A missing path is absent; any other error marks the scan unreadable and is not trusted. */
function presentInScan(path: string, scan: { unreadable: boolean }): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (!isMissing(error)) scan.unreadable = true;
    return false;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A missing folder holds no leases; any other read error marks the scan unreadable. */
function listEntries(dir: string, scan: { unreadable: boolean }): string[] {
  try {
    return readdirSync(dir).sort();
  } catch (error) {
    if (!isMissing(error)) scan.unreadable = true;
    return [];
  }
}

function listDirectories(dir: string, scan: { unreadable: boolean }): string[] {
  return listEntries(dir, scan)
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        return lstatSync(path).isDirectory();
      } catch (error) {
        if (!isMissing(error)) scan.unreadable = true;
        return false;
      }
    });
}
