/**
 * Adapter-aware hook output JSON. Each adapter target has its own protocol
 * shape, so encode it once here so post-emit handlers don't have to branch on
 * `adapter` everywhere.
 *
 * Shapes (verified against live dispatchers + each adapter's upstream hooks docs):
 *
 * - **Claude Code**: `{hookSpecificOutput: {hookEventName, additionalContext}}`
 *   for SessionStart / UserPromptSubmit / SubagentStart; deny uses
 *   `{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason}}`.
 * - **Cursor**: `{additional_context}` flat for context-capable events,
 *   including beforeSubmitPrompt. Deny uses
 *   `{permission: "deny", agent_message, user_message}`.
 * - **Codex**: structurally identical to Claude Code for context and tool
 *   denials. Stop blocks are deliberately suppressed because their automatic
 *   continuation can replace a completed user-facing answer.
 *
 * Every helper writes to process.stdout + newline-terminates so callers can
 * fire-and-forget. Empty text is a no-op.
 */

import type { Adapter } from "../../adapter.ts";
import { STOP_REMEDIATION_MARKER } from "../../agents/rules/stop-hook.ts";
import { endOfTurnStatusCommand, resolveBinName } from "../../config.ts";

export type SystemEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "SubagentStart"
  | "PreToolUse"
  | "PostToolUse";

export interface StopOutputOptions {
  /** Existing coordination verdict. Omit when that check passed. */
  verdict?: { reason?: string; rule: string };
}

/** Emit a context-injection (peer table, wiring check, council pending, …). */
export function emitContext(adapter: Adapter, event: SystemEvent, text: string): boolean {
  if (!text) return false;
  const json = buildContextJson(adapter, event, text);
  process.stdout.write(`${JSON.stringify(json)}\n`);
  return true;
}

/** Emit a PreToolUse deny: blocks the tool call with `reason` shown to the model. */
export function emitDeny(adapter: Adapter, reason: string): void {
  if (!reason) return;
  const json = buildDenyJson(adapter, reason);
  process.stdout.write(`${JSON.stringify(json)}\n`);
}

/**
 * Emit a Stop-hook block in the firing adapter's enforcement channel and return
 * the process exit code the caller should use.
 *
 * The verdict (allow/block + reason) is computed adapter-agnostically in
 * agents/rules/stop-hook.ts; this function only shapes *how the block is
 * communicated back*, because each adapter has a different mechanism:
 *
 * - **Claude Code** honors `exit 2` + a stderr reason as a turn block, and the
 *   adapter re-prompts the model with the stderr text.
 * - **Codex** also supports that channel, but Harnery must not use it for
 *   coordination reminders. A Stop continuation can replace the completed
 *   answer in clients that retain only the final continuation response. Return
 *   success without output as a defense in depth behind the observe-only
 *   verdict in `agents/rules/stop-hook.ts`.
 * - **Cursor** ignores stop-hook exit codes (non-zero = fail-open, the turn
 *   proceeds) and re-prompts ONLY via a `followup_message` field in stdout
 *   JSON, which it auto-submits as the next user message: the sanctioned
 *   "iterate until a goal is met" channel, capped by `loop_limit` (default 5).
 *   We exit 0 so Cursor treats the run as a success and honors the output.
 *   (Confirmed against cursor.com/docs/agent/hooks.)
 */
export function emitStopBlock(
  adapter: Adapter,
  verdict: { reason?: string; rule: string },
  coordRoot?: string,
): 0 | 2 {
  return emitStopOutcome(adapter, { verdict }, coordRoot);
}

/**
 * Emit the adapter-specific response for one Stop outcome.
 */
export function emitStopOutcome(
  adapter: Adapter,
  options: StopOutputOptions,
  coordRoot?: string,
): 0 | 2 {
  if (adapter === "codex") return 0;

  const verdict = options.verdict;
  if (!verdict) return 0;

  if (adapter === "cursor") {
    process.stdout.write(
      `${JSON.stringify({ followup_message: cursorCoordinationRemediation(verdict, coordRoot) })}\n`,
    );
    return 0;
  }

  if (!verdict) return 0;
  const reason = verdict.reason ?? "End-of-turn coordination ritual incomplete.";
  // Claude Code re-prompts inside one native Stop remediation cycle, but tools
  // run after the first terminal are recorded in recovered telemetry turns.
  // Name the whole ritual so one continuation can repair every required signal.
  const bin = resolveBinName(coordRoot);
  const statusCommand = endOfTurnStatusCommand(coordRoot);
  const remediation = `Repair the whole ritual in this continuation: if the original turn used a tool and task evidence is missing, run \`${bin} agents set-task "<short focus>"\`; then run \`${statusCommand}\` as your last tool call and paste its status box verbatim in your reply.`;
  process.stderr.write(`${reason}\n${remediation}\n[agent-hook stop]: rule=${verdict.rule}\n`);
  return 2;
}

function cursorCoordinationRemediation(
  verdict: { reason?: string; rule: string },
  coordRoot?: string,
): string {
  const reason = verdict.reason ?? "End-of-turn coordination ritual incomplete.";
  // The marker leads the message so the Stop verdict can recognize the turn
  // Cursor opens from it (`STOP_REMEDIATION_MARKER`), and so the operator can
  // see in chat that the message came from Harnery rather than from them.
  // Both commands are named because one message that repairs the whole ritual
  // ends the chain in a single followup; the failing rule is context.
  const bin = resolveBinName(coordRoot);
  const statusCommand = endOfTurnStatusCommand(coordRoot);
  const message = [
    `${STOP_REMEDIATION_MARKER} rule=${verdict.rule}]`,
    reason,
    `Repair the ritual in this turn: run \`${bin} agents set-task "<short focus>"\` and then \`${statusCommand}\` as your last tool call.`,
  ].join("\n");
  return message;
}

function buildContextJson(
  adapter: Adapter,
  event: SystemEvent,
  text: string,
): Record<string, unknown> {
  if (adapter === "cursor") {
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

function buildDenyJson(adapter: Adapter, reason: string): Record<string, unknown> {
  if (adapter === "cursor") {
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
