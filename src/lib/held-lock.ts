/**
 * The shared rule for directory locks taken with an atomic `mkdir`: which
 * `mkdir` errors mean another process holds the lock, so the caller should
 * wait or report busy instead of failing.
 *
 * Dependency-free on purpose: toolkit and coordination code both use it.
 */
import { mkdirSync } from "node:fs";

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
