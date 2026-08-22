/**
 * Codec visual-director contracts (schema_version 2).
 *
 * The Codec view is a read-only presentation layer over the canonical event
 * stream and existing read models. These types are the whole boundary: only
 * `CodecSourceEvidence` may cross from raw events into the projector, and only
 * `CodecScene` may cross to the browser. Nothing here writes to Harnery
 * coordination state, and nothing downstream of these types may import a
 * write/control surface (enforced by boundary.test.ts).
 *
 * Versioning: additive changes bump nothing (consumers ignore unknown fields);
 * removing or retyping a field bumps `schema_version` and fails closed to
 * `unknown` on unsupported source versions.
 */

import type { EventTypeV3 } from "../../../src/core/events/v3/contract";

export type Confidence = "high" | "medium" | "low";
export type Provenance = "event" | "projection" | "inferred" | "unknown";

/** A display value that always carries where it came from and how sure we are. */
export interface Presented<T> {
  value: T;
  provenance: Provenance;
  confidence: Confidence;
  observed_at: string;
  /** Bounded, source-valid event IDs backing the value. */
  evidence_event_ids?: string[];
  /** Required for temporary cues (attention overlays, focus bubbles). */
  expires_at?: string;
}

export type CodecPresence = "online" | "offline" | "unknown";
export type CodecActivity = "working" | "needs-input" | "idle" | "unknown";
export type CodecLifecycle = "active" | "blocked" | "done" | "unknown";
export type CodecContextBand = "ample" | "reduced" | "low" | "unknown";
export type CodecFreshness = "live" | "stale" | "reconnecting" | "unknown";
export type CodecProgressRhythm =
  | "just-started"
  | "in-motion"
  | "steady"
  | "bursty"
  | "wrapping-up"
  | "unknown";

export type CodecExpression =
  | "neutral"
  | "focused"
  | "curious"
  | "deliberating"
  | "investigating"
  | "building"
  | "coordinating"
  | "waiting"
  | "recovering"
  | "celebrating"
  | "alert";

export type CodecAttention = "none" | "input" | "friction" | "error" | "completion";

export type CodecActionCategory =
  | "research"
  | "diagnostic"
  | "build"
  | "edit"
  | "test"
  | "coordinate"
  | "other";

export type CodecActionOutcome = "started" | "ok" | "error" | "unknown";

export type CodecOperationState = "active" | "output-flow" | "retrying" | "long-running";
export type CodecArtifactOperation = "created" | "updated" | "viewed" | "published";
export type CodecFriction = "recent-error" | "repeating-operation" | "target-contention";
export type CodecTelemetry = "healthy" | "degraded" | "unknown";
export type CodecTelemetryReason =
  | "clock-regressed"
  | "attribution-conflict"
  | "capability-drift"
  | "context-observation-missing";

export type CodecRemoteFreshness = "fresh" | "aging" | "stale";
export type CodecRemoteMachineState = "fresh" | "aging" | "offline";

export interface CodecRemoteFreshnessValue {
  state: CodecRemoteFreshness;
  age_ms: number;
}

/** Machine-level relay health survives longer than remote agent panels. It
 * carries only transport metadata, so an expired cache can report a known
 * machine as offline without reviving stale people, tasks, or activity. */
export interface CodecRemoteMachine {
  machine: string;
  state: CodecRemoteMachineState;
  age_ms: number;
  observed_at: string;
  /** Count of panels still safe to render, never the expired blob's old count. */
  visible_agent_count: number;
}

export interface CodecOperationValue {
  category: CodecActionCategory;
  /** Public-safe operation label derived from namespace/name, never arguments. */
  label: string;
  state: CodecOperationState;
  elapsed_ms?: number;
  /** Successful same-adapter/tool durations available to the baseline. */
  duration_sample_count?: number;
  /** Omitted until the minimum history requirement is met. */
  long_running_threshold_ms?: number;
}

export interface CodecArtifactValue {
  operation: CodecArtifactOperation;
  /** Contract-safe artifact kind token; paths and artifact contents never cross. */
  kind: string;
  /** Local content-addressed image reference; stripped before relay publication. */
  image_hash?: string;
  image_media_type?: string;
  image_bytes?: number;
}

export interface CodecContextUsage {
  used_percent: number;
  remaining_percent: number;
  /** Exact local measurements when the adapter supplies them. */
  used_tokens?: number;
  limit_tokens?: number;
  remaining_tokens?: number;
}

