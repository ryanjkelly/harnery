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
 * compared with itself. A platform that will not answer returns null, meaning
 * "unverifiable" — callers fall back to a plain liveness check, which is where
 * they were before this existed.
 *
 * Two rules keep comparison honest, and both exist because getting them wrong
 * reports a *false* mismatch, which prunes a live row and hands the identity
 * walk the same wrong answer this module was written to stop:
 *
 * 1. One machine uses one probe. The probe is chosen by capability and locked
 *    in, never fallen back from, so a transient read failure cannot answer in
 *    the other probe's dialect and read as a recycled pid.
 * 2. A probe's output must not depend on who asked. The `ps` text is formatted
 *    through the caller's locale and timezone, so both are pinned; without that,
 *    two callers reading the same live process disagree.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { coordEnv } from "../../../lib/env.ts";

/** Which probe answers "when did this process start?" on this machine. */
export type StartTokenProbe = "procfs" | "ps";

/**
 * The `ps` probe is text formatted by `strftime("%c", localtime(...))`, so its
 * output moves with `TZ` and `LC_TIME`. A hook running under `LC_ALL=C` (git
 * sets it routinely) and a shell running under the user's locale would render
 * the same start instant two different ways and call each other liars. Pinning
 * both makes the rendering a property of the process, not of its reader.
 */
const PS_ENV_PINS = { TZ: "UTC", LC_ALL: "C" } as const;

let cachedProbe: StartTokenProbe | undefined;
let cachedBootId: string | null | undefined;

/**
 * Which probe this machine uses, decided once.
 *
 * `HARNERY_PID_PROBE` forces the choice. That exists so the `ps` path can be
 * exercised on a procfs machine — it is the same code on either OS, and running
 * it only on hardware we happen to own is how a branch rots.
 */
export function startTokenProbe(): StartTokenProbe {
  const override = coordEnv("PID_PROBE");
  if (override === "procfs" || override === "ps") return override;
  if (cachedProbe === undefined) {
    cachedProbe = existsSync("/proc/self/stat") ? "procfs" : "ps";
  }
  return cachedProbe;
}

/**
 * A short, stable identifier for the current boot, or null where there is none.
 *
 * Linux counts a process's start in ticks *since boot*, so the number alone
 * repeats every time the machine restarts. Pid-map rows live in the working
 * tree and outlive reboots, which is the whole exposure: a stale row for pid
 * 1234 at 45.23s after boot matches a fresh process that happens to land on the
 * same pid at the same moment of the next boot, and that false match is exactly
 * the bug the token exists to prevent. Scoping the count to its boot removes
 * the coincidence. BSD needs no equivalent, since its token is an absolute
 * date.
 */
function bootId(): string | null {
  if (cachedBootId !== undefined) return cachedBootId;
  try {
    const raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().replace(/-/g, "");
    cachedBootId = /^[0-9a-f]{8,}$/.test(raw) ? raw.slice(0, 8) : null;
  } catch {
    cachedBootId = null;
  }
  return cachedBootId;
}

/** Forget the cached probe and boot id. Tests only. */
export function resetStartTokenCaches(): void {
  cachedProbe = undefined;
  cachedBootId = undefined;
}

/**
 * `l[<boot>.]<ticks since boot>` from `/proc/<pid>/stat`, with no subprocess.
 *
 * The tick count is field 22, counted from the end of the comm field rather
 * than by splitting the whole line, because comm is the executable name in
 * parentheses and may itself contain spaces and parens. The boot segment is
 * dropped rather than faked when the kernel will not name its boot, which
 * yields the pre-boot-id shape that `tokensAgree` still accepts.
 */
export function procfsStartToken(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null; // dead pid, or no procfs — either way, nothing to say
  }
  const afterComm = stat.slice(stat.lastIndexOf(") ") + 2);
  // Fields after comm, 0-based: 0 is state (field 3), so starttime (field 22)
  // sits at 19.
  const ticks = afterComm.split(" ")[19];
  if (!ticks || !/^\d+$/.test(ticks)) return null;
  const boot = bootId();
  return boot ? `l${boot}.${ticks}` : `l${ticks}`;
}

/**
 * `p<start date>` from one `ps -o lstart=`, for machines without procfs.
 *
 * Second resolution is ample: telling two runs of one pid apart would need the
 * entire pid space to recycle inside a second. The runner is injectable so the
 * parsing and the env pinning can be tested without a process to look at.
 */
export function psStartToken(
  pid: number,
  run: (pid: number) => { status: number | null; stdout: string } = defaultPsRun,
): string | null {
  let out: { status: number | null; stdout: string };
  try {
    out = run(pid);
  } catch {
    return null; // no ps on this machine
  }
  if (out.status !== 0) return null;
  const lstart = (out.stdout ?? "").split("\n")[0]?.trim().replace(/\s+/g, " ");
  return lstart ? `p${lstart}` : null;
}

function defaultPsRun(pid: number): { status: number | null; stdout: string } {
  const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2000,
    env: { ...process.env, ...PS_ENV_PINS },
  });
  return { status: out.status, stdout: out.stdout ?? "" };
}

/**
 * An opaque token identifying *this run* of `pid`, or null when the platform
 * will not say.
 */
export function processStartToken(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return startTokenProbe() === "procfs" ? procfsStartToken(pid) : psStartToken(pid);
}

/**
 * Do two tokens describe the same run?
 *
 * Equality, plus one concession: a row written before tokens carried a boot
 * segment recorded the tick count alone, so it is compared on the part it
 * actually recorded. Refusing that would call every pre-upgrade row a recycled
 * pid and prune a working machine's live rows the first time the new code ran.
 * Such a row loses its reboot protection until the next write rewrites it,
 * which is a strictly better position than the one it came from.
 */
export function tokensAgree(recorded: string, current: string): boolean {
  if (recorded === current) return true;
  // Only the Linux form has a boot segment to disagree about, and only when
  // exactly one side carries one is this a shape difference rather than two
  // genuinely different start instants.
  if (recorded[0] !== "l" || current[0] !== "l") return false;
  if (recorded.includes(".") === current.includes(".")) return false;
  return ticksOf(recorded) === ticksOf(current);
}

function ticksOf(token: string): string {
  const dot = token.indexOf(".");
  return dot === -1 ? token.slice(1) : token.slice(dot + 1);
}

/**
 * Does `pid` still name the process a row recorded?
 *
 * Three answers, and the difference between the last two matters:
 *
 * - `"match"` — recorded token, current token, same run. The row is trustworthy.
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
  return tokensAgree(recorded, current) ? "match" : "mismatch";
}
