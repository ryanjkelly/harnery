/**
 * Harness-aware hook output JSON. Each adapter target has its own protocol
 * shape, so encode it once here so post-emit handlers don't have to branch on
 * `harness` everywhere.
 *
 * Shapes (verified against live dispatchers + each harness's upstream hooks docs):
 *
 * - **Claude Code**: `{hookSpecificOutput: {hookEventName, additionalContext}}`
 *   for SessionStart / UserPromptSubmit / SubagentStart; deny uses
 *   `{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason}}`.
 * - **Cursor**: `{additional_context, env?}` flat for sessionStart /
 *   beforeSubmitPrompt; deny uses `{permission: "deny", agent_message, user_message}`.
 * - **Codex**: structurally identical to Claude Code (confirmed by Phase 0
 *   probe + the matching shape in the Codex harness adapter).
 *
 * Every helper writes to process.stdout + newline-terminates so callers can
 * fire-and-forget. Empty text → no-op (no JSON written).
 */

import type { Harness } from "../events/schema.ts";

export type SystemEvent = "SessionStart" | "UserPromptSubmit" | "SubagentStart";

/** Emit a context-injection (peer table, wiring check, council pending, …). */
export function emitContext(harness: Harness, event: SystemEvent, text: string): void {
  if (!text || text.length === 0) return;
  const json = buildContextJson(harness, event, text);
  process.stdout.write(`${JSON.stringify(json)}\n`);
}

/** Emit a PreToolUse deny: blocks the tool call with `reason` shown to the model. */
export function emitDeny(harness: Harness, reason: string): void {
  if (!reason) return;
  const json = buildDenyJson(harness, reason);
  process.stdout.write(`${JSON.stringify(json)}\n`);
}

/**
 * Emit a Stop-hook block in the firing harness's enforcement channel and return
 * the process exit code the caller should use.
 *
 * The verdict (allow/block + reason) is computed harness-agnostically in
 * agents/rules/stop-hook.ts; this function only shapes *how the block is
 * communicated back*, because each harness has a different mechanism:
 *
 * - **Claude Code / Codex** honor `exit 2` + a stderr reason as a turn block,
 *   and the harness re-prompts the model with the stderr text.
 * - **Cursor** ignores stop-hook exit codes (non-zero = fail-open, the turn
 *   proceeds) and re-prompts ONLY via a `followup_message` field in stdout
 *   JSON, which it auto-submits as the next user message: the sanctioned
 *   "iterate until a goal is met" channel, capped by `loop_limit` (default 5).
 *   We exit 0 so Cursor treats the run as a success and honors the output.
 *   (Confirmed against cursor.com/docs/agent/hooks.)
 */
export function emitStopBlock(harness: Harness, verdict: { reason?: string; rule: string }): 0 | 2 {
  const message = `${
    verdict.reason ?? "End-of-turn coordination ritual incomplete."
  }\n[agent-hook stop]: rule=${verdict.rule}`;
  if (harness === "cursor") {
    process.stdout.write(`${JSON.stringify({ followup_message: message })}\n`);
    return 0;
  }
  process.stderr.write(`${message}\n`);
  return 2;
}

function buildContextJson(
  harness: Harness,
  event: SystemEvent,
  text: string,
): Record<string, unknown> {
  if (harness === "cursor") {
    // Cursor uses a flat top-level key + an env block that survives across the
    // session. The dispatcher historically also wrote
    // `env: {HARNERY_AGENT_COORD_HARNESS, HARNERY_AGENT_COORD_PLATFORM}`. These are
    // observer hints, not load-bearing; agent-hook + agent-coord recover the
    // harness from event metadata. Drop them.
    return { additional_context: text };
  }
  // Claude Code + Codex share the `hookSpecificOutput` envelope.
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: text,
    },
  };
}

function buildDenyJson(harness: Harness, reason: string): Record<string, unknown> {
  if (harness === "cursor") {
    return { permission: "deny", agent_message: reason, user_message: reason };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}
