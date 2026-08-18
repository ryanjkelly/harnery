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
 * closed): the projector renders `unknown` rather than guessing. Retired ledger
 * rows are dropped, and accepted rows keep their canonical V2 event names.
 */

import type { EventV2 } from "../../../src/core/events/v2/contract";
import { validateEventV2 } from "../../../src/core/events/v2/validate";
import type { CodecActionCategory, CodecSourceEvidence } from "./contracts";

/** Longest intent/task string allowed across the boundary. */
const MAX_LABEL_CHARS = 120;

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

const PROGRESS_CATEGORIES: Record<string, CodecActionCategory> = {
  write: "edit",
  test: "test",
  commit: "build",
  deploy: "build",
  publication: "build",
  review: "coordinate",
  artifact: "other",
};

function clampLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_LABEL_CHARS ? `${trimmed.slice(0, MAX_LABEL_CHARS - 1)}…` : trimmed;
}

export function categorizeTool(toolName: string | undefined): CodecActionCategory {
  if (!toolName) return "other";
  return TOOL_CATEGORIES[toolName] ?? "other";
}

/**
 * Reduce one raw canonical row to bounded evidence, or null to drop it.
 * The input is `unknown` on purpose: this function is the trust boundary and
 * validates every field it lifts. V1 rows fail closed.
 */
export function sanitizeEvent(raw: unknown): CodecSourceEvidence | null {
  return sanitizeEventV2(raw);
}

/** Reduce a fully validated event-ledger V2 row into Codec's stable evidence shape. */
function sanitizeEventV2(raw: unknown): CodecSourceEvidence | null {
  const validation = validateEventV2(raw);
  if (!validation.ok) return null;
  const event = raw as EventV2;
  if (!("session_id" in event.scope) || !("generation_id" in event.scope)) return null;
  const links = event.links as { parent_generation_id?: string };
  const base: CodecSourceEvidence = {
    schema_version: 2,
    event_id: event.event_id,
    event_type: event.event_type,
    ts: event.time.observed_at,
    instance_id: subjectInstanceId(event),
    session_id: event.scope.session_id,
    generation_id: event.scope.generation_id,
  };
  if (links.parent_generation_id && links.parent_generation_id !== event.scope.generation_id) {
    base.parent_generation_id = links.parent_generation_id;
  }
  if ("recovery" in event.payload && event.payload.recovery) {
    base.recovered = true;
  }

  switch (event.event_type) {
    case "session.started":
    case "session.resumed":
      return base;
    case "session.ended":
      return base;
    case "session.termination_observed":
      if (event.payload.observation === "stale") return null;
      return base;
    case "agent.delegated":
    case "agent.started":
      base.child_generation_id = event.payload.child_generation_id;
      return base;
    case "agent.completed":
      base.child_generation_id = event.payload.child_generation_id;
      return base;
    case "turn.started":
      return base;
    case "turn.completed":
      return base;
    case "tool.requested": {
      base.tool_name = event.payload.tool.name;
      base.category = categorizeTool(event.payload.tool.name);
      base.outcome = "started";
      return base;
    }
    case "tool.completed": {
      base.tool_name = event.payload.tool.name;
      base.category = categorizeTool(event.payload.tool.name);
      base.outcome = codecOutcome(event.payload.outcome);
      return base;
    }
    case "command.started":
      base.category = "diagnostic";
      base.outcome = "started";
      return base;
    case "command.completed":
      base.category = "diagnostic";
      base.outcome = codecOutcome(event.payload.outcome);
      return base;
    case "interaction.wait_started":
      return base;
    case "interaction.wait_ended":
      return base;
    case "progress.observed":
      base.category = PROGRESS_CATEGORIES[event.payload.kind] ?? "other";
      base.outcome = "ok";
      return base;
    case "context.observed":
      return liftMeasurement(base, event.payload.measurement);
    case "context.compaction_started":
      return liftMeasurement(base, event.payload.before);
    case "context.compaction_completed":
      return liftMeasurement(base, event.payload.after);
    case "coord.task_changed":
      base.task_cleared = event.payload.new_state === "cleared";
      return base;
    case "coord.lifecycle_changed":
      if (
        event.payload.new_state !== "active" &&
        event.payload.new_state !== "blocked" &&
        event.payload.new_state !== "done"
      ) {
        return null;
      }
      base.task_state = event.payload.new_state;
      return base;
    case "coord.identity_attested":
      base.identity_name = clampLabel(event.payload.identity_id);
      return base;
    case "coord.message_observed":
      base.ping_to = event.payload.peer_instance_id;
      return base;
    case "lifecycle.recovered":
      base.recovered = true;
      return base;
    default:
      return null;
  }
}

function subjectInstanceId(event: EventV2): string {
  switch (event.event_type) {
    case "coord.task_changed":
    case "coord.lifecycle_changed":
    case "coord.identity_attested":
    case "coord.status_observed":
    case "coord.claim_changed":
    case "coord.presence_changed":
    case "session.termination_observed":
    case "lifecycle.recovered":
    case "lifecycle.sweep_observed":
      return event.payload.subject_instance_id;
    default:
      return event.scope.instance_id;
  }
}

function liftMeasurement(
  base: CodecSourceEvidence,
  measurement: {
    state: string;
    value?: { used_tokens: number; limit_tokens: number };
    attestation?: string;
    confidence?: string;
  },
): CodecSourceEvidence | null {
  if (measurement.state !== "observed" || !measurement.value) return null;
  const limit = measurement.value.limit_tokens;
  if (!Number.isFinite(limit) || limit <= 0) return null;
  base.used_percent = Math.min(100, (measurement.value.used_tokens / limit) * 100);
  base.context_confidence = evidenceConfidence(
    measurement.attestation ?? "",
    measurement.confidence ?? "",
  );
  return base;
}

function codecOutcome(outcome: string): CodecSourceEvidence["outcome"] {
  if (outcome === "succeeded") return "ok";
  if (
    outcome === "failed" ||
    outcome === "cancelled" ||
    outcome === "timed_out" ||
    outcome === "denied" ||
    outcome === "interrupted"
  ) {
    return "error";
  }
  return "unknown";
}

function evidenceConfidence(
  attestation: string,
  confidence: string,
): CodecSourceEvidence["context_confidence"] {
  if (attestation === "native" && confidence === "exact") return "exact";
  if (attestation === "native" || attestation === "derived") return "reported";
  return "estimated";
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
