import type { ResourceProcessGroup } from "../resources/contract.ts";
import type { HarneryLogRecordV1 } from "../storage/jsonl.ts";

export const SUPERVISOR_STATUS_SCHEMA_VERSION = 1 as const;
export const SUPERVISOR_SNAPSHOT_SCHEMA_VERSION = 2 as const;
export const SUPERVISOR_HISTORY_SCHEMA_VERSION = 1 as const;
export const SUPERVISOR_FINDING_SCHEMA_VERSION = 2 as const;
export const SUPERVISOR_ACTIVITY_SCHEMA_VERSION = 1 as const;
export const SUPERVISOR_TIMELINE_SCHEMA_VERSION = 2 as const;
export const SUPERVISOR_EXPLANATION_SCHEMA_VERSION = 1 as const;
export const SUPERVISOR_LOG_FEED_SCHEMA_VERSION = 1 as const;
export const SUPERVISOR_CONSUMER_SCHEMA_VERSION = 1 as const;

export const SUPERVISOR_DIAGNOSTIC_LIMITS = {
  max_findings: 100,
  max_active_findings: 32,
  max_evidence_per_finding: 32,
  max_timeline_entries: 160,
  max_explanation_items: 24,
  max_capabilities: 16,
  max_activity_entries: 64,
  max_bundle_files: 32,
  max_bundle_bytes: 8 * 1_024 * 1_024,
  max_summary_chars: 500,
  max_excerpt_chars: 2_000,
} as const;

export const SUPERVISOR_FINDING_POLICY = {
  episode_gap_ms: 5 * 60_000,
  activity_freshness_ms: 2 * 60_000,
  max_activity_file_bytes: 64 * 1_024,
  max_activity_total_bytes: 512 * 1_024,
} as const;

export const SUPERVISOR_RESOURCE_BUDGET = {
  max_rss_bytes: 128 * 1_024 * 1_024,
  max_cycle_duration_ms: 50,
  max_startup_duration_ms: 2_000,
  max_cache_bytes: 8 * 1_024 * 1_024,
  max_regression_ratio: 1.2,
} as const;

export type SupervisorProcessState = "starting" | "running" | "stopping" | "stopped" | "error";

export interface SupervisorServiceStatusRecord {
  schema_version: typeof SUPERVISOR_STATUS_SCHEMA_VERSION;
  pid: number;
  start_token?: string;
  host: string;
  nonce: string;
  state: SupervisorProcessState;
  started_at: string;
  heartbeat_at: string;
  interval_ms: number;
  keep_alive: boolean;
  idle_exit_ms: number;
  cycle_count: number;
  last_cycle_at?: string;
  last_cycle_duration_ms?: number;
  idle_since?: string;
  last_error_code?: string;
  stopped_at?: string;
}

export interface SupervisorStatus {
  running: boolean;
  stale: boolean;
  record?: SupervisorServiceStatusRecord;
  status_path: string;
  snapshot_path: string;
}

export interface SupervisorConsumerRecord {
  schema_version: typeof SUPERVISOR_CONSUMER_SCHEMA_VERSION;
  id: string;
  pid: number;
  start_token?: string;
  registered_at: string;
}

export type ObservedServiceState = "running" | "stopped" | "stale" | "unknown";

export interface ObservedServiceHealth {
  id: "supervisor" | "semantic-reader" | "presence-relay" | "governor" | "dashboard";
  state: ObservedServiceState;
  pid?: number;
  started_at?: string;
  heartbeat_at?: string;
  reason?: string;
}

export interface ObservedHookHealth {
  pid: number;
  owner_id: string;
  state: string;
  age_seconds: number;
  cpu_percent: number | null;
  rss_bytes: number;
  command: string;
  long_running: boolean;
  evidence: "validated-owner-and-exact-entrypoint";
}

export interface SupervisorHistoryPoint {
  sampled_at: string;
  machine: {
    cpu_percent: number | null;
    memory_percent: number | null;
    memory_used_bytes: number | null;
    swap_used_bytes: number | null;
    process_count: number | null;
    load_average_1?: number | null;
  };
  groups: readonly ResourceProcessGroup[];
}

export interface SupervisorHistory {
  schema_version: typeof SUPERVISOR_HISTORY_SCHEMA_VERSION;
  interval_ms: number;
  max_points: number;
  points: readonly SupervisorHistoryPoint[];
}

export type SupervisorCapabilityState =
  | "supported"
  | "partial"
  | "unsupported"
  | "error"
  | "expired"
  | "malformed"
  | "redacted";
export type SupervisorFindingSeverity = "info" | "warning" | "critical";
export type SupervisorFindingState = "opened" | "resolved";

export interface SupervisorCapability {
  source_kind: string;
  state: SupervisorCapabilityState;
  reason_code?: string;
  detail?: string;
}

export interface SupervisorSourceReference {
  id: string;
  source_kind: string;
  source_id: string;
  observed_at: string;
  record_id?: string;
  sequence?: number;
  schema_version?: number;
  capability: SupervisorCapabilityState;
}

