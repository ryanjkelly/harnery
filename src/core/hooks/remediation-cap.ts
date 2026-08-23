/**
 * Per-session cap on consecutive blocked Stop remediations.
 *
 * The Stop verdict re-blocks until the ledger shows the end-of-turn evidence,
 * which assumes the agent CAN produce it. A session whose evidence can never
 * land (e.g. a headless child whose status command resolves to a different
 * owner) bounces forever: every retry replays the stop cycle until the budget
 * or the operator kills it. This counter is the backstop: once a single stop
 * cycle has been blocked `cap` times in a row, the verdict is allowed through
 * so the session can terminate.
 *
 * A "stop cycle" is delimited by the adapter's continuation flag (Claude
 * Code's `stop_hook_active`): a stop without the flag starts a fresh cycle and
 * resets the count. Adapters that never set the flag (Cursor) reset on every
 * stop, so the cap never engages there and behavior is unchanged.
 *
 * State is a tmpdir counter file keyed by session id — deliberately outside
 * the ledger, because remediation stops do not land fresh `turn.completed`
 * events (the turn span is already closed), so ledger evidence cannot count
 * them.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

export const DEFAULT_STOP_REMEDIATION_CAP = 5;

function counterPath(sessionId: string): string {
  const key = (sessionId || "default").replace(/[^A-Za-z0-9_-]/g, "_");
  return join(os.tmpdir(), `harnery-stop-remediation-${key}.count`);
}

/**
 * Record one blocked stop and report whether the cap is exhausted.
 *
 * Call only when the Stop verdict blocked. `continuation` is the adapter's
 * "this stop follows a stop-hook block" flag; false starts a fresh cycle.
 * Returns true when this cycle has already been blocked `cap` times, meaning
 * the caller should allow the stop instead of blocking again.
 */
export function remediationCapExceeded(
  sessionId: string,
  continuation: boolean,
  cap = DEFAULT_STOP_REMEDIATION_CAP,
): boolean {
  const path = counterPath(sessionId);
  let count = 1;
  if (continuation) {
    let prior = 0;
    try {
      prior = Number.parseInt(readFileSync(path, "utf8"), 10);
    } catch {
      // No counter yet (cycle started before the counter existed): treat the
      // continuation itself as evidence of one earlier blocked stop, so an
      // already-running loop still converges on the cap.
      prior = 1;
    }
    count = Number.isFinite(prior) && prior >= 0 ? prior + 1 : 1;
  }
  try {
    writeFileSync(path, String(count), "utf8");
  } catch {
    // Counter IO must never turn into a block or a crash; fail open (no cap).
    return false;
  }
  return count > cap;
}

/** Clear the cycle counter after an allowed stop. */
export function clearRemediationCount(sessionId: string): void {
  try {
    rmSync(counterPath(sessionId), { force: true });
  } catch {
    // best-effort
  }
}
