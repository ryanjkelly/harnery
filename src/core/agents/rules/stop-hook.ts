/**
 * Stop-hook verdict: rule 1/3, 2/3, 3/3 enforcement evaluated
 * from the canonical event stream alone (no transcript scan).
 *
 * Rule 1/3: `state.status_checked` event with matching turn boundary exists.
 * Rule 2/3: latest `turn.stop` event has `status_box_present: true` (or the
 *            stop currently firing carries that field via the in-flight event
 *            agent-hook emits before the stop hook runs).
 * Rule 3/3: `state.task_set` event with matching turn boundary exists.
 *
 * Pure-prose-turn exemption: when zero `tool.pre_use` events fire in
 * the current turn, rules 1/3 and 3/3 do not apply. Rule 2/3 still applies
 * as a user-visible mobile cue.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBinName } from "../../config.ts";

export type VerdictResult = {
  allow: boolean;
  exit_code: 0 | 2;
  rule: string;
  reason?: string;
};

interface CanonicalEvent {
  event_id: string;
  event_type: string;
  ts: string;
  instance_id: string;
  session_id: string;
  turn_id?: string;
  harness: string;
  source: string;
  data: Record<string, unknown>;
}

export interface StopHookRequest {
  rule: "stop-hook";
  instance_id: string;
  session_id?: string;
  /** Firing harness. Selects the end-of-turn ack signal (see `ackSignalFor`).
   * Undefined → Claude Code semantics (transcript-scanned status box). */
  harness?: string;
  /** Wall-clock cutoff for the current turn; events strictly after this are not yet relevant. */
  now_ms?: number;
  /** Override the turn-window discovery (used by tests). */
  turn_window?: { start_ms: number; end_ms: number };
  /** Bypass switch: operator escape hatch identical to HARNERY_AGENT_COORD_BYPASS_STOP. */
  bypass?: boolean;
  /** Headless child spawned by `harn workflow` (HARNERY_WORKFLOW_CHILD=1).
   * The end-of-turn ritual exists to surface status to a HUMAN reader; a
   * workflow child reports to the engine's journal instead, so the ritual is
   * meaningless there — worse, blocking burns the child's turn budget on
   * re-prompts (observed as error_max_turns in the Phase 1 spike). Exempting
   * here, rather than disabling the child's hooks wholesale, keeps heartbeat +
   * event capture on: the child stays visible to peers and the coord layer. */
  workflow_child?: boolean;
}

/**
 * The end-of-turn "I surfaced my status" signal, detected differently per
 * harness because the ritual's *goal* (status visible to the human) is reached
 * by different means:
 *
 * - **Claude Code / Codex** collapse tool calls in the UI, so the human-visible
 *   signal is the verbatim status-box paste in the reply (rule 2/3, detected
 *   by scanning the transcript for the `┌─ agent-` prefix, `status_box_present`
 *   on `turn.stop`).
 * - **Cursor** renders Shell output inline, so simply *running* `harn agents
 *   status` (which emits `state.status_checked`) already puts the box on
 *   screen. The separate paste is redundant, and undetectable anyway, since
 *   Cursor's stop payload carries neither a transcript path nor the assistant
 *   message. So rule 1/3 *is* the ack signal on Cursor; rule 2/3 collapses into
 *   it rather than being a second requirement.
 *
 * This is why the fix is not "relax 2/3 because we can't see it": it's "2/3
 * and 1/3 are two detections of the same thing, and Cursor's inline UI makes
 * 1/3 the right one." The enforcement *channel* (exit-2+stderr vs Cursor's
 * `followup_message`) is handled separately in hooks/harness/output.ts.
 */
type AckSignal = "status_box_present" | "status_checked";

function ackSignalFor(harness?: string): AckSignal {
  return harness === "cursor" ? "status_checked" : "status_box_present";
}

const RECENT_EVENT_WINDOW_LINES = 5_000;

/**
 * Evaluate the Stop-hook verdict. Returns the first failing rule (or allow
 * when all three pass). Soft-fails open when the event stream isn't
 * readable, fail-open posture on a verdict failure.
 */
