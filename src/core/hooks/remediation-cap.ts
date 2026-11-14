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
 * Returns the retained block count and whether this cycle has already been
 * blocked `cap` times, meaning the caller should allow the stop instead of
 * blocking again.
 */
export interface RemediationBlockRecord {
  count: number;
  exceeded: boolean;
}

export function recordRemediationBlock(
  sessionId: string,
  continuation: boolean,
  cap = DEFAULT_STOP_REMEDIATION_CAP,
): RemediationBlockRecord {
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
    return { count, exceeded: false };
  }
  return { count, exceeded: count > cap };
}

/** Clear the cycle counter after an allowed stop. */
export function clearRemediationCount(sessionId: string): void {
  try {
    rmSync(counterPath(sessionId), { force: true });
  } catch {
    // best-effort
  }
}

/**
 * Cap exhaustion must not be silent. The stop is still allowed, but the
 * session keeps a pending cue so its next prompt tells the agent which rule
 * went unmet, and the human gets a visible notice where the adapter has one.
 */
export interface StopCapExhaustion {
  rule: string;
  reason?: string;
  blocked_count: number;
  at: string;
}

function cuePath(sessionId: string): string {
  const key = (sessionId || "default").replace(/[^A-Za-z0-9_-]/g, "_");
  return join(os.tmpdir(), `harnery-stop-cap-cue-${key}.json`);
}

/** Remember one exhaustion so the session's next prompt can carry a cue. */
export function recordStopCapExhaustion(sessionId: string, exhaustion: StopCapExhaustion): void {
  try {
    writeFileSync(cuePath(sessionId), JSON.stringify(exhaustion), "utf8");
  } catch {
    // best-effort: the debug row still counts the exhaustion in health.
  }
}

/** Read and clear a pending exhaustion for this session, if any. */
export function takeStopCapExhaustion(sessionId: string): StopCapExhaustion | null {
  const path = cuePath(sessionId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StopCapExhaustion> | null;
    if (!parsed || typeof parsed.rule !== "string") return null;
    return {
      rule: parsed.rule,
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
      blocked_count: typeof parsed.blocked_count === "number" ? parsed.blocked_count : 0,
      at: typeof parsed.at === "string" ? parsed.at : "",
    };
  } catch {
    return null;
  }
}

function firstLine(text: string | undefined): string {
  return (
    (text ?? "")
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

/** One plain notice for the human when the cap lets a turn end. */
export function formatStopCapNotice(exhaustion: StopCapExhaustion): string {
  return (
    `Harnery let this turn end after ${exhaustion.blocked_count} blocked attempts, ` +
    `so the work may be unfinished: the end-of-turn rule ${exhaustion.rule} was not met. ` +
    "The agent will be asked to fix it on your next message."
  );
}

/** The prompt-time cue that tells the agent to repair and report the gap. */
export function formatStopCapCue(exhaustion: StopCapExhaustion, statusCommand: string): string {
  const reason = firstLine(exhaustion.reason);
  return [
    `Your previous turn ended unfinished: the Stop hook blocked it ${exhaustion.blocked_count} times for rule ${exhaustion.rule} and then let it end.`,
    ...(reason ? [`What was unmet: ${reason}`] : []),
    `Fix that first in this turn, finish with \`${statusCommand}\`, and tell the operator in one plain sentence what was left unfinished and whether it is now fixed.`,
  ].join("\n");
}
