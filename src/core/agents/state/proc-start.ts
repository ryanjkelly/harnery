/**
 * Process start-token probe: the "is this still the same process?" half of pid
 * identity.
 *
 * A pid alone does not identify a process. Operating systems hand numbers back
 * out, and faster than intuition suggests: one development machine runs a
 * `pid_max` of 99999 against roughly 100 new processes a second, turning the
 * whole space over about every quarter hour. Anything that remembers a pid for
 * longer than that is remembering a number, not a process.
 *
 * A start token pins the pair down. Two processes can share a pid but never a
 * pid *and* a start instant, so a recorded `(pid, token)` either still names the
 * process that was recorded or plainly does not.
 *
 * The token is opaque on purpose. Callers compare it for equality and nothing
 * else, which is why no clock arithmetic appears here: Linux reports ticks since
 * boot and BSD reports a formatted date, and neither needs converting to be
 * compared with itself. An unrecognised platform returns null, meaning
 * "unverifiable" — callers fall back to a plain liveness check, which is where
 * they were before this existed.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * An opaque token identifying *this run* of `pid`, or null when the platform
 * will not say.
 *
 * Linux/WSL reads field 22 of `/proc/<pid>/stat` (start time in clock ticks
 * since boot) with no subprocess at all. The field is counted from the end of
 * the comm field rather than by splitting the whole line, because comm is the
 * executable name in parentheses and may itself contain spaces and parens.
 *
 * BSD/macOS has no `/proc`, so it pays one `ps -o lstart=`. Second resolution is
 * ample: distinguishing two runs of one pid would need the entire pid space to
 * recycle inside a second.
 */
export function processStartToken(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(") ") + 2);
    // Fields after comm, 0-based: 0 is state (field 3), so starttime (field 22)
    // sits at 19.
    const starttime = afterComm.split(" ")[19];
    if (starttime && /^\d+$/.test(starttime)) return `l${starttime}`;
    return null;
  } catch {
    /* no /proc — fall through to ps */
  }

  try {
    const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (out.status !== 0) return null;
    const lstart = out.stdout.trim();
    if (!lstart) return null;
    return `p${lstart.replace(/\s+/g, " ")}`;
  } catch {
    return null;
  }
}

/**
 * Does `pid` still name the process a row recorded?
 *
 * Three answers, and the difference between the last two matters:
 *
 * - `"match"` — recorded token, current token, same. The row is trustworthy.
 * - `"mismatch"` — both present and different. The pid was recycled. This is
 *   the case a liveness check cannot see, because a recycled pid is alive.
 * - `"unverified"` — no recorded token (a row written before tokens existed) or
 *   no current one (an unsupported platform). Callers treat this the way they
 *   treated every row previously: trust it if the pid is alive.
 */
export function checkPidToken(
  pid: number,
  recorded: string | undefined,
): "match" | "mismatch" | "unverified" {
  if (!recorded) return "unverified";
  const current = processStartToken(pid);
  if (!current) return "unverified";
  return current === recorded ? "match" : "mismatch";
}
