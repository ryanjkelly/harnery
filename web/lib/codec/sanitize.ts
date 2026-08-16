/**
 * Server-side ingestion allowlist for the Codec visual director.
 *
 * Reduces a raw canonical event row to bounded `CodecSourceEvidence` or drops
 * it entirely. The reduction is a per-type field allowlist, not a denylist:
 * a field crosses only when a rule below names it. Prompts, transcripts, tool
 * inputs, tool outputs, command bodies, and error bodies are never copied —
 * the raw row is read, the allowed scalars are lifted, and the rest is
 * discarded in place (never persisted or forwarded).
 *
 * Unknown event types and unsupported schema versions return null (fail
 * closed): the projector renders `unknown` rather than guessing.
 */

import type {
  CodecActionCategory,
  CodecSourceEvidence,
} from "./contracts";

/** Longest intent/task string allowed across the boundary. */
const MAX_LABEL_CHARS = 120;

/** Event types the Codec view consumes at all. Everything else is dropped. */
const ACCEPTED_TYPES = new Set([
  "session.start",
  "session.end",
  "subagent.start",
  "subagent.stop",
  "user_prompt.submit",
  "interaction.input_requested",
  "turn.stop",
  "command.start",
  "command.end",
  "tool.pre_use",
  "tool.post_use",
  "tool.post_use_failure",
  "context.sampled",
  "state.task_set",
  "state.task_state",
  "state.heartbeat",
  "state.ping",
  "identity.assumed",
]);

/**
 * Tool-name → action category. Explicit allowlist; anything unrecognized is
 * `other`, never a guess. Categories drive icons and (later) expressions, so
 * a wrong mapping shows a wrong glyph — safe, but keep the map honest.
 */
const TOOL_CATEGORIES: Record<string, CodecActionCategory> = {
  Read: "research",
  Grep: "research",
  Glob: "research",
  LS: "research",
  WebFetch: "research",
  WebSearch: "research",
  NotebookRead: "research",
  Edit: "edit",
  Write: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "diagnostic",
  BashOutput: "diagnostic",
  KillShell: "diagnostic",
  Agent: "coordinate",
  Task: "coordinate",
  SendMessage: "coordinate",
  Workflow: "coordinate",
  Skill: "other",
};

function clampLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_LABEL_CHARS ? `${trimmed.slice(0, MAX_LABEL_CHARS - 1)}…` : trimmed;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function categorizeTool(toolName: string | undefined): CodecActionCategory {
  if (!toolName) return "other";
  return TOOL_CATEGORIES[toolName] ?? "other";
}

/**
 * Reduce one raw canonical row to bounded evidence, or null to drop it.
 * The input is `unknown` on purpose: this function is the trust boundary and
 * validates every field it lifts.
 */
export function sanitizeEvent(raw: unknown): CodecSourceEvidence | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (row.schema_version !== 1) return null;

  const eventType = str(row.event_type);
  const eventId = str(row.event_id);
  const ts = str(row.ts);
  const instanceId = str(row.instance_id);
  if (!eventType || !eventId || !ts || !instanceId) return null;
  if (!ACCEPTED_TYPES.has(eventType)) return null;

  const data =
    typeof row.data === "object" && row.data !== null ? (row.data as Record<string, unknown>) : {};

  const out: CodecSourceEvidence = {
    schema_version: 1,
    event_id: eventId,
    event_type: eventType,
    ts,
    instance_id: instanceId,
  };
  const sessionId = str(row.session_id);
  if (sessionId) out.session_id = sessionId;
  const parentSessionId = str(row.parent_session_id);
  if (parentSessionId) out.parent_session_id = parentSessionId;

  switch (eventType) {
    case "tool.pre_use": {
      const toolName = str(data.tool_name);
      if (toolName) out.tool_name = toolName;
      out.category = categorizeTool(toolName);
      out.outcome = "started";
      const intent = clampLabel(data.intent);
      if (intent) out.intent = intent;
      break;
    }
    case "tool.post_use": {
      const toolName = str(data.tool_name);
      if (toolName) out.tool_name = toolName;
      out.category = categorizeTool(toolName);
      out.outcome = data.exit_status === "error" ? "error" : "ok";
      break;
    }
    case "tool.post_use_failure": {
      const toolName = str(data.tool_name);
      if (toolName) out.tool_name = toolName;
      out.category = categorizeTool(toolName);
      out.outcome = "error";
      break;
    }
    case "command.start": {
      out.category = "diagnostic";
      out.outcome = "started";
      const intent = clampLabel(data.intent);
      if (intent) out.intent = intent;
      break;
    }
    case "command.end": {
      out.category = "diagnostic";
      out.outcome = num(data.exit) === 0 ? "ok" : "error";
      break;
    }
    case "interaction.input_requested": {
      const toolName = str(data.tool_name);
      if (toolName) out.tool_name = toolName;
      break;
    }
    case "context.sampled": {
      const usedPercent = num(data.used_percent);
      if (usedPercent !== undefined) out.used_percent = usedPercent;
      const confidence = data.confidence;
      if (confidence === "exact" || confidence === "reported" || confidence === "estimated") {
        out.context_confidence = confidence;
      }
      break;
    }
    case "state.task_set": {
      const task = clampLabel(data.task);
      if (task) out.task = task;
      out.task_cleared = data.cleared === true;
      break;
    }
    case "state.task_state": {
      const state = data.state;
      if (state === "active" || state === "blocked" || state === "done") out.task_state = state;
      break;
    }
    case "identity.assumed": {
      const name = clampLabel(data.name);
      if (name) out.identity_name = name;
      break;
    }
    case "state.ping": {
      // Delivery record only: recipient id crosses, the message body does not.
      const peer = str(data.peer_instance_id);
      if (peer) out.ping_to = peer;
      break;
    }
    // session/subagent lifecycle, prompts, and turn stops carry type + ts only:
    // the envelope is the evidence, every data field (including prompt_text)
    // stays behind.
    default:
      break;
  }

  return out;
}

/** Parse and sanitize one ndjson line; malformed rows drop silently. */
export function sanitizeLine(line: string): CodecSourceEvidence | null {
  if (!line) return null;
  try {
    return sanitizeEvent(JSON.parse(line));
  } catch {
    return null;
  }
}
