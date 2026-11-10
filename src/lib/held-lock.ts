/**
 * The shared rules for locks taken with an atomic create: which errors from a
 * lock folder `mkdir`, or from an exclusive lock file create, mean another
 * process holds the lock, so the caller should wait or report busy instead of
 * failing.
 *
 * Dependency-free on purpose: toolkit and coordination code both use it.
 */
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";

/** True when a lock `mkdir` error means another writer holds (or is
 * releasing) the lock, so the caller should wait rather than fail. */
export function isHeldLockError(
  code: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (code === "EEXIST") return true;
  // Windows returns EPERM for mkdir while another process is deleting the lock folder.
  return code === "EPERM" && platform === "win32";
}

/** The `mkdir` call and platform a lock uses. Tests substitute both to
 * exercise the Windows branch on any host. */
export interface LockDirSeam {
  mkdir: (path: string) => void;
  platform: NodeJS.Platform;
}

export const realLockDirSeam: LockDirSeam = {
  mkdir: (path) => {
    mkdirSync(path);
  },
  platform: process.platform,
};

/** True when `error`, thrown by the seam's `mkdir`, means the lock is held. */
export function isHeldLockFailure(error: unknown, seam: LockDirSeam = realLockDirSeam): boolean {
  return isHeldLockError((error as NodeJS.ErrnoException | undefined)?.code, seam.platform);
}

/** True when an exclusive lock file create error (`open` with flag `wx`)
 * means another writer holds (or is releasing) the lock file. */
export function isHeldFileLockError(
  code: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (code === "EEXIST") return true;
  // Windows returns EPERM for an exclusive create while another process is deleting the lock
  // file: a 6-process race probe on NTFS (Bun 1.4.4) saw 1,717 EPERM in 200,004 open "wx"
  // creates and 1,256 in 200,004 writeFile "wx" creates, and no EACCES, EBUSY or ENOENT.
  return code === "EPERM" && platform === "win32";
}

/** The exclusive file create and platform a lock file uses. Tests substitute
 * both to exercise the Windows branch on any host. */
export interface LockFileSeam {
  /** Creates `path` holding `contents`; throws when it cannot (EEXIST when it exists). */
  createExclusive: (path: string, contents: string, mode?: number) => void;
  platform: NodeJS.Platform;
}

export const realLockFileSeam: LockFileSeam = {
  createExclusive: (path, contents, mode) => {
    const fd = openSync(path, "wx", mode);
    try {
      writeFileSync(fd, contents);
    } catch (error) {
      closeSync(fd);
      try {
        unlinkSync(path);
      } catch {
        // Preserve the write error.
      }
      throw error;
    }
    closeSync(fd);
  },
  platform: process.platform,
};

/** True when `error`, thrown by the seam's `createExclusive`, means the lock file is held. */
export function isHeldFileLockFailure(
  error: unknown,
  seam: LockFileSeam = realLockFileSeam,
): boolean {
  return isHeldFileLockError((error as NodeJS.ErrnoException | undefined)?.code, seam.platform);
}
