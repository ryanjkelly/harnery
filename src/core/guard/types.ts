export const RUN_QUALITY_SCHEMA_VERSION = 1 as const;

export type RunQualityMode = "off" | "shadow" | "report";
export type RunQualityStatus = "unknown" | "healthy" | "attention" | "critical";
export type RunQualitySignalState = "inactive" | "active" | "unknown" | "suppressed";
export type RunQualityWaitKind =
  | "none"
  | "needs_input"
  | "decision"
  | "approval"
  | "scheduled"
  | "unknown";

export interface RunQualityThresholds {
  repeated_tool_calls: number;
  consecutive_failures: number;
  context_growth_per_minute: number;
  compaction_grace_seconds: number;
  no_progress_evaluations: number;
}

export interface RunQualityConfig {
  mode: RunQualityMode;
  evaluation_interval_seconds: number;
  snapshot_ttl_seconds: number;
  max_tail_bytes: number;
  evaluation_timeout_seconds: number;
  lock_stale_seconds: number;
  supervised_roots_per_sweep: number;
  thresholds: RunQualityThresholds;
}

export interface RunQualityConfigResult {
  config: RunQualityConfig | null;
  digest: string;
  valid: boolean;
  requested_mode: RunQualityMode;
  reason_codes: string[];
}

export interface RunQualityRoleWait {
  role: string;
  wait_kind: RunQualityWaitKind;
  source: string;
  observed_at: string;
  fresh: boolean;
  record_id?: string;
  wake_at?: string;
}

export type RunQualityEvidenceKind =
  | "tool_call"
  | "tool_success"
  | "tool_failure"
  | "context_sample"
  | "progress"
  | "compaction_started"
  | "compaction_completed";

export interface RunQualityEvidenceEvent {
  event_id: string;
  ts: string;
  kind: RunQualityEvidenceKind;
  input_hash?: string;
  target_hash?: string;
  used_tokens?: number;
  confidence?: "exact" | "reported" | "estimated";
  telemetry_source?: string;
}

export interface RunQualitySignal {
  id:
    | "repeated_tool_calls"
    | "consecutive_failures"
    | "context_growth"
    | "target_stagnation"
    | "no_progress"
    | "compaction_grace";
  state: RunQualitySignalState;
  severity: "none" | "attention" | "critical";
  count: number;
  reason_code: string;
}

export interface RunQualityEvaluatorState {
  repeated_hash?: string;
  repeated_count: number;
  exact_hash_seen: boolean;
  missing_hash_seen: boolean;
  target_hash?: string;
  target_streak: number;
  target_hash_seen: boolean;
  failure_streak: number;
  work_since_progress: number;
  last_context?: { used_tokens: number; ts: string };
  context_growth_per_minute?: number;
  no_progress_epochs: number;
  no_progress_deadline_epochs: number;
  compaction_grace_until?: string;
}

export interface RunQualitySnapshot {
  schema_version: typeof RUN_QUALITY_SCHEMA_VERSION;
  instance_id: string;
  session_id: string;
  session_generation: string;
  adapter: string;
  config_digest: string;
  mode: Exclude<RunQualityMode, "off">;
  status: RunQualityStatus;
  previous_status: RunQualityStatus;
  evaluated_at: string;
  next_eligible_at: string;
  expires_at: string;
  evidence: {
    first_event_id?: string;
    last_event_id?: string;
    window_started_at?: string;
    window_ended_at?: string;
    segment: string;
    truncated: boolean;
  };
  signals: RunQualitySignal[];
  role_wait: RunQualityRoleWait;
  state: RunQualityEvaluatorState;
  epoch: "evidence" | "deadline" | "read";
  reason: "evidence" | "deadline" | "config_changed" | "insufficient_evidence";
}

export interface EvaluateRunQualityInput {
  instance_id: string;
  session_id: string;
  session_generation: string;
  adapter: string;
  now: string;
  config: RunQualityConfig;
  config_digest: string;
  events: RunQualityEvidenceEvent[];
  previous?: RunQualitySnapshot;
  role_wait: RunQualityRoleWait;
  evidence: RunQualitySnapshot["evidence"];
  sufficient_history: boolean;
  live: boolean;
}
