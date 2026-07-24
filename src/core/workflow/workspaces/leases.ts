import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const MAX_LEASE_BYTES = 8 * 1024;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface NoClobberLeaseOwner {
  schema_version: 1;
  owner_id: string;
  owner_file: string;
  scope: string;
  authority_sha256: string;
  metadata?: Record<string, string>;
  pid: number;
  host: string;
  created_at: string;
  expires_at: string;
}

export type LeaseRecoveryStep =
  | "claim_created"
  | "stale_pinned"
  | "current_removed"
  | "new_current_linked";

export interface AcquireNoClobberLeaseInput {
  path: string;
  scope: string;
  authoritySha256: string;
  metadata?: Readonly<Record<string, string>>;
  staleAfterMs: number;
  validateStaleOwner?: (owner: NoClobberLeaseOwner) => boolean;
  now?: () => number;
  pid?: number;
  host?: string;
  onRecoveryStep?: (step: LeaseRecoveryStep) => void;
}

export interface NoClobberLease {
  owner: NoClobberLeaseOwner;
  recovered_owner?: NoClobberLeaseOwner;
  release(): void;
}

interface RecoveryClaim {
  schema_version: 1;
  claimant: NoClobberLeaseOwner;
  observed_owner: NoClobberLeaseOwner;
  observed_sha256: string;
  created_at: string;
}

/**
 * Acquires a crash-safe lease whose active name is always a hard link to one
 * immutable owner file. Stale takeover is serialized by an atomic recovery
 * directory; only its claimant may pin and replace the observed `current`.
 */
export function acquireNoClobberLease(input: AcquireNoClobberLeaseInput): NoClobberLease {
  validateInput(input);
  const leaseDir = resolve(input.path);
  ensureLeaseDirectory(leaseDir);

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
  try {
    if (existsSync(recoveryPath)) {
      reclaimAbandonedRecovery(leaseDir, recoveryPath, input, now());
    }

    try {
      linkSync(ownerPath, currentPath);
      fsyncDirectory(leaseDir);
      assertExactOwner(currentPath, ownerPath, ownerBytes, owner);
      if (existsSync(recoveryPath)) {
        unlinkExactCurrent(currentPath, ownerPath);
        throw new Error(`lease ${input.scope} recovery is already in progress`);
      }
      return leaseHandle(leaseDir, ownerPath, ownerBytes, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const observed = readOwner(currentPath);
    if (leaseIsLive(observed.owner, now(), input.staleAfterMs)) {
      throw new Error(`lease ${input.scope} is held by a live or unexpired owner`);
    }
    if (
      observed.owner.scope !== input.scope ||
      (input.validateStaleOwner !== undefined && !input.validateStaleOwner(observed.owner))
    ) {
      throw new Error(`stale lease ${input.scope} has mismatched authority`);
    }

    createRecoveryClaim(leaseDir, recoveryPath, owner, observed);
    recoveryClaimed = true;
    input.onRecoveryStep?.("claim_created");

    const pinPath = join(recoveryPath, "stale-pin");
    linkSync(currentPath, pinPath);
    assertSameInodeAndBytes(currentPath, pinPath, observed.bytes);
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
    unlinkSync(pinPath);
    unlinkSync(join(recoveryPath, "claim.json"));
    rmdirSync(recoveryPath);
    fsyncDirectory(leaseDir);
    return {
      ...leaseHandle(leaseDir, ownerPath, ownerBytes, owner),
      recovered_owner: observed.owner,
    };
  } catch (error) {
    // Once the recovery directory exists, leave every boundary intact. A
    // later owner can quarantine that exact abandoned claim and reconcile it.
    if (!recoveryClaimed) safeUnlink(ownerPath);
    throw error;
  }
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

function ensureLeaseDirectory(leaseDir: string): void {
  mkdirSync(dirname(leaseDir), { recursive: true, mode: 0o700 });
  if (existsSync(leaseDir) && !lstatSync(leaseDir).isDirectory()) {
    throw new Error(`lease path is not a directory: ${leaseDir}`);
  }
  if (!existsSync(leaseDir)) {
    mkdirSync(leaseDir, { mode: 0o700 });
    fsyncDirectory(dirname(leaseDir));
  }
}

function createRecoveryClaim(
  leaseDir: string,
  recoveryPath: string,
  claimant: NoClobberLeaseOwner,
  observed: { owner: NoClobberLeaseOwner; bytes: string },
): void {
  const temporary = join(leaseDir, `recovery-claim-${claimant.owner_id}`);
  mkdirSync(temporary, { mode: 0o700 });
  const claim: RecoveryClaim = {
    schema_version: 1,
    claimant,
    observed_owner: observed.owner,
    observed_sha256: digestBytes(observed.bytes),
    created_at: claimant.created_at,
  };
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
): void {
  const claim = readRecoveryClaim(recoveryPath);
  if (leaseIsLive(claim.claimant, now, input.staleAfterMs)) {
    throw new Error(`lease ${input.scope} recovery is already in progress`);
  }
  if (
    claim.claimant.scope !== input.scope ||
    claim.observed_owner.scope !== input.scope ||
    (input.validateStaleOwner !== undefined && !input.validateStaleOwner(claim.observed_owner))
  ) {
    throw new Error(`stale lease ${input.scope} recovery has mismatched authority`);
  }
  const recoveryPin = join(recoveryPath, "stale-pin");
  if (existsSync(recoveryPin)) {
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
  if (existsSync(pinPath)) {
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
    existsSync(claimantPath) &&
    (!existsSync(currentPath) || !sameInode(claimantPath, currentPath))
  ) {
    unlinkSync(claimantPath);
  }
  unlinkSync(join(quarantine, "claim.json"));
  rmdirSync(quarantine);
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
    claim.created_at !== claim.claimant.created_at
  ) {
    throw new Error("lease recovery claim has an unsupported schema");
  }
  return claim;
}

function leaseHandle(
  leaseDir: string,
  ownerPath: string,
  ownerBytes: string,
  owner: NoClobberLeaseOwner,
): NoClobberLease {
  let released = false;
  return {
    owner,
    release() {
      if (released) return;
      const currentPath = join(leaseDir, "current");
      assertExactOwner(currentPath, ownerPath, ownerBytes, owner);
      unlinkSync(currentPath);
      unlinkSync(ownerPath);
      fsyncDirectory(leaseDir);
      released = true;
    },
  };
}

function writeExclusive(path: string, bytes: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, bytes, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readOwner(path: string): { owner: NoClobberLeaseOwner; bytes: string } {
  let size: number;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("lease owner is not a plain file");
    size = stat.size;
  } catch (error) {
    throw new Error(`lease owner cannot be inspected: ${(error as Error).message}`);
  }
  if (size <= 0 || size > MAX_LEASE_BYTES) throw new Error("lease owner bytes are invalid");
  const bytes = readFileSync(path, "utf8");
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

function leaseIsLive(owner: NoClobberLeaseOwner, now: number, staleAfterMs: number): boolean {
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
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
  if (existsSync(currentPath) && sameInode(currentPath, ownerPath)) unlinkSync(currentPath);
}

function removePinnedOwner(leaseDir: string, pinPath: string, owner: NoClobberLeaseOwner): void {
  const staleOwnerPath = join(leaseDir, owner.owner_file);
  if (
    basename(staleOwnerPath) === owner.owner_file &&
    existsSync(staleOwnerPath) &&
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

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
