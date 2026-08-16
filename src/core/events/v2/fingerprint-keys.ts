import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { fsyncParentDirectory } from "../../workflow/durable-record.ts";
import { acquireNoClobberLease } from "../../workflow/workspaces/leases.ts";
import type { FingerprintContextV2 } from "./canonical.ts";

const KEY_BYTES = 32;
const LOCK_RETRIES = 200;
const LOCK_RETRY_MS = 5;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export const FINGERPRINT_KEY_STORE_RELATIVE_PATH =
  ".harnery/private/fingerprint-keys.json" as const;

export interface FingerprintKeyEpochV2 {
  epoch_id: `pep_${string}`;
  key_base64url: string;
  created_at: string;
}

export interface FingerprintKeyStoreV2 {
  format: "harnery-v2-fingerprint-keys";
  format_version: 1;
  active_epoch_id: `pep_${string}`;
  epochs: FingerprintKeyEpochV2[];
}

export interface RotateFingerprintEpochV2Options {
  activeGenerationCount: number;
  now?: () => Date;
}

export function fingerprintKeyStorePathV2(coordRoot: string): string {
  return join(resolve(coordRoot), FINGERPRINT_KEY_STORE_RELATIVE_PATH);
}

/** Load the private key store, creating its first epoch under an exclusive publication lock. */
export function loadOrCreateFingerprintKeyStoreV2(
  coordRoot: string,
  now: () => Date = () => new Date(),
): FingerprintKeyStoreV2 {
  const path = fingerprintKeyStorePathV2(coordRoot);
  if (existsSync(path)) return readFingerprintKeyStoreV2(coordRoot);
  return withKeyStoreLock(coordRoot, () => {
    if (existsSync(path)) return readFingerprintKeyStoreV2(coordRoot);
    const epoch = createEpoch(now);
    const store: FingerprintKeyStoreV2 = {
      format: "harnery-v2-fingerprint-keys",
      format_version: 1,
      active_epoch_id: epoch.epoch_id,
      epochs: [epoch],
    };
    publishKeyStore(path, store, false);
    return store;
  });
}

export function readFingerprintKeyStoreV2(coordRoot: string): FingerprintKeyStoreV2 {
  const path = fingerprintKeyStorePathV2(coordRoot);
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error("fingerprint key store permissions are not owner-only");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("fingerprint key store is unreadable or malformed");
  }
  return validateKeyStore(parsed);
}

/** Start a new comparison epoch only when no generation can still emit under the prior key. */
export function rotateFingerprintEpochV2(
  coordRoot: string,
  options: RotateFingerprintEpochV2Options,
): FingerprintKeyStoreV2 {
  if (!Number.isSafeInteger(options.activeGenerationCount) || options.activeGenerationCount < 0) {
    throw new Error("active generation count must be a non-negative integer");
  }
  if (options.activeGenerationCount !== 0) {
    throw new Error("fingerprint epoch rotation is blocked while generations are active");
  }
  loadOrCreateFingerprintKeyStoreV2(coordRoot, options.now);
  return withKeyStoreLock(coordRoot, () => {
    const current = readFingerprintKeyStoreV2(coordRoot);
    const epoch = createEpoch(options.now ?? (() => new Date()));
    const next: FingerprintKeyStoreV2 = {
      ...current,
      active_epoch_id: epoch.epoch_id,
      epochs: [...current.epochs, epoch],
    };
    publishKeyStore(fingerprintKeyStorePathV2(coordRoot), next, true);
    return next;
  });
}

export function fingerprintContextV2(
  coordRoot: string,
  rootId: `root_${string}`,
  generationId?: `gen_${string}`,
  epochId?: `pep_${string}`,
): FingerprintContextV2 {
  const store = readFingerprintKeyStoreV2(coordRoot);
  const selectedId = epochId ?? store.active_epoch_id;
  const epoch = store.epochs.find((candidate) => candidate.epoch_id === selectedId);
  if (!epoch) throw new Error("requested fingerprint epoch is unavailable");
  return {
    epochId: epoch.epoch_id,
    epochKey: Buffer.from(epoch.key_base64url, "base64url"),
    rootId,
    generationId,
  };
}