export interface SupervisorFindingEvidence {
  id: string;
  source: SupervisorSourceReference;
  summary: string;
  observed_value?: number;
  unit?: "percent" | "bytes" | "milliseconds" | "seconds" | "processes" | "count";
}

export interface SupervisorFindingAttribution {
  state: "attributed" | "unattributed";
  owner_kind?: "agent" | "service";
  owner_id?: string;
  owner_root_pid?: number;
  reason_code?: "no-validated-process-anchor";
}

export interface SupervisorFindingWorkloadContext {
  relationship: "active-work" | "unexpected-idle-growth" | "unknown";
  declared_activity: "working" | "needs_input" | "idle" | "unknown";
  task_state: "active" | "blocked" | "done" | "unknown";
  observed_at: string;
  source: SupervisorSourceReference;
}

export interface SupervisorFinding {
  schema_version: typeof SUPERVISOR_FINDING_SCHEMA_VERSION;
  id: string;
  fingerprint: string;
  source_kind: string;
  finding_kind: string;
  severity: SupervisorFindingSeverity;
  state: SupervisorFindingState;
  scope_kind: string;
  scope_id: string;
  summary: string;
  opened_at: string;
  observed_at: string;
  resolved_at?: string;
  occurrence_count: number;
  peak_observed_value?: number;
  peak_observed_at?: string;
  peak_unit?: SupervisorFindingEvidence["unit"];
  attribution?: SupervisorFindingAttribution;
  workload_context?: SupervisorFindingWorkloadContext;
  primary_source: SupervisorSourceReference;
  evidence: readonly SupervisorFindingEvidence[];
  capabilities: readonly SupervisorCapability[];
}

export interface SupervisorDeclaredActivity {
  scope_kind: "agent";
  scope_id: string;
  session_id: string;
  declared_activity: "working" | "needs_input" | "idle" | "unknown";
  task_state: "active" | "blocked" | "done";
  observed_at: string;
  source: SupervisorSourceReference;
}

export interface SupervisorActivitySnapshot {
  schema_version: typeof SUPERVISOR_ACTIVITY_SCHEMA_VERSION;
  observed_at: string;
  max_entries: number;
  entries: readonly SupervisorDeclaredActivity[];
  omitted_entry_count: number;
  capability: SupervisorCapability;
}

export interface SupervisorFindings {
  schema_version: typeof SUPERVISOR_FINDING_SCHEMA_VERSION;
  max_findings: number;
  active: readonly SupervisorFinding[];
  transitions: readonly SupervisorFinding[];
}

export type SupervisorTimelineRelation =
  | "opened"
  | "observed"
  | "related"
  | "resolved"
  | "capability"
  | "missing";

export interface SupervisorTimelineEntry {
  id: string;
  occurred_at: string;
  first_occurred_at: string;
  last_occurred_at: string;
  occurrence_count: number;
  relation: SupervisorTimelineRelation;
  summary: string;
  source: SupervisorSourceReference;
  evidence_id?: string;
}

export interface SupervisorTimeline {
  schema_version: typeof SUPERVISOR_TIMELINE_SCHEMA_VERSION;
  finding_id: string;
  start_at: string;
  end_at: string;
  max_entries: number;
  omitted_entries: number;
  compacted_entries: number;
  entries: readonly SupervisorTimelineEntry[];
  capabilities: readonly SupervisorCapability[];
}

export interface SupervisorExplanationStatement {
  id: string;
  code: string;
  summary: string;
  evidence_ids: readonly string[];
}

export interface SupervisorPossibleExplanation extends SupervisorExplanationStatement {
  confidence: "low" | "medium" | "high";
  evidence_against_ids: readonly string[];
}

export interface SupervisorFindingExplanation {
  schema_version: typeof SUPERVISOR_EXPLANATION_SCHEMA_VERSION;
  finding_id: string;
  generated_at: string;
  observed: readonly SupervisorExplanationStatement[];
  related: readonly SupervisorExplanationStatement[];
  possible: readonly SupervisorPossibleExplanation[];
  missing_capabilities: readonly SupervisorCapability[];
}

export interface SupervisorLogLane {
  family_id: string;
  owner: string;
  storage_class: "operational-log" | "debug-log";
  records: readonly HarneryLogRecordV1[];
  truncated: boolean;
  error?: string;
}

export interface SupervisorLogFeed {
  schema_version: typeof SUPERVISOR_LOG_FEED_SCHEMA_VERSION;
  captured_at: string;
  sequence: number;
  lanes: readonly SupervisorLogLane[];
  total_records: number;
  unavailable_families: number;
}

export interface SupervisorSnapshot {
  schema_version: typeof SUPERVISOR_SNAPSHOT_SCHEMA_VERSION;
  sampled_at: string;
  sequence: number;
  collector_duration_ms: number;
  resource_sample_duration_ms: number;
  services: readonly ObservedServiceHealth[];
  hooks: readonly ObservedHookHealth[];
  active_finding_count: number;
  history_point_count: number;
  log_record_count: number;
  live_consumer_count: number;
  attributed_agent_count: number;
}
