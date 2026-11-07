/**
 * Whether a process with this id exists, probed with signal 0. Two answers
 * for the one ambiguous case, an error other than ESRCH or EPERM:
 *
 * - `processAlive` counts it as gone. Use it for status and display, where a
 *   wrong "alive" is the worse mistake.
 * - `processMayBeAlive` counts it as alive. Use it before taking over a lock,
 *   lease or slot, where stealing from a live owner is the worse mistake.
 *
 * Both count EPERM (the process exists but belongs to another user) as
 * alive, and both treat any id that is not a positive integer as gone: on
 * POSIX, `kill(0, 0)` probes the caller's own process group and `kill(-n, 0)`
 * a whole group, so passing them through would report a missing id as live
 * and could pin a lock forever.
 */
export function processAlive(pid: number): boolean {
  return probe(pid, false);
}

/** Like `processAlive`, but an unexpected probe error counts as alive. */
export function processMayBeAlive(pid: number): boolean {
  return probe(pid, true);
}

function probe(pid: number, unknownMeansAlive: boolean): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return unknownMeansAlive;
  }
}