function withKeyStoreLock<T>(coordRoot: string, operation: () => T): T {
  const privateDir = join(resolve(coordRoot), ".harnery/private");
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  chmodSync(privateDir, 0o700);
  const leasePath = join(privateDir, "fingerprint-key-lease");
  const authority = createHash("sha256").update(resolve(coordRoot)).digest("hex");
  let lease: ReturnType<typeof acquireNoClobberLease> | undefined;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      lease = acquireNoClobberLease({
        path: leasePath,
        scope: "event-v2-fingerprint-key",
        authoritySha256: authority,
        staleAfterMs: 5_000,
        validateStaleOwner: (owner) => owner.host === hostname() && !pidIsAlive(owner.pid),
      });
      break;
    } catch (error) {
      if (attempt === LOCK_RETRIES - 1) throw error;
      Atomics.wait(sleepCell, 0, 0, LOCK_RETRY_MS);
    }
  }
  if (!lease) throw new Error("fingerprint key store publication lease is busy");
  try {
    return operation();
  } finally {
    lease.release();
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function publishKeyStore(path: string, store: FingerprintKeyStoreV2, replacing: boolean): void {
  if (!replacing && existsSync(path)) throw new Error("fingerprint key store already exists");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(store)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temporary, 0o600);
    if (!replacing && existsSync(path)) throw new Error("fingerprint key store already exists");
    renameSync(temporary, path);
    fsyncParentDirectory(path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function createEpoch(now: () => Date): FingerprintKeyEpochV2 {
  return {
    epoch_id: `pep_${randomUUID()}`,
    key_base64url: randomBytes(KEY_BYTES).toString("base64url"),
    created_at: now().toISOString(),
  };
}

function validateKeyStore(value: unknown): FingerprintKeyStoreV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("fingerprint key store has an invalid envelope");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join("\0") !== "active_epoch_id\0epochs\0format\0format_version") {
    throw new Error("fingerprint key store has unsupported fields");
  }
  if (record.format !== "harnery-v2-fingerprint-keys" || record.format_version !== 1) {
    throw new Error("fingerprint key store format is unsupported");
  }
  if (
    typeof record.active_epoch_id !== "string" ||
    !/^pep_[a-zA-Z0-9._-]{1,128}$/.test(record.active_epoch_id)
  ) {
    throw new Error("fingerprint key store active epoch is invalid");
  }
  if (!Array.isArray(record.epochs) || record.epochs.length === 0) {
    throw new Error("fingerprint key store has no epochs");
  }
  const seen = new Set<string>();
  const epochs = record.epochs.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("fingerprint key epoch is invalid");
    }
    const epoch = candidate as Record<string, unknown>;
    if (Object.keys(epoch).sort().join("\0") !== "created_at\0epoch_id\0key_base64url") {
      throw new Error("fingerprint key epoch has unsupported fields");
    }
    if (typeof epoch.epoch_id !== "string" || !/^pep_[a-zA-Z0-9._-]{1,128}$/.test(epoch.epoch_id)) {
      throw new Error("fingerprint key epoch ID is invalid");
    }
    if (seen.has(epoch.epoch_id)) throw new Error("fingerprint key epoch is duplicated");
    seen.add(epoch.epoch_id);
    if (typeof epoch.key_base64url !== "string") {
      throw new Error("fingerprint key bytes are invalid");
    }
    const key = Buffer.from(epoch.key_base64url, "base64url");
    if (key.length !== KEY_BYTES || key.toString("base64url") !== epoch.key_base64url) {
      throw new Error("fingerprint key bytes are invalid");
    }
    if (typeof epoch.created_at !== "string" || Number.isNaN(Date.parse(epoch.created_at))) {
      throw new Error("fingerprint key epoch time is invalid");
    }
    return epoch as unknown as FingerprintKeyEpochV2;
  });
  if (!seen.has(record.active_epoch_id)) {
    throw new Error("fingerprint key store active epoch is missing");
  }
  return {
    format: "harnery-v2-fingerprint-keys",
    format_version: 1,
    active_epoch_id: record.active_epoch_id as `pep_${string}`,
    epochs,
  };
}
