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
 * rows are dropped, and accepted rows keep their canonical V3 event names.
 */

import type { EventV3, RuntimeAttestationV3 } from "../../../src/core/events/v3/contract";
import { validateEventV3 } from "../../../src/core/events/v3/validate";
import type {
  CodecActionCategory,
  CodecComparableFingerprint,
  CodecSourceEvidence,
} from "./contracts";

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
  apply_patch: "edit",
  exec_command: "diagnostic",
  view_image: "research",
  web__run: "research",
  update_plan: "coordinate",
  spawn_agent: "coordinate",
  send_message: "coordinate",
  followup_task: "coordinate",
  wait_agent: "coordinate",
};

const PROGRESS_CATEGORIES: Record<string, CodecActionCategory> = {
  write: "edit",
  test: "test",
  commit: "build",
  deploy: "build",
  publication: "build",
  review: "coordinate",
  artifact: "build",
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

/** Namespace-aware category normalization across Claude, Codex, and MCP-style tools. */
export function categorizeOperation(
  namespace: string | undefined,
  toolName: string | undefined,
  targetAccess?: string,
): CodecActionCategory {
  const direct = categorizeTool(toolName);
  if (direct !== "other") return direct;
  const key = `${namespace ?? ""}/${toolName ?? ""}`.toLowerCase();
  if (/collaboration|agent|message|plan|workflow|council|decide/.test(key)) return "coordinate";
  if (
    /apply.?patch|edit|write|notebookedit|str.?replace|search.?replace|delete|create.?file/.test(
      key,
    )
  ) {
    return "edit";
  }
  if (/test|playwright|vitest|jest/.test(key)) return "test";
  if (/image.?gen|document|spreadsheet|presentation|publish|deploy/.test(key)) return "build";
  if (/web|search|read|grep|glob|view.?image|browser|list.?dir|find.?file/.test(key)) {
    return "research";
  }
  if (/exec|command|shell|bash|terminal/.test(key)) return "diagnostic";
  if (targetAccess === "write" || targetAccess === "delete") return "edit";
  if (targetAccess === "publish") return "build";
  return "other";
}

/**
 * Reduce one raw canonical row to bounded evidence, or null to drop it.
 * The input is `unknown` on purpose: this function is the trust boundary and
 * validates every field it lifts. non-V3 rows fail closed.
 */
export function sanitizeEvent(raw: unknown): CodecSourceEvidence | null {
  return sanitizeEventV3(raw);
}

/** Reduce a fully validated event-ledger V3 row into Codec's stable evidence shape. */
function sanitizeEventV3(raw: unknown): CodecSourceEvidence | null {
  const validation = validateEventV3(raw);
  if (!validation.ok) return null;
  const event = raw as EventV3;
  if (!("session_id" in event.scope) || !("generation_id" in event.scope)) return null;
  const links = event.links as {
    parent_generation_id?: string;
    span_id?: string;
    parent_span_id?: string;
  };
  const base: CodecSourceEvidence = {
    schema_version: 2,
    adapter: adapterFromSourceEvent(event.provenance.source_event),
    event_id: event.event_id,
    event_type: event.event_type,
    ts: event.time.observed_at,
    instance_id: subjectInstanceId(event),
    session_id: event.scope.session_id,
    generation_id: event.scope.generation_id,
  };
  if ("turn_id" in event.scope && event.scope.turn_id) base.turn_id = event.scope.turn_id;
  if (links.span_id) base.span_id = links.span_id;
  if (links.parent_span_id) base.parent_span_id = links.parent_span_id;
  if (event.time.skew === "regressed") base.telemetry_issue = "clock-regressed";
  if (event.provenance.attribution.state === "conflict") {
    base.telemetry_issue = "attribution-conflict";
  }
  if (links.parent_generation_id && links.parent_generation_id !== event.scope.generation_id) {
    base.parent_generation_id = links.parent_generation_id;
  }
  if ("recovery" in event.payload && event.payload.recovery) {
    base.recovered = true;
    base.recovery_reason = event.payload.recovery.reason;
    if (event.payload.recovery.requested_event_id) {
      base.recovery_requested_event_id = event.payload.recovery.requested_event_id;
    }
  }

  switch (event.event_type) {
    case "session.started":
      liftRuntimeAttestation(base, event.payload.runtime_attestation);
      return base;
    case "session.attestation_changed":
      liftRuntimeAttestation(base, event.payload.runtime_attestation);
      return base;
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
      const target = preferredTarget(event.payload.targets);
      base.tool_namespace = event.payload.tool.namespace;
      base.tool_name = event.payload.tool.name;
      base.operation_fingerprint = liftFingerprint(event.payload.exact_input);
      liftTarget(base, target);
      base.category = categorizeOperation(
        event.payload.tool.namespace,
        event.payload.tool.name,
        target?.access,
      );
      base.outcome = "started";
      return base;
    }
    case "tool.completed": {
      base.tool_namespace = event.payload.tool.namespace;
      base.tool_name = event.payload.tool.name;
      base.category = categorizeOperation(event.payload.tool.namespace, event.payload.tool.name);
      base.outcome = codecOutcome(event.payload.outcome);
      liftDuration(base, event.payload.duration_ms);
      return base;
    }
    case "command.started":
      base.tool_namespace = "command";
      base.tool_name = event.payload.executable;
      base.operation_fingerprint = liftFingerprint(event.payload.exact_command);
      base.category = categorizeOperation("command", event.payload.executable);
      base.outcome = "started";
      return base;
    case "command.output_observed":
      base.output_stream = event.payload.stream;
      base.output_bytes = event.payload.bytes;
      if (event.payload.lines !== undefined) base.output_lines = event.payload.lines;
      return base;
    case "command.completed":
      base.category = "diagnostic";
      base.outcome = codecOutcome(event.payload.outcome);
      liftDuration(base, event.payload.duration_ms);
      return base;
    case "wait.started":
      base.wait_id = event.payload.wait_id;
      base.wait_kind = event.payload.kind;
      if (event.payload.wake_at) base.wake_at = event.payload.wake_at;
      return base;
    case "wait.ended":
      base.wait_id = event.payload.wait_id;
      base.outcome = codecOutcome(event.payload.outcome);
      liftDuration(base, event.payload.span.duration_ms);
      return base;
    case "artifact.observed":
      base.artifact_kind = event.payload.artifact.kind;
      base.artifact_operation = event.payload.operation;
      if (
        event.payload.artifact.kind === "image" &&
        /^art_[a-f0-9]{64}$/.test(event.payload.artifact.artifact_id)
      ) {
        base.artifact_image_hash = event.payload.artifact.artifact_id.slice("art_".length);
        base.artifact_image_media_type = event.payload.artifact.media_type;
        base.artifact_image_bytes = event.payload.artifact.bytes;
      }
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
    case "coord.claim_changed":
      base.claim_operation = event.payload.operation;
      base.claim_access = event.payload.access;
      liftTarget(base, event.payload.target);
      return base;
    case "lifecycle.recovered":
      base.recovered = true;
      base.recovery_reason = event.payload.recovery_kind;
      return base;
    case "lifecycle.sweep_observed":
      return base;
    case "health.capability_drift":
      if (event.payload.expected_count !== event.payload.observed_count) {
        base.telemetry_issue = "capability-drift";
      }
      return base;
    default:
      return null;
  }
}

