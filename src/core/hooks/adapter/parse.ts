/**
 * Adapter payload parser. One file because all three adapters (CC, Cursor,
 * Codex) share most of their PreToolUse / PostToolUse field names (Codex's
 * field names match CC's directly) and Cursor's deltas are small enough to
 * branch inline.
 *
 * The parser is intentionally tolerant: every field reads through `pickStr`,
 * `pickNum`, etc., so a missing key returns `undefined` instead of throwing.
 * Phase 2 ship criterion is "parser correctness across thousands of real
 * events without affecting behavior": fail-soft beats fail-hard.
 */

import type { Adapter } from "../../adapter.ts";

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
  /** Privacy-safe Cursor execution surface, derived from native lifecycle metadata. */
  cursor_mode?: "local" | "cloud" | "unknown";
  /** original parsed object, preserved for callers that need a field we didn't pluck. */
  raw: Record<string, unknown>;
}

/**
 * Parse the raw stdin payload string for any adapter. Returns null when JSON
 * parse fails (Cursor occasionally fires hooks with no payload).
 */
export function parsePayload(raw: string, adapter: Adapter): ParsedPayload | null {
  if (!raw || raw.trim().length === 0) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const rawSessionId = pickStr(json, "session_id");
  const rawConversationId = pickStr(json, "conversation_id");
  const sessionId = normalizeSessionId(adapter, rawSessionId);
  const conversationId = normalizeSessionId(adapter, rawConversationId);
  const parentSessionId = normalizeSessionId(adapter, pickStr(json, "parent_session_id"));
  const hookEventName = pickStr(json, "hook_event_name");
  const cursorGenerationId = adapter === "cursor" ? pickStr(json, "generation_id") : undefined;
  const cursorShellHook =
    adapter === "cursor" &&
    (hookEventName === "beforeShellExecution" || hookEventName === "afterShellExecution");
  const cursorCommand = cursorShellHook ? pickStr(json, "command") : undefined;
  const normalizedToolInput = normalizeToolInput(json.tool_input, adapter);
  const normalizedRaw =
    adapter === "cursor"
      ? {
          ...json,
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(conversationId ? { conversation_id: conversationId } : {}),
          ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
        }
      : json;

  return {
    hook_event_name: hookEventName,
    session_id: sessionId,
    agent_id: pickStr(json, "agent_id"),
    subagent_id: pickStr(json, "subagent_id"),
    conversation_id: conversationId,
    parent_session_id: parentSessionId,
    // Claude Code names its native turn identifier prompt_id; both are the
    // adapter's turn-scoped id and feed native turn stamping (ADR 0078).
    turn_id: pickStr(json, "turn_id") ?? pickStr(json, "prompt_id") ?? cursorGenerationId,
    parent_turn_id: pickStr(json, "parent_turn_id"),
    transcript_path: pickStr(json, "transcript_path"),
    cwd: pickStr(json, "cwd"),
    pid: pickNum(json, "pid"),
    model: pickStr(json, "model"),
    source: pickStr(json, "source"),
    prompt: pickStr(json, "prompt"),
    tool_name: cursorShellHook ? "Shell" : pickStr(json, "tool_name"),
    tool_input: cursorCommand ? { command: cursorCommand } : normalizedToolInput,
    tool_response: hookEventName === "afterShellExecution" ? json.output : json.tool_response,
    tool_use_id: pickStr(json, "tool_use_id"),
    stop_hook_active: pickBool(json, "stop_hook_active"),
    clean_exit: pickBool(json, "clean_exit"),
    exit_status: pickStr(json, "exit_status"),
    reason: pickStr(json, "reason"),
    cursor_mode: cursorMode(json, adapter, rawSessionId, rawConversationId),
    raw: normalizedRaw,
  };
}

/**
 * Cursor prefixes cloud/private-worker conversations with `bc-`. Current
 * sessionStart payloads also expose `is_background_agent`; either native
 * signal is enough to classify the execution surface without retaining text.
 */
function cursorMode(
  json: Record<string, unknown>,
  adapter: Adapter,
  sessionId: string | undefined,
  conversationId: string | undefined,
): ParsedPayload["cursor_mode"] {
  if (adapter !== "cursor") return undefined;
  const background = pickBool(json, "is_background_agent");
  if (background === true) return "cloud";
  if (background === false) return "local";
  const nativeId = conversationId ?? sessionId;
  if (!nativeId) return "unknown";
  return nativeId.startsWith("bc-") ? "cloud" : "local";
}

/** Cursor can serialize generic tool_input as a JSON string instead of an object. */
function normalizeToolInput(value: unknown, adapter: Adapter): unknown {
  if (adapter !== "cursor" || typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Cursor Glass prefixes conversation ids with `bc-`; coordination uses the bare id everywhere. */
function normalizeSessionId(adapter: Adapter, value: string | undefined): string | undefined {
  if (adapter !== "cursor" || !value?.startsWith("bc-") || value.length <= 3) return value;
  return value.slice(3);
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
 * Each adapter uses a slightly different name for the "same" lifecycle event.
 * Map the CLI-arg event-name (kebab-case, set by us in the wiring) to one of
 * the canonical event_types. Phase 2's CLI passes the kebab event
 * name; this returns the canonical event_type or null when the event has no
 * canonical equivalent. Cursor's shell-specific hooks are retained as reliable
 * remote/CLI fallbacks and normalized to the same tool events as generic hooks.
 */
export function normalizeEventName(
  eventName: string,
): { event_type: NormalizedEventType; intra_turn: boolean } | null {
  switch (eventName) {
    case "session-start":
      return { event_type: "session.started", intra_turn: false };
    case "session-end":
      return { event_type: "session.ended", intra_turn: false };
    case "user-prompt-submit":
      return { event_type: "turn.started", intra_turn: false };
    case "stop":
      return { event_type: "turn.completed", intra_turn: false };
    case "stop-failure":
      return { event_type: "turn.completed", intra_turn: false };
    case "sub-agent-start":
      return { event_type: "agent.started", intra_turn: false };
    case "sub-agent-stop":
      return { event_type: "agent.completed", intra_turn: false };
    case "pre-tool-use":
    case "before-shell-execution":
      return { event_type: "tool.requested", intra_turn: true };
    case "permission-request":
      return { event_type: "wait.started", intra_turn: true };
    case "post-tool-use":
    case "after-shell-execution":
    case "post-tool-use-failure":
      return { event_type: "tool.completed", intra_turn: true };
    case "pre-compact":
      return { event_type: "context.compaction_started", intra_turn: false };
    case "post-compact":
      return { event_type: "context.compaction_completed", intra_turn: false };
    default:
      return null;
  }
}

export type NormalizedEventType =
  | "session.started"
  | "session.ended"
  | "turn.started"
  | "turn.completed"
  | "agent.started"
  | "agent.completed"
  | "tool.requested"
  | "wait.started"
  | "tool.completed"
  | "context.compaction_started"
  | "context.compaction_completed";
