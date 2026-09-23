/**
 * The permission modes for everything Harnery writes as project state under `.harnery/`.
 *
 * `private` (the default) is owner-only: 0700 directories and 0600 files, exactly as before this
 * module existed. `group` is for a project several Unix users share through one group, such as a
 * workspace that several people's agents work in at once: 2770 (setgid) and 0660, with nothing ever granted
 * to other users. Every state write takes its mode from here, and every integrity check that
 * rejects a loosely permissioned file asks `stateModeTooOpen`, so the two cannot disagree.
 *
 * Personal state outside the project (browser cookies, sessions, pacing ledgers in the user's home)
 * is not project state and stays owner-only regardless.
 */
import { storageSharing } from "../config.ts";

let resolved: "private" | "group" | undefined;

/** The sharing mode for this process, resolved once. Tests reset it with `resetStorageSharing`. */
export function stateSharing(): "private" | "group" {
  if (resolved === undefined) {
    resolved = storageSharing();
    // A umask that strips group bits would quietly turn every group file back into an owner-only
    // one, and the next user's write would fail. Keep the process's other-bits mask as it was.
    if (resolved === "group" && typeof process.umask === "function")
      process.umask(process.umask() & ~0o070);
  }
  return resolved;
}

export function resetStorageSharing(): void {
  resolved = undefined;
}

/**
 * Mode for a directory of project state. Group mode includes setgid: Harnery chmods directories
 * after creating them, and a plain 0770 would clear the bit, so files made inside would take the
 * writer's own group instead of the project's, and other users could not read them.
 */
export function stateDirMode(): number {
  return stateSharing() === "group" ? 0o2770 : 0o700;
}

/** Mode for a file of project state. */
export function stateFileMode(): number {
  return stateSharing() === "group" ? 0o660 : 0o600;
}

/**
 * True when a state file or directory is readable or writable by someone it should not be: anyone
 * but the owner in private mode, anyone outside the owner and group in group mode.
 */
export function stateModeTooOpen(mode: number): boolean {
  return (mode & (stateSharing() === "group" ? 0o007 : 0o077)) !== 0;
}
