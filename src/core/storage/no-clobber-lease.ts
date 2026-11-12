import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { threadId as currentThreadId } from "node:worker_threads";
import { fsyncDirectory } from "./durable-record.ts";
import { stateDirMode, stateFileMode } from "./modes.ts";

const MAX_LEASE_BYTES = 8 * 1024;
const MAX_CONTENTION_OBSERVATION_ATTEMPTS = 8;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface NoClobberLeaseOwner {
  schema_version: 1;
  owner_id: string;
  owner_file: string;
  scope: string;
  authority_sha256: string;
  metadata?: Record<string, string>;
  pid: number;
  /** `worker_threads.threadId` of the holder; 0 on the main thread. Older records omit it. */
  thread_id?: number;
  host: string;
  created_at: string;
  expires_at: string;
}

export type LeaseRecoveryStep =
  | "claim_created"
  | "stale_pinned"
  | "current_removed"
  | "new_current_linked"
  | "recovery_retired";

export interface AcquireNoClobberLeaseInput {
  path: string;
  scope: string;
  authoritySha256: string;
  metadata?: Readonly<Record<string, string>>;
  staleAfterMs: number;
  validateStaleOwner?: (owner: NoClobberLeaseOwner) => boolean;
  /**
   * Reclaim an expired lease that this same thread of this process left held
   * and no longer holds: its handle was dropped without release, or release
   * failed. Such an owner skips `validateStaleOwner`, so opt in only where
   * that callback judges liveness, not authority.
   */
  recoverAbandonedOwnThread?: boolean;
  now?: () => number;
  pid?: number;
  host?: string;
  /** Probe dependency for deterministic liveness-failure tests. */
  probePid?: (pid: number) => void;
  /** Fault-injection hook immediately before the lease directory is created. */
  onLeaseDirectoryCreate?: () => void;
  /** Fault-injection hook after contention is observed and before owner inspection. */
  onContention?: () => void;
  onRecoveryStep?: (step: LeaseRecoveryStep) => void;
  /** Fault-injection hook at the start of `release`, before `current` is removed. */
  onRelease?: () => void;
}

export interface NoClobberLease {
  owner: NoClobberLeaseOwner;
  recovered_owner?: NoClobberLeaseOwner;
  release(): void;
}

/**
 * Lease directories this thread currently holds, keyed by directory identity
 * (see `canonicalLeaseDirectory`), so a symlinked or bind-mounted alias of a
 * held lease is seen as held. Module state is per thread in Node and Bun,
 * which is exactly the scope the own-thread rule needs. Each entry weakly
 * references a token that the handle's `release` closes over, so an entry
 * stays live while any holder can still use or release the lease.
 */
const heldByThisThread = new Map<string, { ownerId: string; token: WeakRef<object> }>();
/** Owner ids of acquisitions this thread is running (reentrant hooks only). */
const acquisitionsInProgress = new Set<string>();

interface OwnerProofContext {
  /** Identity of the lease directory; the key of `heldByThisThread`. */
  leaseKey: string;
  /** Set only by the exited-thread release: the caller asserts this thread has exited. */
  exitedThreadId?: number;
  /**
   * An exact owner record whose holder thread an abandoned recovery claim
   * recorded as exited (see `RecoveryClaim.observed_holder_exited`).
   */
  exitedOwner?: { ownerId: string; sha256: string };
}

interface RecoveryClaim {
  schema_version: 1;
  claimant: NoClobberLeaseOwner;
  observed_owner: NoClobberLeaseOwner;
  observed_sha256: string;
  created_at: string;
  /**
   * Set when the claimant knew the observed owner's thread had exited: it ran
   * the exited-thread release, or it finished one that stopped part-way. The
   * observed owner is another thread of the claimant's host and process.
   * Thread ids are not reused within a process, so the record stays true and
   * lets a later contender finish a release that stopped part-way.
   */
  observed_holder_exited?: true;
}

/**
 * Acquires a crash-safe lease whose active name is always a hard link to one
 * immutable owner file. Stale takeover is serialized by an atomic recovery
 * directory; only its claimant may pin and replace the observed `current`.
 */
