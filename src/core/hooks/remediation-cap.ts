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

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_STOP_REMEDIATION_CAP = 5;
export const STOP_CAP_CUE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

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

function cuePath(coordRoot: string, sessionId: string): string {
  // Match context continuity's hashed session keys and keep ephemeral hook
  // state beneath active/, alongside hook-runs/.
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return join(coordRoot, ".harnery", "active", "stop-cap-cues", `${key}.json`);
}

/** Remember one exhaustion so the session's next prompt can carry a cue. */
export function recordStopCapExhaustion(
  coordRoot: string,
  sessionId: string,
  exhaustion: StopCapExhaustion,
  nowMs = Date.now(),
): void {
  try {
    const path = cuePath(coordRoot, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    pruneStopCapCues(dirname(path), nowMs);
    writeFileSync(path, JSON.stringify(exhaustion), "utf8");
  } catch {
    // best-effort: the debug row still counts the exhaustion in health.
  }
}

/** Read and consume a fresh cue. A failed removal must not deliver it twice. */
export function takeStopCapExhaustion(
  coordRoot: string,
  sessionId: string,
  nowMs = Date.now(),
): StopCapExhaustion | null {
  let raw: string;
  try {
    const path = cuePath(coordRoot, sessionId);
    raw = readFileSync(path, "utf8");
    unlinkSync(path);
  } catch {
    return null;
  }
  return parseStopCapCue(raw, nowMs);
}

/** Session end discards a cue that will no longer have a next prompt. */
export function clearStopCapExhaustion(coordRoot: string, sessionId: string): void {
  try {
    rmSync(cuePath(coordRoot, sessionId), { force: true });
  } catch {
    // best-effort
  }
}

function parseStopCapCue(raw: string, nowMs: number): StopCapExhaustion | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StopCapExhaustion> | null;
    if (
      !parsed ||
      typeof parsed.rule !== "string" ||
      !parsed.rule.trim() ||
      typeof parsed.at !== "string" ||
      typeof parsed.blocked_count !== "number" ||
      !Number.isInteger(parsed.blocked_count) ||
      parsed.blocked_count < 0
    ) {
      return null;
    }
    const at = Date.parse(parsed.at);
    if (!Number.isFinite(at) || at > nowMs || nowMs - at >= STOP_CAP_CUE_RETENTION_MS) return null;
    return {
      rule: parsed.rule,
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
      blocked_count: parsed.blocked_count,
      at: parsed.at,
    };
  } catch {
    return null;
  }
}

function pruneStopCapCues(dir: string, nowMs: number): void {
  // Sessions that never resume still lose their expired cues on later writes.
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const path = join(dir, name);
      if (!parseStopCapCue(readFileSync(path, "utf8"), nowMs)) rmSync(path, { force: true });
    } catch {
      // One unreadable cue must not prevent another session's write.
    }
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
    `so the work may be unfinished: ${plainStopRule(exhaustion.rule)}. ` +
    "The agent will be asked to fix it on your next message."
  );
}

/** What a blocked Stop rule means, for text a person reads (no rule ids). */
export function plainStopRule(rule: string): string {
  switch (rule) {
    case "stop-hook.rule_1_3":
      return "the agent did not finish with its end-of-turn status check";
    case "stop-hook.rule_2_3":
      return "the agent's reply did not show its end-of-turn status";
    case "stop-hook.rule_3_3":
      return "the agent did not declare what it was working on";
    case "stop-hook.session_name":
      return "the agent did not show its session name";
    case "stop-hook.git_not_finalized":
      return "the agent's Git work was not committed and pushed";
    default:
      return "an end-of-turn step was not completed";
  }
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

/**
 * A session that has never declared a task is refused once (ADR 0266): the
 * refusal exists so the session gets a name, and repeating it every turn only
 * costs retries. The marker lives beside the cap cues, keyed by a hash of the
 * session id.
 */
function noTaskRefusalPath(coordRoot: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return join(coordRoot, ".harnery", "active", "stop-no-task-refused", key);
}

/** True when this session already received its one no-task refusal. */
export function hasNoTaskRefusal(coordRoot: string, sessionId: string): boolean {
  try {
    readFileSync(noTaskRefusalPath(coordRoot, sessionId), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Remember that this session received its no-task refusal. Best-effort. */
export function markNoTaskRefusal(coordRoot: string, sessionId: string, nowMs = Date.now()): void {
  try {
    const path = noTaskRefusalPath(coordRoot, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    pruneNoTaskRefusals(dirname(path), nowMs);
    writeFileSync(path, new Date(nowMs).toISOString(), "utf8");
  } catch {
    // A missing marker only means one more refusal later; never a crash.
  }
}

function pruneNoTaskRefusals(dir: string, nowMs: number): void {
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        const at = Date.parse(readFileSync(path, "utf8"));
        if (!Number.isFinite(at) || nowMs - at > STOP_CAP_CUE_RETENTION_MS) unlinkSync(path);
      } catch {
        // skip unreadable entries
      }
    }
  } catch {
    // best-effort
  }
}