/** Public-safe runtime identity for one agent generation. Tuning fields stay
 * null unless the adapter reports them explicitly or encodes them in its
 * canonical model id (for example Cursor's `-high-fast` suffixes). */
export interface CodecRuntimeValue {
  harness: string | null;
  harness_version?: string;
  model: string | null;
  model_provider?: string;
  effort: string | null;
  speed: string | null;
}

export interface CodecComparableFingerprint {
  digest: string;
  scope: "generation" | "root";
  key_epoch: string;
}

export interface CodecRecentAction {
  category: CodecActionCategory;
  outcome: CodecActionOutcome;
  event_id: string;
  observed_at: string;
}

/** One bounded operator-authored #intent label. The full command, tool input,
 * output, prompt, and transcript remain outside the Codec boundary. */
export interface CodecIntentSignal {
  text: string;
  event_id: string;
  observed_at: string;
  event_type: EventTypeV3;
  category: CodecActionCategory;
  tool_name?: string;
  adapter?: CodecSourceEvidence["adapter"];
  /** True when the local live-display overlay supplied this label. */
  live_overlay?: boolean;
}

/**
 * The bounded per-event evidence the sanitizer emits. This is the ONLY shape
 * raw canonical rows are reduced to; prompts, transcripts, tool inputs/outputs,
 * command bodies, and error bodies are dropped at ingestion and never reach
 * this type. Field allowlist lives in sanitize.ts.
 */
export interface CodecSourceEvidence {
  schema_version: 2;
  /** Adapter family inferred from the canonical producer source token. */
  adapter?: "claude-code" | "codex" | "cursor" | "unknown";
  event_id: string;
  event_type: EventTypeV3;
  ts: string;
  instance_id: string;
  session_id?: string;
  /** Turn scope for bounded retry/repetition windows. */
  turn_id?: string;
  parent_session_id?: string;
  /** V3 generation that produced this row; used to join parentage. */
  generation_id?: string;
  /** Child's link to the parent generation; never stuffed into parent_session_id. */
  parent_generation_id?: string;
  /** Parent's announced child generation from agent.started / delegated. */
  child_generation_id?: string;
  /** True when the live-display feed supplied this row's intent overlay. */
  live_overlay?: boolean;
  /** True when a recovery block or lifecycle.recovered was observed. */
  recovered?: boolean;
  recovery_reason?: string;
  /** Original request linked by a machinery-minted recovery terminal. */
  recovery_requested_event_id?: string;
  /** Span correlation only; no content is embedded in either identifier. */
  span_id?: string;
  parent_span_id?: string;
  wait_id?: string;
  wait_kind?:
    | "permission"
    | "needs_input"
    | "decision"
    | "approval"
    | "dependency"
    | "scheduled"
    | "rate_limit"
    | "unknown";
  wake_at?: string;
  /** Tool namespace and name are contract SafeTokens, never tool inputs. */
  tool_namespace?: string;
  /** Tool/command name only, never inputs or outputs. */
  tool_name?: string;
  operation_fingerprint?: CodecComparableFingerprint;
  target_kind?: string;
  target_access?: string;
  target_fingerprint?: CodecComparableFingerprint;
  duration_ms?: number;
  duration_state?: "observed" | "unsupported" | "expected_but_missing" | "unknown";
  output_stream?: "stdout" | "stderr" | "combined";
  output_bytes?: number;
  output_lines?: number;
  artifact_kind?: string;
  artifact_operation?: CodecArtifactOperation;
  /** Bounded local image metadata; source paths and contents are still dropped. */
  artifact_image_hash?: string;
  artifact_image_media_type?: string;
  artifact_image_bytes?: number;
  claim_operation?: "acquired" | "released" | "denied";
  claim_access?: "read" | "write";
  /** Observation-quality defect, not an agent error. */
  telemetry_issue?: "clock-regressed" | "attribution-conflict" | "capability-drift";
  /** Normalized action category when the event is an action. */
  category?: CodecActionCategory;
  /** Action outcome when the event closes an action. */
  outcome?: CodecActionOutcome;
  /** Bounded declared intent (clamped), never a prompt or command body. */
  intent?: string;
  /** Bounded task label from the ephemeral live-display overlay, when available. */
  task?: string;
  /** True when coord.task_changed cleared the task. */
  task_cleared?: boolean;
  /** Lifecycle from coord.lifecycle_changed. */
  task_state?: "active" | "blocked" | "done";
  /** Context capacity from context.sampled. */
  used_percent?: number;
  context_used_tokens?: number;
  context_limit_tokens?: number;
  context_remaining_tokens?: number;
  context_confidence?: "exact" | "reported" | "estimated";
  /** Capability state retained even when a context value is unavailable. */
  context_observation_state?: "observed" | "unsupported" | "expected_but_missing" | "unknown";
  /** Public runtime attestation lifted from session.started/attestation_changed. */
  runtime_harness?: string;
  runtime_harness_version?: string;
  runtime_model?: string;
  runtime_model_provider?: string;
  /** Durable display name from identity.assumed. */
  identity_name?: string;
  /** Message recipient from coord.message_observed; body never crosses. */
  ping_to?: string;
}

