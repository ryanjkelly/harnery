import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface FileRevision {
  readonly bytes: Buffer;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export type DeleteFileResult =
  | { state: "deleted" | "changed" | "missing" | "rejected" }
  | { state: "recovery-required"; recoveryPath: string; error?: string }
  | { state: "error"; recoveryPath?: string; error: string };

export interface FileRecoveryResult {
  state: "restored" | "retained" | "error";
  recoveryPath: string;
  sourcePath?: string;
  error?: string;
}

const PRIVATE_PREFIX = ".harnery-delete-";
const MANIFEST = "intent.json";
const PIN = "pinned";

interface PinIntent {
  version: 1;
  source: string;
  ownerPid: number;
  ownerHost: string;
  ownerPlatform: string;
  ownerProcessNamespace: string;
  state: "active" | "retained";
}

interface PrivateDirectoryRevision {
  path: string;
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function sameRevision(a: FileRevision, b: FileRevision, includeCtime = true): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    (!includeCtime || a.ctimeNs === b.ctimeNs) &&
    a.bytes.equals(b.bytes)
  );
}

function sameCanonicalPath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function processNamespace(): string {
  if (process.platform === "linux") {
    try {
      const namespace = readlinkSync("/proc/self/ns/pid");
      return /^pid:\[\d+\]$/.test(namespace) ? namespace : "unknown";
    } catch {
      return "unknown";
    }
  }
  return process.platform === "win32" || process.platform === "darwin" ? "host" : "unknown";
}

/** Refuse symlink parents and protocol-private paths rather than following them. */
function safePath(filePath: string): string | null {
  const path = resolve(filePath);
  if (basename(path).startsWith(PRIVATE_PREFIX)) return null;
  try {
    if (!sameCanonicalPath(realpathSync(dirname(path)), dirname(path))) return null;
    return path;
  } catch {
    return null;
  }
}

