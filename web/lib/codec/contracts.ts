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

import type { EventTypeV2 } from "../../../src/core/events/v2/contract";

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
export type CodecProgressRhythm = "just-started" | "in-motion" | "wrapping-up" | "unknown";

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

export interface CodecRecentAction {
  category: CodecActionCategory;
  outcome: CodecActionOutcome;
  event_id: string;
  observed_at: string;
}

/**
 * The bounded per-event evidence the sanitizer emits. This is the ONLY shape
 * raw canonical rows are reduced to; prompts, transcripts, tool inputs/outputs,
 * command bodies, and error bodies are dropped at ingestion and never reach
 * this type. Field allowlist lives in sanitize.ts.
 */
export interface CodecSourceEvidence {
  schema_version: 2;
  event_id: string;
  event_type: EventTypeV2;
  ts: string;
  instance_id: string;
  session_id?: string;
  parent_session_id?: string;
  /** V2 generation that produced this row; used to join parentage. */
  generation_id?: string;
  /** Child's link to the parent generation; never stuffed into parent_session_id. */
  parent_generation_id?: string;
  /** Parent's announced child generation from agent.started / delegated. */
  child_generation_id?: string;
  /** True when the live-display feed supplied this row's intent overlay. */
  live_overlay?: boolean;
  /** True when a recovery block or lifecycle.recovered was observed. */
  recovered?: boolean;
  /** Tool/command name only, never inputs or outputs. */
  tool_name?: string;
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
  context_confidence?: "exact" | "reported" | "estimated";
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
  progress_rhythm: Presented<CodecProgressRhythm>;
  recent_actions: CodecRecentAction[];
  focus_bubble?: Presented<{
    text: string;
    basis: "event-backed" | "inferred";
    /** Present only when the bubble text came from the local live-display feed. */
    live_overlay?: boolean;
  }>;
  parent_instance_id?: Presented<string>;
  /** V2 ledger lifecycle for this generation, when the snapshot carries it. */
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
  relationships: CodecRelationship[];
  transients: CodecTransient[];
  team_ambience: Presented<"calm" | "busy" | "alert" | "unknown">;
  generated_at: string;
}

/** Neutral character pack used until Phase 4 delivers a real roster. */
export const FALLBACK_PACK = { pack_id: "fallback-neutral", pack_version: "0" } as const;

export const CODEC_SCHEMA_VERSION = 2 as const;