export interface CodecPanelScene {
  instance_id: string;
  identity: { display_name: string; task?: Presented<string> };
  /** Present on panels sourced from another machine's presence blob. */
  machine?: string;
  presence: Presented<CodecPresence>;
  activity: Presented<CodecActivity>;
  lifecycle: Presented<CodecLifecycle>;
  expression: Presented<CodecExpression>;
  /** Non-none states must carry expires_at. */
  attention: Presented<CodecAttention>;
  context_band: Presented<CodecContextBand>;
  /** Harness/model identity plus adapter-reported tuning when available. */
  runtime?: Presented<CodecRuntimeValue>;
  /** Exact usage locally; percentage-only when sourced from a remote digest. */
  context_usage?: Presented<CodecContextUsage>;
  progress_rhythm: Presented<CodecProgressRhythm>;
  recent_actions: CodecRecentAction[];
  /** Newest first, capped at three; omitted from remote relay payloads. */
  intent_history?: CodecIntentSignal[];
  focus_bubble?: Presented<{
    text: string;
    basis: "event-backed" | "inferred";
    /** Present only when the bubble text came from the local live-display feed. */
    live_overlay?: boolean;
  }>;
  /** Newest open leaf operation derived from paired V3 spans/waits. */
  operation?: Presented<CodecOperationValue>;
  /** Most recent bounded artifact operation; omitted after its decay window. */
  artifact_cue?: Presented<CodecArtifactValue>;
  /** Conservative friction vocabulary; never claims cognition or percent complete. */
  friction?: Presented<CodecFriction>;
  /** Only defects are asserted; absence of quality evidence remains unknown. */
  telemetry?: Presented<CodecTelemetry>;
  /** Bounded explanation for a degraded observer cue. */
  telemetry_reason?: Presented<CodecTelemetryReason>;
  /** Present only on panels read from another machine's presence relay. */
  remote_source?: {
    relay: Presented<CodecRemoteFreshnessValue>;
    digest?: Presented<CodecRemoteFreshnessValue>;
  };
  parent_instance_id?: Presented<string>;
  /** V3 ledger lifecycle for this generation, when the snapshot carries it. */
  ledger_state?: Presented<"live" | "ending" | "recovery-required" | "terminal">;
  character: { pack_id: string; pack_version: string };
  updated_at: string;
}

export interface CodecRelationship {
  relationship_id: string;
  from_instance_id: string;
  to_instance_id: string;
  kind: "dependency" | "shared-coordination";
  status: "active" | "waiting" | "blocked";
  provenance: "event" | "projection";
}

export interface CodecTransient {
  cue_id: string;
  kind: "message" | "dependency-completed";
  from_instance_id?: string;
  to_instance_id?: string;
  occurred_at: string;
  expires_at: string;
  provenance: "event" | "projection";
}

export interface CodecScene {
  schema_version: 2;
  source_event_id?: string;
  freshness: Presented<CodecFreshness>;
  panels: CodecPanelScene[];
  remote_machines: CodecRemoteMachine[];
  relationships: CodecRelationship[];
  transients: CodecTransient[];
  team_ambience: Presented<"calm" | "busy" | "alert" | "unknown">;
  generated_at: string;
}

/** Neutral character pack used until Phase 4 delivers a real roster. */
export const FALLBACK_PACK = { pack_id: "fallback-neutral", pack_version: "0" } as const;

export const CODEC_SCHEMA_VERSION = 2 as const;