/** A stable read of one regular file, including its exact bytes and revision. */
export function captureFileRevision(filePath: string): FileRevision | null {
  const path = safePath(filePath);
  if (!path) return null;
  let fd: number | undefined;
  try {
    const namedBefore = lstatSync(path, { bigint: true });
    if (!namedBefore.isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    const snapshot: FileRevision = { ...before, bytes };
    if (
      !after.isFile() ||
      !namedAfter.isFile() ||
      before.size !== BigInt(bytes.length) ||
      !sameRevision(snapshot, { ...after, bytes }) ||
      !sameRevision(snapshot, { ...namedBefore, bytes }) ||
      !sameRevision(snapshot, { ...namedAfter, bytes })
    ) {
      return null;
    }
    return {
      bytes,
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function fileRevisionMatches(filePath: string, expected: FileRevision): boolean {
  const actual = captureFileRevision(filePath);
  return actual !== null && sameRevision(actual, expected);
}

function capturePrivateDirectory(path: string): PrivateDirectoryRevision | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    // Windows mode bits do not describe its ACL. The caller-owned parent's
    // inherited ACL defines authorized principals there; random private names
    // separate these operations from cooperating publishers on every platform.
    if (
      !/^\.harnery-delete-[A-Za-z0-9]{6}$/.test(basename(path)) ||
      !stat.isDirectory() ||
      (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n) ||
      !sameCanonicalPath(realpathSync(path), path)
    ) {
      return null;
    }
    return { path, dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
  } catch {
    return null;
  }
}

function privateDirectoryMatches(expected: PrivateDirectoryRevision): boolean {
  const actual = capturePrivateDirectory(expected.path);
  return (
    actual !== null &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.birthtimeNs === expected.birthtimeNs
  );
}

function writeIntent(
  directory: PrivateDirectoryRevision,
  intent: PinIntent,
  create: boolean,
): void {
  if (!privateDirectoryMatches(directory)) throw new Error("unsafe_file_deletion_directory");
  const target = join(directory.path, create ? MANIFEST : "intent.next");
  const fd = openSync(
    target,
    constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(intent));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!create) renameSync(target, join(directory.path, MANIFEST));
}

function removeEmptyPrivateDirectory(directory: PrivateDirectoryRevision): void {
  if (!privateDirectoryMatches(directory)) throw new Error("unsafe_file_deletion_directory");
  unlinkSync(join(directory.path, MANIFEST));
  rmdirSync(directory.path);
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * Restore by a no-clobber hard link. A newer publication always wins its name;
 * an unresolved pin stays available as evidence and for restart recovery.
 */
function restore(directory: PrivateDirectoryRevision, source: string): FileRecoveryResult {
  const pin = join(directory.path, PIN);
  const result = { recoveryPath: pin, sourcePath: source };
  try {
    if (!privateDirectoryMatches(directory) || !safePath(source)) {
      return { ...result, state: "retained", error: "unsafe_file_deletion_path" };
    }
    const pinned = captureFileRevision(pin);
    if (!pinned) return { ...result, state: "retained", error: "unsafe_file_deletion_pin" };
    try {
      linkSync(pin, source);
    } catch (error) {
      // A previous recovery may have linked successfully before it was killed.
      const current = captureFileRevision(source);
      if (errorCode(error) !== "EEXIST" || !current || !sameRevision(current, pinned)) {
        return { ...result, state: "retained", error: errorMessage(error) };
      }
    }
    if (!privateDirectoryMatches(directory)) {
      return { ...result, state: "retained", error: "unsafe_file_deletion_directory" };
    }
    unlinkSync(pin);
    removeEmptyPrivateDirectory(directory);
    return { ...result, state: "restored" };
  } catch (error) {
    return { ...result, state: "error", error: errorMessage(error) };
  }
}

/**
 * Writers must publish by atomic rename, never by an open descriptor to the old
 * inode. The private directory is outside their publication namespace. Moving
 * the row gives deletion custody over that inode without owning its live name.
 * The caller owns the state parent and keeps its topology stable. Its platform
 * permissions define which principals can modify it; this protocol does not
 * exclude principals already authorized to change that parent.
 */
export function deleteFileIfUnchanged(
  filePath: string,
  expected: FileRevision,
  validate: (pinned: FileRevision) => boolean,
): DeleteFileResult {
  const path = safePath(filePath);
  if (
    !path ||
    path.split(/[\\/]/).some((part) => part.startsWith(PRIVATE_PREFIX)) ||
    typeof validate !== "function"
  ) {
    return { state: "rejected" };
  }
  const observed = { ...expected, bytes: Buffer.from(expected.bytes) };
  const before = captureFileRevision(path);
  if (!before) {
    try {
      return { state: present(path) ? "rejected" : "missing" };
    } catch (error) {
      return { state: "error", error: errorMessage(error) };
    }
  }
  if (!sameRevision(before, observed)) return { state: "changed" };

  let directory: PrivateDirectoryRevision | undefined;
  let moved = false;
  let intent: PinIntent | undefined;
  const retain = (state: "changed" | "rejected" | "error", error?: unknown): DeleteFileResult => {
    if (!directory || !intent) return { state: "error", error: errorMessage(error) };
    try {
      writeIntent(directory, { ...intent, state: "retained" }, false);
    } catch {
      // The still-active manifest remains recoverable when its process exits.
    }
    const recovered = restore(directory, path);
    if (recovered.state !== "restored") {
      return {
        state: "recovery-required",
        recoveryPath: recovered.recoveryPath,
        error: error === undefined ? recovered.error : errorMessage(error),
      };
    }
    return state === "error" ? { state, error: errorMessage(error) } : { state };
  };
  try {
    const privatePath = mkdtempSync(join(dirname(path), PRIVATE_PREFIX));
    directory = capturePrivateDirectory(privatePath) ?? undefined;
    if (!directory) throw new Error("unsafe_file_deletion_directory");
    intent = {
      version: 1,
      source: basename(path),
      ownerPid: process.pid,
      ownerHost: hostname(),
      ownerPlatform: process.platform,
      ownerProcessNamespace: processNamespace(),
      state: "active",
    };
    writeIntent(directory, intent, true);
    const pin = join(directory.path, PIN);
    renameSync(path, pin);
    moved = true;
    const pinned = captureFileRevision(pin);
    // rename may update ctime; the pre-move check included the observed ctime.
    if (!pinned || !sameRevision(pinned, observed, false)) return retain("changed");
    if (!validate({ ...pinned, bytes: Buffer.from(pinned.bytes) })) return retain("rejected");
    if (!privateDirectoryMatches(directory) || !fileRevisionMatches(pin, pinned) || present(path)) {
      return retain("changed");
    }
    unlinkSync(pin);
    moved = false;
    removeEmptyPrivateDirectory(directory);
    // A publication at the unlink boundary belongs to the writer, even though
    // the obsolete private inode was successfully removed.
    return { state: present(path) ? "changed" : "deleted" };
  } catch (error) {
    if (moved) return retain("error", error);
    if (directory && privateDirectoryMatches(directory)) {
      try {
        removeEmptyPrivateDirectory(directory);
      } catch {
        // Keep any unknown private contents rather than remove them recursively.
      }
    }
    return errorCode(error) === "ENOENT"
      ? { state: "missing" }
      : { state: "error", error: errorMessage(error) };
  }
}

/**
 * Recover same-host/platform/PID-namespace pins after process termination. File fsync
 * protects manifest contents; directory entries are not fsynced, so this does
 * not promise recovery after an OS crash or power loss.
 */
export function recoverInterruptedFileDeletions(
  directoryPath: string,
  validate: (sourcePath: string) => boolean,
): FileRecoveryResult[] {
  const directory = resolve(directoryPath);
  if (typeof validate !== "function") return [];
  try {
    if (!sameCanonicalPath(realpathSync(directory), directory)) return [];
    const results: FileRecoveryResult[] = [];
    for (const entry of readdirSync(directory).sort()) {
      const privatePath = join(directory, entry);
      const privateRevision = capturePrivateDirectory(privatePath);
      if (!privateRevision) continue;
      const unknownPin = (): FileRecoveryResult => ({
        state: "error",
        recoveryPath: join(privatePath, PIN),
        error: "file_deletion_manifest_invalid",
      });
      const manifest = captureFileRevision(join(privatePath, MANIFEST));
      if (!manifest) {
        if (present(join(privatePath, PIN))) results.push(unknownPin());
        continue;
      }
      let intent: PinIntent;
      try {
        intent = JSON.parse(manifest.bytes.toString("utf8"));
      } catch {
        if (present(join(privatePath, PIN))) results.push(unknownPin());
        continue;
      }
      if (
        intent?.version !== 1 ||
        typeof intent.source !== "string" ||
        intent.source.length === 0 ||
        intent.source !== basename(intent.source) ||
        intent.source === "." ||
        intent.source === ".." ||
        intent.source.startsWith(PRIVATE_PREFIX) ||
        !Number.isSafeInteger(intent.ownerPid) ||
        intent.ownerPid <= 0 ||
        (intent.state !== "active" && intent.state !== "retained")
      ) {
        if (present(join(privatePath, PIN))) results.push(unknownPin());
        continue;
      }
      const source = join(directory, intent.source);
      const retained: FileRecoveryResult = {
        state: "retained",
        recoveryPath: join(privatePath, PIN),
        sourcePath: source,
      };
      if (
        typeof intent.ownerHost !== "string" ||
        !intent.ownerHost ||
        typeof intent.ownerPlatform !== "string" ||
        !intent.ownerPlatform ||
        typeof intent.ownerProcessNamespace !== "string" ||
        !intent.ownerProcessNamespace ||
        intent.ownerProcessNamespace === "unknown" ||
        processNamespace() === "unknown"
      ) {
        results.push({ ...retained, error: "file_deletion_owner_unknown" });
        continue;
      }
      if (
        intent.ownerHost !== hostname() ||
        intent.ownerPlatform !== process.platform ||
        intent.ownerProcessNamespace !== processNamespace()
      ) {
        results.push({ ...retained, error: "file_deletion_owner_foreign" });
        continue;
      }
      if (intent.state === "active") {
        try {
          process.kill(intent.ownerPid, 0);
          results.push({ ...retained, error: "file_deletion_owner_alive" });
          continue;
        } catch (error) {
          if (errorCode(error) !== "ESRCH") {
            results.push({ ...retained, error: "file_deletion_owner_unknown" });
            continue;
          }
        }
      }
      if (!validate(source)) {
        results.push({ ...retained, error: "file_deletion_recovery_rejected" });
        continue;
      }
      if (!present(join(privatePath, PIN))) {
        removeEmptyPrivateDirectory(privateRevision);
        continue;
      }
      results.push(restore(privateRevision, source));
    }
    return results;
  } catch (error) {
    return [{ state: "error", recoveryPath: directory, error: errorMessage(error) }];
  }
}