export function acquireNoClobberLease(input: AcquireNoClobberLeaseInput): NoClobberLease {
  validateInput(input);
  ensureLeaseDirectory(resolve(input.path), input.onLeaseDirectoryCreate);
  // Every later step uses the canonical directory, so the identity the
  // registry checks is the directory these file operations act on.
  const { leaseDir, leaseKey } = canonicalLeaseDirectory(input.path);
  const proof: OwnerProofContext = { leaseKey };

  const now = input.now ?? Date.now;
  const created = now();
  const ownerId = randomUUID();
  const ownerFile = `owner-${ownerId}.json`;
  const owner: NoClobberLeaseOwner = {
    schema_version: 1,
    owner_id: ownerId,
    owner_file: ownerFile,
    scope: input.scope,
    authority_sha256: input.authoritySha256,
    metadata: input.metadata ? { ...input.metadata } : undefined,
    pid: input.pid ?? process.pid,
    thread_id: currentThreadId,
    host: input.host ?? hostname(),
    created_at: new Date(created).toISOString(),
    expires_at: new Date(created + input.staleAfterMs).toISOString(),
  };
  const ownerPath = join(leaseDir, ownerFile);
  const ownerBytes = `${JSON.stringify(owner)}\n`;
  writeExclusive(ownerPath, ownerBytes);
  fsyncDirectory(leaseDir);

  const currentPath = join(leaseDir, "current");
  const recoveryPath = join(leaseDir, "recovery");
  let recoveryClaimed = false;
  acquisitionsInProgress.add(ownerId);
  try {
    if (presentForRelease(recoveryPath)) {
      proof.exitedOwner = reclaimAbandonedRecovery(leaseDir, recoveryPath, input, now(), proof);
    }

    let observed: ReturnType<typeof readOwner> | undefined;
    for (let attempt = 0; attempt < MAX_CONTENTION_OBSERVATION_ATTEMPTS; attempt += 1) {
      try {
        linkSync(ownerPath, currentPath);
        fsyncDirectory(leaseDir);
        assertExactOwner(currentPath, ownerPath, ownerBytes, owner);
        if (presentForRelease(recoveryPath)) {
          unlinkExactCurrent(currentPath, ownerPath);
          throw new Error(`lease ${input.scope} recovery is already in progress`);
        }
        return leaseHandle(leaseDir, leaseKey, ownerPath, ownerBytes, owner, input.onRelease);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      input.onContention?.();
      try {
        observed = readOwner(currentPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (observed === undefined) {
      throw new Error(`lease ${input.scope} changed repeatedly during contention`);
    }
    const holderExited = observedHolderExited(observed, proof);
    const holderGone =
      holderExited || ownerHolderIsGone(observed.owner, now(), input, proof, "lease");
    if (!holderGone && leaseIsLive(observed.owner, now(), input.staleAfterMs, input.probePid)) {
      throw new Error(
        `lease ${input.scope} is held by a live or unexpired owner, or its liveness is unknown`,
      );
    }
    if (
      observed.owner.scope !== input.scope ||
      (!holderGone &&
        input.validateStaleOwner !== undefined &&
        !input.validateStaleOwner(observed.owner))
    ) {
      throw new Error(`stale lease ${input.scope} has mismatched authority`);
    }

    createRecoveryClaim(leaseDir, recoveryPath, owner, observed, holderExited);
    recoveryClaimed = true;
    input.onRecoveryStep?.("claim_created");

    const pinPath = join(recoveryPath, "stale-pin");
    try {
      linkSync(currentPath, pinPath);
      assertSameInodeAndBytes(currentPath, pinPath, observed.bytes);
    } catch {
      abortUnchangedRecoveryClaim(leaseDir, recoveryPath, owner);
      recoveryClaimed = false;
      throw new Error(`lease ${input.scope} recovery raced with another contender`);
    }
    fsyncDirectory(recoveryPath);
    input.onRecoveryStep?.("stale_pinned");

    assertSameInodeAndBytes(currentPath, pinPath, observed.bytes);
    unlinkSync(currentPath);
    fsyncDirectory(leaseDir);
    input.onRecoveryStep?.("current_removed");

    linkSync(ownerPath, currentPath);
    assertExactOwner(currentPath, ownerPath, ownerBytes, owner);
    fsyncDirectory(leaseDir);
    input.onRecoveryStep?.("new_current_linked");

    removePinnedOwner(leaseDir, pinPath, observed.owner);
    retireRecoveryClaim(leaseDir, recoveryPath, owner, () =>
      input.onRecoveryStep?.("recovery_retired"),
    );
    return leaseHandle(
      leaseDir,
      leaseKey,
      ownerPath,
      ownerBytes,
      owner,
      input.onRelease,
      observed.owner,
    );
  } catch (error) {
    // Once the recovery directory exists, leave every boundary intact. A
    // later owner can quarantine that exact abandoned claim and reconcile it.
    if (!recoveryClaimed) safeUnlink(ownerPath);
    throw error;
  } finally {
    acquisitionsInProgress.delete(ownerId);
  }
}

/**
 * Release a lease, or the abandoned recovery claim of one, left by a thread
 * of this process that has exited. `worker_threads` termination skips
 * `finally` blocks, so such a thread cannot release what it held, and its
 * process stays alive. The caller asserts that `threadId` has exited; thread
 * ids are not reused within a process. Only an owner or claimant naming this
 * host, this process and that thread is reclaimed, through the same recovery
 * claim a stale takeover uses.
 *
 * The release retires the exited owner without publishing a replacement, so
 * it never leaves a lease owned by the calling thread. If it stops part-way,
 * what remains is a recovery claim made by the calling thread. Other threads
 * and processes must respect that claim while this process lives, so the
 * caller repeats the release until it succeeds: a repeat clears every record
 * of the exited thread, and every claim this thread made whose acquisition
 * has ended. A lease this thread still holds is left alone. Returns true when
 * anything was reclaimed or removed.
 */
/**
 * Whether a path exists, for lease recovery and the exited-thread release. Only a missing path
 * (ENOENT, ENOTDIR) counts as absent; any other error is thrown, so a lease an
 * I/O error hides is reported as failed and retried, never as released.
 */
function presentForRelease(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/** Errors with an errno code are I/O failures and propagate; parse failures stay skippable. */
function rethrowIoError(error: unknown): void {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code !== "ENOENT") throw error;
}

export function reclaimNoClobberLeaseOfExitedThread(input: {
  path: string;
  scope: string;
  threadId: number;
  /** Judges any other owner a reconciliation encounters, as the lease's callers do. */
  validateStaleOwner?: (owner: NoClobberLeaseOwner) => boolean;
  onRecoveryStep?: (step: LeaseRecoveryStep) => void;
  /** Fault-injection hook at the start of releasing a lease this thread reclaims as its own. */
  onRelease?: () => void;
}): boolean {
  if (!Number.isSafeInteger(input.threadId) || input.threadId < 0) {
    throw new Error("exited thread id is invalid");
  }
  if (input.threadId === currentThreadId) {
    throw new Error("the current thread cannot release its own leases as exited");
  }
  if (!presentForRelease(resolve(input.path))) return false;
  const { leaseDir, leaseKey } = canonicalLeaseDirectory(input.path);
  // Every record this release writes carries the duration of the record it
  // reclaims, which is the duration the lease's own callers use, so a later
  // process recovers what a crashed release left by their normal rules.
  const leaseInputFor = (reclaimedOwner: NoClobberLeaseOwner): AcquireNoClobberLeaseInput => ({
    path: leaseDir,
    scope: input.scope,
    authoritySha256: reclaimedOwner.authority_sha256,
    staleAfterMs: recordedDuration(reclaimedOwner),
    validateStaleOwner: input.validateStaleOwner,
    recoverAbandonedOwnThread: true,
    onRecoveryStep: input.onRecoveryStep,
    onRelease: input.onRelease,
  });
  const proof: OwnerProofContext = { leaseKey, exitedThreadId: input.threadId };
  let reclaimed = false;

  const recoveryPath = join(leaseDir, "recovery");
  if (presentForRelease(recoveryPath)) {
    const claim = readRecoveryClaim(recoveryPath);
    if (
      claim.claimant.scope === input.scope &&
      (ownedByExitedThread(claim.claimant, input.threadId) || ownedByThisThread(claim.claimant))
    ) {
      // A claim of this thread is reconciled only when its acquisition has
      // ended (see `reclaimAbandonedRecovery`); otherwise this throws.
      reclaimAbandonedRecovery(
        leaseDir,
        recoveryPath,
        leaseInputFor(claim.claimant),
        Date.now(),
        proof,
      );
      reclaimed = true;
    }
  }

  const currentPath = join(leaseDir, "current");
  let current: ReturnType<typeof readOwner> | undefined;
  try {
    current = readOwner(currentPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current !== undefined && current.owner.scope === input.scope) {
    if (ownedByExitedThread(current.owner, input.threadId)) {
      retireOwnerOfExitedThread(leaseDir, current, leaseInputFor(current.owner));
      reclaimed = true;
    } else if (
      ownedByThisThread(current.owner) &&
      !thisThreadHolds(leaseKey) &&
      !acquisitionsInProgress.has(current.owner.owner_id)
    ) {
      // This thread's own abandoned owner: the own-thread rule applies,
      // including its expiry; an unexpired owner throws and is retried.
      acquireNoClobberLease(leaseInputFor(current.owner)).release();
      reclaimed = true;
    }
  }

  if (removeEndedRecoveryRecords(leaseDir, input.threadId)) reclaimed = true;
  return reclaimed;
}

/**
 * Retire an exited thread's owner through a recovery claim, without linking
 * a replacement owner. While the claim exists, a contender that links
 * `current` sees it and backs off, so no one can take the lease between the
 * unlink of the exited owner and the claim's retirement.
 */
function retireOwnerOfExitedThread(
  leaseDir: string,
  observed: { owner: NoClobberLeaseOwner; bytes: string },
  input: AcquireNoClobberLeaseInput,
): void {
  const created = Date.now();
  const claimantId = randomUUID();
  // The claimant record lives only inside the claim; no owner file is written.
  const claimant: NoClobberLeaseOwner = {
    schema_version: 1,
    owner_id: claimantId,
    owner_file: `owner-${claimantId}.json`,
    scope: input.scope,
    authority_sha256: input.authoritySha256,
    pid: process.pid,
    thread_id: currentThreadId,
    host: hostname(),
    created_at: new Date(created).toISOString(),
    expires_at: new Date(created + input.staleAfterMs).toISOString(),
  };
  const currentPath = join(leaseDir, "current");
  const recoveryPath = join(leaseDir, "recovery");
  acquisitionsInProgress.add(claimantId);
  try {
    createRecoveryClaim(leaseDir, recoveryPath, claimant, observed, true);
    input.onRecoveryStep?.("claim_created");

    const pinPath = join(recoveryPath, "stale-pin");
    try {
      linkSync(currentPath, pinPath);
      assertSameInodeAndBytes(currentPath, pinPath, observed.bytes);
    } catch {
      abortUnchangedRecoveryClaim(leaseDir, recoveryPath, claimant);
      throw new Error(`lease ${input.scope} recovery raced with another contender`);
    }
    fsyncDirectory(recoveryPath);
    input.onRecoveryStep?.("stale_pinned");

    assertSameInodeAndBytes(currentPath, pinPath, observed.bytes);
    unlinkSync(currentPath);
    fsyncDirectory(leaseDir);
    input.onRecoveryStep?.("current_removed");

    removePinnedOwner(leaseDir, pinPath, observed.owner);
    retireRecoveryClaim(leaseDir, recoveryPath, claimant, () =>
      input.onRecoveryStep?.("recovery_retired"),
    );
  } finally {
    acquisitionsInProgress.delete(claimantId);
  }
}

/**
 * Remove records that block no one but that a release or acquisition which
 * stopped part-way left behind: owner files of the exited thread that are not
 * `current`, and the private claim directories (being created or retired) of
 * a claimant that is the exited thread or this thread with its acquisition
 * ended. Only the claimant itself ever uses those directories.
 */
function removeEndedRecoveryRecords(leaseDir: string, exitedThreadId: number): boolean {
  const currentPath = join(leaseDir, "current");
  let removed = false;
  for (const name of readdirSync(leaseDir)) {
    const path = join(leaseDir, name);
    if (name.startsWith("owner-")) {
      let owner: NoClobberLeaseOwner;
      try {
        owner = readOwner(path).owner;
      } catch (error) {
        rethrowIoError(error);
        continue;
      }
      if (owner.owner_file !== name || !ownedByExitedThread(owner, exitedThreadId)) continue;
      if (presentForRelease(currentPath) && sameInode(path, currentPath)) continue;
      unlinkSync(path);
      removed = true;
      continue;
    }
    if (!name.startsWith("recovery-retired-") && !name.startsWith("recovery-claim-")) continue;
    if (!presentForRelease(join(path, "claim.json"))) continue;
    let claim: RecoveryClaim;
    try {
      claim = readRecoveryClaim(path);
    } catch (error) {
      rethrowIoError(error);
      continue;
    }
    const claimant = claim.claimant;
    if (!name.endsWith(`-${claimant.owner_id}`)) continue;
    const ended =
      ownedByExitedThread(claimant, exitedThreadId) ||
      (ownedByThisThread(claimant) && !acquisitionsInProgress.has(claimant.owner_id));
    if (!ended) continue;
    safeUnlink(join(path, "stale-pin"));
    unlinkSync(join(path, "claim.json"));
    rmdirSync(path);
    removed = true;
  }
  if (removed) fsyncDirectory(leaseDir);
  return removed;
}

/** The duration an owner record was written with: its caller's `staleAfterMs`. */
function recordedDuration(owner: NoClobberLeaseOwner): number {
  const duration = Date.parse(owner.expires_at) - Date.parse(owner.created_at);
  if (!Number.isSafeInteger(duration) || duration < 1) {
    throw new Error(`lease ${owner.scope} owner has an invalid duration`);
  }
  return duration;
}

function ownedByExitedThread(owner: NoClobberLeaseOwner, exitedThreadId: number): boolean {
  return (
    owner.host === hostname() &&
    owner.pid === process.pid &&
    owner.thread_id === exitedThreadId &&
    exitedThreadId !== currentThreadId
  );
}

function ownedByThisThread(owner: NoClobberLeaseOwner): boolean {
  return (
    owner.host === hostname() && owner.pid === process.pid && owner.thread_id === currentThreadId
  );
}

/**
 * Whether the holder of an owner record is provably gone without consulting
 * process liveness. Two cases qualify, and both name this host, this process
 * and a thread id:
 *
 * - The caller asserted (exited-thread release) that the owner's thread exited.
 * - The owner is this thread, the caller opted in, the lease has expired, and
 *   this thread holds no handle for the lease and runs no acquisition as that
 *   owner. The thread is synchronous, so a holder still running in it would
 *   appear in its registry.
 *
 * An owner from any other thread or process, or without a thread id, is never
 * proven gone here.
 */
function ownerHolderIsGone(
  owner: NoClobberLeaseOwner,
  now: number,
  input: AcquireNoClobberLeaseInput,
  proof: OwnerProofContext,
  role: "lease" | "claimant",
): boolean {
  if (owner.host !== hostname() || owner.pid !== process.pid || owner.thread_id === undefined) {
    return false;
  }
  if (proof.exitedThreadId !== undefined && ownedByExitedThread(owner, proof.exitedThreadId)) {
    return Number.isFinite(Date.parse(owner.created_at));
  }
  if (input.recoverAbandonedOwnThread !== true || owner.thread_id !== currentThreadId) return false;
  if (!expired(owner, now, input.staleAfterMs)) return false;
  if (acquisitionsInProgress.has(owner.owner_id)) return false;
  return role === "claimant" || !thisThreadHolds(proof.leaseKey);
}

function thisThreadHolds(leaseKey: string): boolean {
  const entry = heldByThisThread.get(leaseKey);
  if (!entry) return false;
  if (entry.token.deref() !== undefined) return true;
  heldByThisThread.delete(leaseKey);
  return false;
}

/**
 * The lease directory's real path, with no symlinked component, and its
 * identity: device and inode, so two paths that reach one directory (a
 * symlinked parent, a bind mount, a case-insensitive spelling) share a key.
 * Where the filesystem reports no inode, the real path is the key. The
 * directory must already exist; acquisition creates it first.
 */
function canonicalLeaseDirectory(path: string): { leaseDir: string; leaseKey: string } {
  const leaseDir = realpathSync.native(resolve(path));
  const stat = lstatSync(leaseDir, { bigint: true });
  if (!stat.isDirectory()) throw new Error(`lease path is not a directory: ${leaseDir}`);
  const leaseKey = stat.ino > 0n ? `inode:${stat.dev}:${stat.ino}` : `path:${leaseDir}`;
  return { leaseDir, leaseKey };
}

function expired(owner: NoClobberLeaseOwner, now: number, staleAfterMs: number): boolean {
  const created = Date.parse(owner.created_at);
  const expires = Date.parse(owner.expires_at);
  return (
    Number.isFinite(created) &&
    Number.isFinite(expires) &&
    expires === created + staleAfterMs &&
    now >= created &&
    now >= expires
  );
}

function validateInput(input: AcquireNoClobberLeaseInput): void {
  if (
    !SAFE_COMPONENT.test(basename(resolve(input.path))) ||
    !SAFE_COMPONENT.test(input.scope) ||
    !/^[a-f0-9]{64}$/.test(input.authoritySha256) ||
    !Number.isSafeInteger(input.staleAfterMs) ||
    input.staleAfterMs < 1
  ) {
    throw new Error("no-clobber lease input is invalid");
  }
}

function ensureLeaseDirectory(leaseDir: string, onCreate?: () => void): void {
  mkdirSync(dirname(leaseDir), { recursive: true, mode: stateDirMode() });
  let created = false;
  onCreate?.();
  try {
    mkdirSync(leaseDir, { mode: stateDirMode() });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!lstatSync(leaseDir).isDirectory()) {
    throw new Error(`lease path is not a directory: ${leaseDir}`);
  }
  if (created) {
    fsyncDirectory(dirname(leaseDir));
  }
}

function createRecoveryClaim(
  leaseDir: string,
  recoveryPath: string,
  claimant: NoClobberLeaseOwner,
  observed: { owner: NoClobberLeaseOwner; bytes: string },
  observedHolderExited: boolean,
): void {
  const temporary = join(leaseDir, `recovery-claim-${claimant.owner_id}`);
  mkdirSync(temporary, { mode: stateDirMode() });
  const claim: RecoveryClaim = {
    schema_version: 1,
    claimant,
    observed_owner: observed.owner,
    observed_sha256: digestBytes(observed.bytes),
    created_at: claimant.created_at,
  };
  if (observedHolderExited) claim.observed_holder_exited = true;
  try {
    writeExclusive(join(temporary, "claim.json"), `${JSON.stringify(claim)}\n`);
    fsyncDirectory(temporary);
    try {
      renameSync(temporary, recoveryPath);
      fsyncDirectory(leaseDir);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EEXIST" ||
        (error as NodeJS.ErrnoException).code === "ENOTEMPTY"
      ) {
        unlinkSync(join(temporary, "claim.json"));
        rmdirSync(temporary);
        throw new Error(`lease ${claimant.scope} recovery is already in progress`);
      }
      throw error;
    }
  } catch (error) {
    if (existsSync(join(temporary, "claim.json"))) unlinkSync(join(temporary, "claim.json"));
    if (existsSync(temporary)) rmdirSync(temporary);
    throw error;
  }
}

function reclaimAbandonedRecovery(
  leaseDir: string,
  recoveryPath: string,
  input: AcquireNoClobberLeaseInput,
  now: number,
  proof: OwnerProofContext,
): OwnerProofContext["exitedOwner"] {
  const claim = readRecoveryClaim(recoveryPath);
  if (
    !ownerHolderIsGone(claim.claimant, now, input, proof, "claimant") &&
    !exitedHolderClaimEnded(claim, input) &&
    leaseIsLive(claim.claimant, now, input.staleAfterMs, input.probePid)
  ) {
    throw new Error(`lease ${input.scope} recovery is already in progress`);
  }
  // The claimant is gone, so its record that the observed holder's thread
  // exited is all that remains of that proof; carry it to `current`.
  const exitedOwner = claimRecordsExitedHolder(claim)
    ? { ownerId: claim.observed_owner.owner_id, sha256: claim.observed_sha256 }
    : undefined;
  if (
    claim.claimant.scope !== input.scope ||
    claim.observed_owner.scope !== input.scope ||
    (exitedOwner === undefined &&
      !ownerHolderIsGone(claim.observed_owner, now, input, proof, "lease") &&
      input.validateStaleOwner !== undefined &&
      !input.validateStaleOwner(claim.observed_owner))
  ) {
    throw new Error(`stale lease ${input.scope} recovery has mismatched authority`);
  }
  const recoveryPin = join(recoveryPath, "stale-pin");
  if (presentForRelease(recoveryPin)) {
    const pinned = readOwner(recoveryPin);
    if (
      pinned.owner.owner_id !== claim.observed_owner.owner_id ||
      digestBytes(pinned.bytes) !== claim.observed_sha256
    ) {
      throw new Error(`stale lease ${input.scope} recovery pin is corrupt`);
    }
  }

  const quarantine = join(leaseDir, `quarantine-${randomUUID()}`);
  try {
    renameSync(recoveryPath, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`lease ${input.scope} recovery raced with another contender`);
    }
    throw error;
  }
  fsyncDirectory(leaseDir);

  const pinPath = join(quarantine, "stale-pin");
  if (presentForRelease(pinPath)) {
    const pinned = readOwner(pinPath);
    if (
      pinned.owner.owner_id !== claim.observed_owner.owner_id ||
      digestBytes(pinned.bytes) !== claim.observed_sha256
    ) {
      throw new Error(`stale lease ${input.scope} recovery pin is corrupt`);
    }
    removePinnedOwner(leaseDir, pinPath, pinned.owner);
    unlinkSync(pinPath);
  }
  const claimantPath = join(leaseDir, claim.claimant.owner_file);
  const currentPath = join(leaseDir, "current");
  if (
    presentForRelease(claimantPath) &&
    (!presentForRelease(currentPath) || !sameInode(claimantPath, currentPath))
  ) {
    unlinkSync(claimantPath);
  }
  unlinkSync(join(quarantine, "claim.json"));
  rmdirSync(quarantine);
  fsyncDirectory(leaseDir);
  return exitedOwner;
}

/**
 * Whether an abandoned claim records that its observed owner's thread exited.
 * Only a claim whose observed owner is another thread of the claimant's own
 * host and process qualifies, which is the only case the exited-thread
 * release writes it for.
 */
function claimRecordsExitedHolder(claim: RecoveryClaim): boolean {
  const { claimant, observed_owner: observed } = claim;
  return (
    claim.observed_holder_exited === true &&
    observed.host === claimant.host &&
    observed.pid === claimant.pid &&
    observed.thread_id !== undefined &&
    claimant.thread_id !== undefined &&
    observed.thread_id !== claimant.thread_id
  );
}

/**
 * Whether a claim that records an exited holder was made by this thread in an
 * acquisition or release that has ended. Such a claim is only ever made and
 * retired within one synchronous call, so once no acquisition in this thread
 * runs as its claimant, it protects nothing, whatever its expiry. Other
 * threads cannot see this thread's acquisitions and keep respecting it.
 */
function exitedHolderClaimEnded(claim: RecoveryClaim, input: AcquireNoClobberLeaseInput): boolean {
  return (
    input.recoverAbandonedOwnThread === true &&
    claimRecordsExitedHolder(claim) &&
    ownedByThisThread(claim.claimant) &&
    !acquisitionsInProgress.has(claim.claimant.owner_id)
  );
}

/**
 * Whether the observed owner's holder thread is known to have exited: an
 * abandoned claim recorded it for this exact owner record.
 */
function observedHolderExited(
  observed: { owner: NoClobberLeaseOwner; bytes: string },
  proof: OwnerProofContext,
): boolean {
  return (
    proof.exitedOwner !== undefined &&
    observed.owner.owner_id === proof.exitedOwner.ownerId &&
    digestBytes(observed.bytes) === proof.exitedOwner.sha256
  );
}

function abortUnchangedRecoveryClaim(
  leaseDir: string,
  recoveryPath: string,
  claimant: NoClobberLeaseOwner,
): void {
  const claim = readRecoveryClaim(recoveryPath);
  if (claim.claimant.owner_id !== claimant.owner_id) {
    throw new Error(`lease ${claimant.scope} recovery ownership changed`);
  }
  retireRecoveryClaim(leaseDir, recoveryPath, claimant);
}

/**
 * Move this claimant's recovery directory to a private name before emptying
 * it. Renaming a directory onto an existing empty directory replaces it, so
 * emptying `recovery` in place would let a contender's claim land there and
 * fail this claimant's final rmdir after it already holds the lease.
 */
function retireRecoveryClaim(
  leaseDir: string,
  recoveryPath: string,
  claimant: NoClobberLeaseOwner,
  onRetired?: () => void,
): void {
  const retired = join(leaseDir, `recovery-retired-${claimant.owner_id}`);
  renameSync(recoveryPath, retired);
  fsyncDirectory(leaseDir);
  onRetired?.();
  safeUnlink(join(retired, "stale-pin"));
  unlinkSync(join(retired, "claim.json"));
  rmdirSync(retired);
  fsyncDirectory(leaseDir);
}

function readRecoveryClaim(recoveryPath: string): RecoveryClaim {
  const path = join(recoveryPath, "claim.json");
  const size = lstatSync(path).size;
  if (size <= 0 || size > MAX_LEASE_BYTES * 2) {
    throw new Error("lease recovery claim bytes are invalid");
  }
  let claim: RecoveryClaim;
  try {
    claim = JSON.parse(readFileSync(path, "utf8")) as RecoveryClaim;
  } catch (error) {
    throw new Error(`lease recovery claim is corrupt: ${(error as Error).message}`);
  }
  if (
    claim.schema_version !== 1 ||
    !validOwner(claim.claimant) ||
    !validOwner(claim.observed_owner) ||
    !/^[a-f0-9]{64}$/.test(claim.observed_sha256) ||
    typeof claim.created_at !== "string" ||
    claim.created_at !== claim.claimant.created_at ||
    (claim.observed_holder_exited !== undefined && claim.observed_holder_exited !== true)
  ) {
    throw new Error("lease recovery claim has an unsupported schema");
  }
  return claim;
}

function leaseHandle(
  leaseDir: string,
  leaseKey: string,
  ownerPath: string,
  ownerBytes: string,
  owner: NoClobberLeaseOwner,
  onRelease?: () => void,
  recoveredOwner?: NoClobberLeaseOwner,
): NoClobberLease {
  let released = false;
  // Registered only after `current` is ours. `release` closes over the token,
  // so a holder that keeps either the handle or its release function keeps
  // the registry entry live; a release attempt ends it whether or not the
  // filesystem steps succeed.
  const token = {};
  heldByThisThread.set(leaseKey, { ownerId: owner.owner_id, token: new WeakRef(token) });
  const handle: NoClobberLease = {
    owner,
    release() {
      if (released) return;
      try {
        onRelease?.();
        const currentPath = join(leaseDir, "current");
        assertExactOwner(currentPath, ownerPath, ownerBytes, owner);
        unlinkSync(currentPath);
        unlinkSync(ownerPath);
        fsyncDirectory(leaseDir);
        released = true;
      } finally {
        const entry = heldByThisThread.get(leaseKey);
        if (entry?.ownerId === owner.owner_id && entry.token.deref() === token) {
          heldByThisThread.delete(leaseKey);
        }
      }
    },
  };
  if (recoveredOwner) handle.recovered_owner = recoveredOwner;
  return handle;
}

function writeExclusive(path: string, bytes: string): void {
  const fd = openSync(path, "wx", stateFileMode());
  try {
    writeFileSync(fd, bytes, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readOwner(path: string): { owner: NoClobberLeaseOwner; bytes: string } {
  let size: number;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("lease owner is not a plain file");
    size = stat.size;
  } catch (error) {
    const inspectionError = new Error(
      `lease owner cannot be inspected: ${(error as Error).message}`,
    ) as NodeJS.ErrnoException;
    inspectionError.code = (error as NodeJS.ErrnoException).code;
    throw inspectionError;
  }
  if (size <= 0 || size > MAX_LEASE_BYTES) throw new Error("lease owner bytes are invalid");
  let bytes: string;
  try {
    bytes = readFileSync(path, "utf8");
  } catch (error) {
    const inspectionError = new Error(
      `lease owner cannot be read: ${(error as Error).message}`,
    ) as NodeJS.ErrnoException;
    inspectionError.code = (error as NodeJS.ErrnoException).code;
    throw inspectionError;
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch (error) {
    throw new Error(`lease owner is corrupt: ${(error as Error).message}`);
  }
  if (!validOwner(value)) throw new Error("lease owner has an unsupported schema");
  return { owner: value, bytes };
}

function validOwner(value: unknown): value is NoClobberLeaseOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return (
    owner.schema_version === 1 &&
    typeof owner.owner_id === "string" &&
    typeof owner.owner_file === "string" &&
    owner.owner_file === `owner-${owner.owner_id}.json` &&
    SAFE_COMPONENT.test(owner.owner_file) &&
    typeof owner.scope === "string" &&
    SAFE_COMPONENT.test(owner.scope) &&
    typeof owner.authority_sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(owner.authority_sha256) &&
    (owner.metadata === undefined ||
      (isStringRecord(owner.metadata) && Object.keys(owner.metadata).length <= 20)) &&
    Number.isSafeInteger(owner.pid) &&
    (owner.pid as number) > 0 &&
    (owner.thread_id === undefined ||
      (Number.isSafeInteger(owner.thread_id) && (owner.thread_id as number) >= 0)) &&
    typeof owner.host === "string" &&
    owner.host.length > 0 &&
    typeof owner.created_at === "string" &&
    typeof owner.expires_at === "string" &&
    Number.isFinite(Date.parse(owner.created_at)) &&
    Number.isFinite(Date.parse(owner.expires_at))
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, item]) => SAFE_COMPONENT.test(key) && typeof item === "string" && item.length <= 1_000,
    )
  );
}

function leaseIsLive(
  owner: NoClobberLeaseOwner,
  now: number,
  staleAfterMs: number,
  probePid: (pid: number) => void = (pid) => {
    process.kill(pid, 0);
  },
): boolean {
  const created = Date.parse(owner.created_at);
  const expires = Date.parse(owner.expires_at);
  if (
    !Number.isFinite(created) ||
    !Number.isFinite(expires) ||
    expires !== created + staleAfterMs ||
    now < created ||
    now < expires
  ) {
    return true;
  }
  // Expiry only makes a same-host owner eligible for a process check. Neither
  // a remote owner nor an unreadable probe proves that its work has stopped.
  if (owner.host !== hostname()) return true;
  try {
    probePid(owner.pid);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function assertExactOwner(
  currentPath: string,
  ownerPath: string,
  expectedBytes: string,
  owner: NoClobberLeaseOwner,
): void {
  const current = readOwner(currentPath);
  if (
    current.bytes !== expectedBytes ||
    current.owner.owner_id !== owner.owner_id ||
    !sameInode(currentPath, ownerPath)
  ) {
    throw new Error(`lease ${owner.scope} ownership changed`);
  }
}

function unlinkExactCurrent(currentPath: string, ownerPath: string): void {
  if (presentForRelease(currentPath) && sameInode(currentPath, ownerPath)) unlinkSync(currentPath);
}

function removePinnedOwner(leaseDir: string, pinPath: string, owner: NoClobberLeaseOwner): void {
  const staleOwnerPath = join(leaseDir, owner.owner_file);
  if (
    basename(staleOwnerPath) === owner.owner_file &&
    presentForRelease(staleOwnerPath) &&
    sameInode(staleOwnerPath, pinPath)
  ) {
    unlinkSync(staleOwnerPath);
  }
}

function assertSameInodeAndBytes(left: string, right: string, expectedBytes: string): void {
  if (!sameInode(left, right)) throw new Error("lease recovery owner inode changed");
  const leftBytes = readFileSync(left, "utf8");
  const rightBytes = readFileSync(right, "utf8");
  if (leftBytes !== expectedBytes || rightBytes !== expectedBytes) {
    throw new Error("lease recovery owner bytes changed");
  }
}

function sameInode(left: string, right: string): boolean {
  const a = statSync(left, { bigint: true });
  const b = statSync(right, { bigint: true });
  return a.dev === b.dev && a.ino === b.ino;
}

function digestBytes(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
