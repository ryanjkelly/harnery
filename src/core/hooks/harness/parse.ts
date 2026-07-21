/**
 * Harness payload parser. One file because all three harnesses (CC, Cursor,
 * Codex) share most of their PreToolUse / PostToolUse field names (Codex's
 * field names match CC's directly) and Cursor's deltas are small enough to
 * branch inline.
 *
 * The parser is intentionally tolerant: every field reads through `pickStr`,
 * `pickNum`, etc., so a missing key returns `undefined` instead of throwing.
 * Phase 2 ship criterion is "parser correctness across thousands of real
 * events without affecting behavior": fail-soft beats fail-hard.
 */

import type { Harness } from "../events/schema.ts";

export interface ParsedPayload {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  subagent_id?: string;
  conversation_id?: string;
  parent_session_id?: string;
  turn_id?: string;
  parent_turn_id?: string;
  transcript_path?: string;
  cwd?: string;
  pid?: number;
  model?: string;
  source?: string; // SessionStart: "startup" | "resume" | …
  prompt?: string; // UserPromptSubmit / beforeSubmitPrompt
  tool_name?: string; // Pre/PostToolUse
  tool_input?: unknown; // Pre/PostToolUse: the model's call arguments
  tool_response?: unknown; // PostToolUse: the tool's output (string or object)
  tool_use_id?: string; // CC ties pre/post via this; Codex echoes it too
  stop_hook_active?: boolean; // Stop
  clean_exit?: boolean; // SessionEnd
  exit_status?: string; // SubagentStop
  reason?: string; // SubagentStop / StopFailure
  /** original parsed object, preserved for callers that need a field we didn't pluck. */
  raw: Record<string, unknown>;
}

/**
 * Parse the raw stdin payload string for any harness. Returns null when JSON
 * parse fails (Cursor occasionally fires hooks with no payload).
 */
export function parsePayload(raw: string, _harness: Harness): ParsedPayload | null {
  if (!raw || raw.trim().length === 0) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  return {
    hook_event_name: pickStr(json, "hook_event_name"),
    session_id: pickStr(json, "session_id"),
    agent_id: pickStr(json, "agent_id"),
    subagent_id: pickStr(json, "subagent_id"),
    conversation_id: pickStr(json, "conversation_id"),
    parent_session_id: pickStr(json, "parent_session_id"),
    turn_id: pickStr(json, "turn_id"),
    parent_turn_id: pickStr(json, "parent_turn_id"),
    transcript_path: pickStr(json, "transcript_path"),
    cwd: pickStr(json, "cwd"),
    pid: pickNum(json, "pid"),
    model: pickStr(json, "model"),
    source: pickStr(json, "source"),
    prompt: pickStr(json, "prompt"),
    tool_name: pickStr(json, "tool_name"),
    tool_input: json.tool_input,
    tool_response: json.tool_response,
    tool_use_id: pickStr(json, "tool_use_id"),
    stop_hook_active: pickBool(json, "stop_hook_active"),
    clean_exit: pickBool(json, "clean_exit"),
    exit_status: pickStr(json, "exit_status"),
    reason: pickStr(json, "reason"),
    raw: json,
  };
}

/**
 * Pull the bash command string out of a Bash/Shell tool_input. Returns
 * undefined for non-shell tools.
 */
export function extractBashCommand(
  toolName: string | undefined,
  toolInput: unknown,
): string | undefined {
  if (!toolName) return undefined;
  if (toolName !== "Bash" && toolName !== "Shell") return undefined;
  if (toolInput && typeof toolInput === "object") {
    const t = toolInput as Record<string, unknown>;
    const cmd = t.command;
    if (typeof cmd === "string") return cmd;
  }
  return undefined;
}

/**
 * Pull the model's description string out of a tool_input. Only Claude Code's
 * Bash tool requires this field; falls back to undefined elsewhere.
 */
export function extractToolDescription(toolInput: unknown): string | undefined {
  if (toolInput && typeof toolInput === "object") {
    const t = toolInput as Record<string, unknown>;
    const d = t.description;
    if (typeof d === "string") return d;
  }
  return undefined;
}

function pickStr(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pickNum(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function pickBool(o: Record<string, unknown>, k: string): boolean | undefined {
  const v = o[k];
  return typeof v === "boolean" ? v : undefined;
}

// ── Event-name normalization ────────────────────────────────────────────────

/**
 * Each harness uses a slightly different name for the "same" lifecycle event.
 * Map the CLI-arg event-name (kebab-case, set by us in the wiring) to one of
 * the canonical event_types. Phase 2's CLI passes the kebab event
 * name; this returns the canonical event_type or null when the event has no
 * canonical equivalent (e.g. Cursor's before-shell-execution duplicates
 * pre-tool-use semantically, so we route both to `tool.pre_use`).
 */
export function normalizeEventName(
  eventName: string,
): { event_type: NormalizedEventType; intra_turn: boolean } | null {
  switch (eventName) {
    case "session-start":
      return { event_type: "session.start", intra_turn: false };
    case "session-end":
      return { event_type: "session.end", intra_turn: false };
    case "user-prompt-submit":
      return { event_type: "user_prompt.submit", intra_turn: false };
    case "stop":
      return { event_type: "turn.stop", intra_turn: false };
    case "stop-failure":
      // Phase 2: a failed stop is still a turn boundary; emit turn.stop and
      // attach the failure signal in `data`. Phase 5 may introduce a
      // dedicated `turn.stop_failure` event if the projector needs to branch.
      return { event_type: "turn.stop", intra_turn: false };
    case "sub-agent-start":
      return { event_type: "subagent.start", intra_turn: false };
    case "sub-agent-stop":
      return { event_type: "subagent.stop", intra_turn: false };
    case "pre-tool-use":
    case "before-shell-execution":
      return { event_type: "tool.pre_use", intra_turn: true };
    case "post-tool-use":
      return { event_type: "tool.post_use", intra_turn: true };
    case "post-tool-use-failure":
      return { event_type: "tool.post_use_failure", intra_turn: true };
    case "pre-compact":
      return { event_type: "context.compaction.started", intra_turn: false };
    case "post-compact":
      return { event_type: "context.compaction.completed", intra_turn: false };
    default:
      return null;
  }
}

export type NormalizedEventType =
  | "session.start"
  | "session.end"
  | "user_prompt.submit"
  | "turn.stop"
  | "subagent.start"
  | "subagent.stop"
  | "tool.pre_use"
  | "tool.post_use"
  | "tool.post_use_failure"
  | "context.compaction.started"
  | "context.compaction.completed";
