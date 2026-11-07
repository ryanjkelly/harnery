/**
 * Whether a process with this id exists, probed with signal 0.
 *
 * EPERM means the process exists but belongs to another user, so it counts
 * as alive. Any id that is not a positive integer is never alive: on POSIX,
 * `kill(0, 0)` probes the caller's own process group and `kill(-n, 0)` a
 * whole group, so passing them through would report a missing id as live.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
