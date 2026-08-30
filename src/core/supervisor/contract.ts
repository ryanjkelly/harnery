import type { ResourceProcessGroup, ResourceSnapshot } from "../resources/contract.ts";
import type { HarneryLogRecordV1 } from "../storage/jsonl.ts";

export const SUPERVISOR_STATUS_SCHEMA_VERSION = 1 as const;
export const SUPERVISOR_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const SUPERVISOR_HISTORY_SCHEMA_VERSION = 1 as const;
export const SUPERVISOR_ANOMALY_SCHEMA_VERSION = 1 as const;
export const SUPERVISOR_LOG_FEED_SCHEMA_VERSION = 1 as const;
export const SUPERVISOR_CONSUMER_SCHEMA_VERSION = 1 as const;

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
    process_count: number;
  };
  groups: readonly ResourceProcessGroup[];
}

export interface SupervisorHistory {
  schema_version: typeof SUPERVISOR_HISTORY_SCHEMA_VERSION;
  interval_ms: number;
  max_points: number;
  points: readonly SupervisorHistoryPoint[];
}

export type SupervisorAnomalySeverity = "info" | "warning" | "critical";
export type SupervisorAnomalyState = "opened" | "resolved";

export interface SupervisorAnomalyEvidence {
  summary: string;
  observed_value?: number;
  threshold?: number;
  unit?: "percent" | "bytes" | "milliseconds" | "seconds" | "processes";
  resource?: Pick<
    ResourceSnapshot,
    "sampled_at" | "machine" | "groups" | "collector_cpu_ms" | "sample_duration_ms"
  >;
  services?: readonly ObservedServiceHealth[];
  hooks?: readonly ObservedHookHealth[];
  history?: readonly SupervisorHistoryPoint[];
  recent_logs?: readonly HarneryLogRecordV1[];
}

export interface SupervisorAnomalyTransition {
  id: string;
  fingerprint: string;
  kind:
    | "machine-cpu"
    | "machine-memory"
    | "machine-swap"
    | "collector-overhead"
    | "service-stale"
    | "hook-long-running"
    | "process-memory"
    | "group-memory"
    | "owner-process-count"
    | "memory-growth";
  severity: SupervisorAnomalySeverity;
  state: SupervisorAnomalyState;
  opened_at: string;
  observed_at: string;
  resolved_at?: string;
  evidence: SupervisorAnomalyEvidence;
}

export interface SupervisorAnomalies {
  schema_version: typeof SUPERVISOR_ANOMALY_SCHEMA_VERSION;
  max_transitions: number;
  active: readonly SupervisorAnomalyTransition[];
  transitions: readonly SupervisorAnomalyTransition[];
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
  active_anomaly_count: number;
  history_point_count: number;
  log_record_count: number;
  live_consumer_count: number;
  attributed_agent_count: number;
}
