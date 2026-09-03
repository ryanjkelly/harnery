export const RESOURCE_SNAPSHOT_SCHEMA_VERSION = 2;
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
  cpu_available_parallelism?: number;
  cpu_percent: number | null;
  cpu_logical_count: number;
  load_average: [number, number, number] | null;
  memory_total_bytes: number | null;
  memory_available_bytes: number | null;
  memory_used_bytes: number | null;
  memory_percent: number | null;
  swap_total_bytes: number | null;
  swap_used_bytes: number | null;
  process_count: number | null;
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
    sampler: "procfs" | "darwin" | "win32" | "unsupported";
    reason?: string;
  };
  machine: ResourceMachineSample;
  disks?: ResourceDiskSample[];
  pressure?: ResourcePressureSample;
  oom?: ResourceOomSample;
  vmstat?: ResourceVmstatSample;
  io?: ResourceIoSample;
  host?: ResourceHostSample;
  groups: ResourceProcessGroup[];
  processes: ResourceProcessSample[];
  visible_process_count: number;
  omitted_process_count: number;
  unattributed_process_count: number;
}

export interface ResourceDiskSample {
  path: string;
  state: ResourceSupportState;
  total_bytes: number | null;
  available_bytes: number | null;
  used_percent: number | null;
  reason?: string;
}

export interface ResourcePressureWindow {
  avg10: number;
  avg60: number;
  avg300: number;
}

export interface ResourcePressureSample {
  state: ResourceSupportState;
  /** The CPU, memory, and I/O fields contain the kernel's some-stall averages. */
  cpu: ResourcePressureWindow | null;
  memory: ResourcePressureWindow | null;
  io: ResourcePressureWindow | null;
  memory_full: ResourcePressureWindow | null;
  io_full: ResourcePressureWindow | null;
  reason?: string;
}

export interface ResourceOomSample {
  state: ResourceSupportState;
  total_kills: number | null;
  kills_since_last_sample: number | null;
  last_kill_age_ms: number | null;
  reason?: string;
}

/**
 * Kernel memory-reclaim activity as per-second rates, from one bounded
 * `/proc/vmstat` read. Rates need two consecutive samples: the first sample
 * after a start, an observer restart, or a counter reset reports
 * `counters_reset` with null rates rather than inventing a baseline.
 */
export interface ResourceVmstatSample {
  state: ResourceSupportState;
  swap_in_bytes_per_second: number | null;
  swap_out_bytes_per_second: number | null;
  direct_reclaim_pages_per_second: number | null;
  major_faults_per_second: number | null;
  counters_reset: boolean;
  reason?: string;
}

export interface ResourceIoSample {
  state: ResourceSupportState;
  read_bytes_per_second: number | null;
  write_bytes_per_second: number | null;
  reason?: string;
}

export interface ResourceHostSample {
  platform: "win32";
  sampled_at: string;
  state: ResourceSupportState;
  machine: ResourceMachineSample | null;
  disks: ResourceDiskSample[];
  reason?: string;
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