function liftRuntimeAttestation(
  base: CodecSourceEvidence,
  attestation: RuntimeAttestationV3,
): void {
  if (attestation.harness.state === "observed") {
    base.runtime_harness = attestation.harness.value.id;
    if (attestation.harness.value.version) {
      base.runtime_harness_version = attestation.harness.value.version;
    }
  }
  if (attestation.model.state === "observed") {
    base.runtime_model = attestation.model.value.id;
    base.runtime_model_provider = attestation.model.value.provider;
  }
  if (attestation.tuning.state === "observed") {
    if (attestation.tuning.value.effort) base.runtime_effort = attestation.tuning.value.effort;
    if (attestation.tuning.value.speed) base.runtime_speed = attestation.tuning.value.speed;
  }
}

function adapterFromSourceEvent(
  sourceEvent: string,
): "claude-code" | "codex" | "cursor" | "unknown" {
  if (sourceEvent.startsWith("claude-code.")) return "claude-code";
  if (sourceEvent.startsWith("codex.")) return "codex";
  if (sourceEvent.startsWith("cursor.")) return "cursor";
  return "unknown";
}

function liftFingerprint(fingerprint: {
  digest: string;
  scope: "generation" | "root";
  key_epoch: string;
}): CodecComparableFingerprint {
  return {
    digest: fingerprint.digest,
    scope: fingerprint.scope,
    key_epoch: fingerprint.key_epoch,
  };
}

function preferredTarget<T extends { access: string }>(targets: readonly T[]): T | undefined {
  return targets.find((target) => target.access !== "read") ?? targets[0];
}

function liftTarget(
  base: CodecSourceEvidence,
  target:
    | {
        kind: string;
        access: string;
        fingerprint: { digest: string; scope: "generation" | "root"; key_epoch: string };
      }
    | undefined,
): void {
  if (!target) return;
  base.target_kind = target.kind;
  base.target_access = target.access;
  base.target_fingerprint = liftFingerprint(target.fingerprint);
}

function liftDuration(
  base: CodecSourceEvidence,
  duration: { state: string; value?: number },
): void {
  if (duration.state === "observed" && typeof duration.value === "number") {
    base.duration_ms = duration.value;
    base.duration_state = "observed";
    return;
  }
  if (
    duration.state === "unsupported" ||
    duration.state === "expected_but_missing" ||
    duration.state === "unknown"
  ) {
    base.duration_state = duration.state;
  }
}

function subjectInstanceId(event: EventV3): string {
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
    value?: {
      used_tokens?: number;
      limit_tokens?: number;
      remaining_tokens?: number;
      used_percent?: number;
      remaining_percent?: number;
    };
    attestation?: string;
    confidence?: string;
  },
): CodecSourceEvidence | null {
  if (
    measurement.state !== "observed" &&
    measurement.state !== "unsupported" &&
    measurement.state !== "expected_but_missing" &&
    measurement.state !== "unknown"
  ) {
    return null;
  }
  base.context_observation_state = measurement.state;
  if (measurement.state !== "observed" || !measurement.value) return base;
  const reportedPercent = measurement.value.used_percent;
  if (reportedPercent !== undefined) {
    if (!Number.isFinite(reportedPercent) || reportedPercent < 0 || reportedPercent > 100) {
      return null;
    }
    base.used_percent = reportedPercent;
    base.context_confidence = evidenceConfidence(
      measurement.attestation ?? "",
      measurement.confidence ?? "",
    );
    return base;
  }
  const limit = measurement.value.limit_tokens;
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return null;
  const used = measurement.value.used_tokens;
  if (used === undefined || !Number.isFinite(used) || used < 0) return null;
  base.used_percent = Math.min(100, (used / limit) * 100);
  base.context_used_tokens = used;
  base.context_limit_tokens = limit;
  base.context_remaining_tokens = Math.max(0, measurement.value.remaining_tokens ?? limit - used);
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