export function evaluateStopHook(coordRoot: string, req: StopHookRequest): VerdictResult {
  if (req.bypass) {
    return {
      allow: true,
      exit_code: 0,
      rule: "stop-hook.bypass",
      reason: "HARNERY_AGENT_COORD_BYPASS_STOP=1",
    };
  }

  if (req.workflow_child) {
    return {
      allow: true,
      exit_code: 0,
      rule: "stop-hook.workflow_child",
      reason: "HARNERY_WORKFLOW_CHILD=1: headless workflow child; ritual not applicable",
    };
  }

  let events: CanonicalEvent[];
  try {
    events = readRecentEvents(coordRoot, RECENT_EVENT_WINDOW_LINES);
  } catch {
    return {
      allow: true,
      exit_code: 0,
      rule: "stop-hook.fail_open",
      reason: "events.ndjson not readable; failing open",
    };
  }

  const ownerEvents = events.filter((e) => e.instance_id === req.instance_id);
  if (ownerEvents.length === 0) {
    return {
      allow: true,
      exit_code: 0,
      rule: "stop-hook.no_history",
      reason: "no canonical events for this owner; defer to legacy or skip",
    };
  }

  // Turn window: from the most recent user_prompt.submit (this owner) up to
  // either the explicit now_ms or the last event we see. Fall back to a
  // 5-minute window when no user_prompt.submit is in scope (fresh wiring,
  // out-of-window prompt, etc.) so a stale stream doesn't silently pass.
  const nowMs = req.now_ms ?? Date.now();
  const lastUserPrompt = [...ownerEvents]
    .reverse()
    .find((e) => e.event_type === "user_prompt.submit");
  const startMs = lastUserPrompt ? Date.parse(lastUserPrompt.ts) : nowMs - 5 * 60 * 1000;

  const inTurn = ownerEvents.filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= startMs && t <= nowMs;
  });

  const toolPreUseInTurn = inTurn.some((e) => e.event_type === "tool.pre_use");
  const statusChecked = inTurn.some((e) => e.event_type === "state.status_checked");
  const taskSet = inTurn.some((e) => e.event_type === "state.task_set");

  // Rule 2/3: status_box_present on the most recent turn.stop for this owner.
  // The turn.stop event fires from agent-hook stop, which is wired BEFORE
  // the stop-hook verdict, so by the time we evaluate, the just-
  // fired turn.stop is already in the stream.
  const latestTurnStop = [...inTurn].reverse().find((e) => e.event_type === "turn.stop");
  const boxPresent = latestTurnStop ? Boolean(latestTurnStop.data.status_box_present) : false;

  // Harness-aware end-of-turn ack signal (see `ackSignalFor`). On Cursor the
  // ack is `status_checked` (running `harn agents status` shows the box inline);
  // on Claude Code / Codex it's the transcript-scanned `status_box_present`.
  // The matching block helper carries the right "how to fix" message.
  const ackSignal = ackSignalFor(req.harness);
  const ackPresent = ackSignal === "status_checked" ? statusChecked : boxPresent;
  const ackBlock = ackSignal === "status_checked" ? rule13Block : rule23Block;

  // Pure-prose-turn exemption: only the ack signal applies. Parity
  // across harnesses: CC requires the box; Cursor requires status_checked.
  if (!toolPreUseInTurn) {
    if (!ackPresent) {
      return ackBlock();
    }
    return {
      allow: true,
      exit_code: 0,
      rule: "stop-hook.pure_prose_pass",
      reason: "no tool calls this turn; rules 1/3 + 3/3 skipped",
    };
  }

  if (!statusChecked) return rule13Block();
  // On Cursor `ackPresent === statusChecked` (already true here), so this is a
  // no-op and rule 2/3 is not enforced; on CC/Codex it's the box-paste check.
  if (!ackPresent) return ackBlock();
  if (!taskSet) return rule33Block();

  return {
    allow: true,
    exit_code: 0,
    rule: "stop-hook.pass",
  };
}

function rule13Block(): VerdictResult {
  return {
    allow: false,
    exit_code: 2,
    rule: "stop-hook.rule_1_3",
    reason: `End-of-turn rule (1/3): no state.status_checked event found in this turn; run \`${resolveBinName()} agents status\` as your last tool call.`,
  };
}

function rule23Block(): VerdictResult {
  return {
    allow: false,
    exit_code: 2,
    rule: "stop-hook.rule_2_3",
    reason: `End-of-turn rule (2/3): turn.stop did not see the agent-status box in your reply text. Paste the \`${resolveBinName()} agents status\` output verbatim as a fenced code block (the \`┌─ agent-\` prefix is the detection signal).`,
  };
}

function rule33Block(): VerdictResult {
  return {
    allow: false,
    exit_code: 2,
    rule: "stop-hook.rule_3_3",
    reason: `End-of-turn rule (3/3): no state.task_set event found in this turn; run \`${resolveBinName()} agents set-task "<short focus>"\` to declare what you're working on. Pass an empty string if the turn was purely conversational.`,
  };
}

/**
 * Read the last N JSON lines from events.ndjson. The Stop-hook verdict needs
 * just the most recent turn so we tail-read aggressively.
 */
function readRecentEvents(coordRoot: string, maxLines: number): CanonicalEvent[] {
  const path = join(coordRoot, ".harnery", "events.ndjson");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const start = Math.max(0, lines.length - maxLines);
  const out: CanonicalEvent[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;
    try {
      out.push(JSON.parse(line) as CanonicalEvent);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}
