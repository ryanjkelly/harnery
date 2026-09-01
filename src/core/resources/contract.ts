export const RESOURCE_SNAPSHOT_SCHEMA_VERSION = 1;
export const RESOURCE_SERVICE_STATUS_SCHEMA_VERSION = 1;

export type ResourceSupportState = "supported" | "partial" | "unsupported" | "error";

export interface ResourceProcessSample {
  pid: number;
  ppid: number;
  start_id: string;
  state: string;
  name: string;
  command: string;
  cpu_percent: number | null;
  rss_bytes: number;
  age_seconds: number;
  owner_kind: "agent" | "service" | "unattributed";
  owner_id: string | null;
  owner_root_pid: number | null;
  owner_source?: "pid-map" | "session-environment" | "service";
}

export interface ResourceProcessGroup {
  kind: ResourceProcessSample["owner_kind"];
  id: string;
  process_count: number;
  cpu_percent: number | null;
  rss_bytes: number;
  root_pids: number[];
}

export interface ResourceMachineSample {
  cpu_percent: number | null;
  cpu_logical_count: number;
  load_average: [number, number, number] | null;
  memory_total_bytes: number | null;
  memory_available_bytes: number | null;
  memory_used_bytes: number | null;
  memory_percent: number | null;
  swap_total_bytes: number | null;
  swap_used_bytes: number | null;
  process_count: number;
}

export interface ResourceSnapshot {
  schema_version: typeof RESOURCE_SNAPSHOT_SCHEMA_VERSION;
  sampled_at: string;
  interval_ms: number | null;
  sample_duration_ms: number;
  collector_cpu_ms: number;
  platform: NodeJS.Platform;
  namespace: "host" | "wsl" | "unknown";
  support: {
    state: ResourceSupportState;
    sampler: "procfs" | "unsupported";
    reason?: string;
  };
  machine: ResourceMachineSample;
  groups: ResourceProcessGroup[];
  processes: ResourceProcessSample[];
  visible_process_count: number;
  omitted_process_count: number;
  unattributed_process_count: number;
}

export interface ResourceServiceStatusRecord {
  schema_version: typeof RESOURCE_SERVICE_STATUS_SCHEMA_VERSION;
  pid: number;
  start_token?: string;
  host: string;
  nonce: string;
  state: "starting" | "running" | "stopping" | "stopped" | "error";
  started_at: string;
  heartbeat_at: string;
  stopped_at?: string;
  interval_ms: number;
  sample_count: number;
  last_sample_at?: string;
  last_error_code?: string;
}

export interface ResourceServiceStatus {
  running: boolean;
  stale: boolean;
  record?: ResourceServiceStatusRecord;
  status_path: string;
  snapshot_path: string;
}

export interface ResourceSamplerState {
  sampled_at_ms: number;
  cpu_total_ticks: number;
  cpu_idle_ticks: number;
  process_ticks: Map<string, number>;
  process_owners: Map<string, ResourceProcessOwnerProof>;
}

export interface ResourceProcessOwnerProof {
  session_id: string;
  instance_id: string;
}

export interface ResourceSampleResult {
  snapshot: ResourceSnapshot;
  state?: ResourceSamplerState;
}
