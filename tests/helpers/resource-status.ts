import { utimesSync } from "node:fs";
import { hostname } from "node:os";
import {
  PRESSURE_ASSESSMENT_SCHEMA_VERSION,
  PRESSURE_POLICY,
  type PressureAssessment,
  type PressureHysteresisState,
  type PressureState,
} from "../../src/core/diagnostics/contract";
import {
  RESOURCE_SNAPSHOT_SCHEMA_VERSION,
  type ResourceSnapshot,
} from "../../src/core/resources/contract";
import { resourcePaths, writePrivateJsonAtomic } from "../../src/core/resources/storage";
import {
  SUPERVISOR_FINDING_SCHEMA_VERSION,
  SUPERVISOR_PRESSURE_SCHEMA_VERSION,
  type SupervisorPressureRecord,
} from "../../src/core/supervisor/contract";
import { supervisorPaths } from "../../src/core/supervisor/storage";

export function resourceStatusFixture(root: string, nowMs = Date.now()): ResourceSnapshot {
  const snapshot: ResourceSnapshot = {
    schema_version: RESOURCE_SNAPSHOT_SCHEMA_VERSION,
    sampled_at: new Date(nowMs).toISOString(),
    interval_ms: 2000,
    sample_duration_ms: 12,
    collector_cpu_ms: 5,
    platform: "linux",
    namespace: "wsl",
    support: { state: "supported", sampler: "procfs" },
    machine: {
      cpu_percent: 30,
      cpu_logical_count: 8,
      cpu_available_parallelism: 8,
      load_average: [1, 2, 3],
      memory_total_bytes: 16 * 1024 ** 3,
      memory_available_bytes: 8 * 1024 ** 3,
      memory_used_bytes: 8 * 1024 ** 3,
      memory_percent: 50,
      swap_total_bytes: 1024 ** 3,
      swap_used_bytes: 0,
      process_count: 30,
    },
    disks: [
      {
        path: root,
        state: "supported",
        total_bytes: 100 * 1024 ** 3,
        available_bytes: 40 * 1024 ** 3,
        used_percent: 60,
      },
    ],
    pressure: {
      state: "supported",
      cpu: { avg10: 1, avg60: 1, avg300: 1 },
      memory: null,
      io: null,
      memory_full: null,
      io_full: null,
    },
    vmstat: {
      state: "supported",
      swap_in_bytes_per_second: 0,
      swap_out_bytes_per_second: 0,
      direct_reclaim_pages_per_second: 0,
      major_faults_per_second: 0,
      counters_reset: false,
    },
    io: { state: "supported", read_bytes_per_second: 1024, write_bytes_per_second: 2048 },
    groups: [],
    processes: [
      {
        pid: 1,
        ppid: 0,
        start_id: "1",
        state: "S",
        name: "worker",
        command: "worker --token should-not-appear",
        cpu_percent: 5,
        rss_bytes: 1024,
        age_seconds: 10,
        owner_kind: "agent",
        owner_id: "test-agent",
        owner_root_pid: 1,
      },
    ],
    visible_process_count: 1,
    omitted_process_count: 29,
    unattributed_process_count: 0,
  };
  writePrivateJsonAtomic(resourcePaths(root).snapshot, snapshot);
  writePrivateJsonAtomic(supervisorPaths(root).service, {
    schema_version: 1,
    pid: process.pid,
    host: hostname(),
    nonce: "fixture",
    state: "running",
    started_at: new Date(nowMs - 60_000).toISOString(),
    heartbeat_at: new Date(nowMs).toISOString(),
    keep_alive: true,
  });
  writePrivateJsonAtomic(supervisorPaths(root).findings, {
    schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
    active: [],
    transitions: [],
    max_findings: 200,
  });
  pressureRecordFixture(root, { nowMs });
  return snapshot;
}

export function hysteresisFixture(
  overrides: Partial<PressureHysteresisState> = {},
): PressureHysteresisState {
  return {
    state: "normal",
    state_since: "2026-09-03T09:00:00.000Z",
    consecutive_clear_samples: 5,
    dimension_streaks: {},
    oom_baseline_total_kills: 6,
    oom_hold_until: null,
    observer_generation: "observer-1",
    ...overrides,
  };
}

/** One complete assessment, shaped like the observer's, for fixtures and fakes. */
export function pressureAssessmentFixture(
  overrides: Partial<PressureAssessment> = {},
): PressureAssessment {
  const state: PressureState = overrides.state ?? "normal";
  return {
    schema_version: PRESSURE_ASSESSMENT_SCHEMA_VERSION,
    observer_only: true,
    state,
    scope: "guest",
    limiting_resource: "none",
    trend: "steady",
    observed_at: "2026-09-03T09:00:10.000Z",
    sample_age_ms: 2_000,
    evidence_state: "complete",
    evidence: [
      {
        dimension: "memory_stall",
        state: "supported",
        observed_value: 0,
        unit: "percent",
        sample_count: 5,
      },
    ],
    reasons: [
      {
        code: "no_contention_evidence",
        dimension: null,
        summary: "No kernel stall, reclaim, or capacity signal crossed its threshold.",
        observed_value: null,
        threshold_value: null,
        unit: null,
        sample_count: 5,
        contributes_to: "normal",
      },
    ],
    contributors: [],
    omitted_contributor_count: 0,
    unattributed_memory_percent: 4,
    recommended_action: "proceed",
    summary: "Local resources are not contended, so heavy work can proceed.",
    guidance: [
      {
        workload_class: "lightweight",
        recommendation: "proceed",
        summary: "Reads and edits can proceed.",
      },
      {
        workload_class: "cpu-heavy",
        recommendation: "proceed",
        summary: "Builds and test runs can proceed.",
      },
      {
        workload_class: "memory-heavy",
        recommendation: "proceed",
        summary: "Browser captures and page QA can proceed.",
      },
      {
        workload_class: "storage-heavy",
        recommendation: "proceed",
        summary: "Large writes and exports can proceed.",
      },
    ],
    hysteresis: hysteresisFixture({ state }),
    policy_version: PRESSURE_POLICY.policy_version,
    ...overrides,
  };
}

/** Publish a pressure record the way the observer does. */
export function pressureRecordFixture(
  root: string,
  options: {
    nowMs?: number;
    assessment?: Partial<PressureAssessment>;
    prior?: PressureHysteresisState | null;
    record?: Partial<SupervisorPressureRecord>;
  } = {},
): SupervisorPressureRecord {
  const nowMs = options.nowMs ?? Date.now();
  const record: SupervisorPressureRecord = {
    schema_version: SUPERVISOR_PRESSURE_SCHEMA_VERSION,
    published_at: new Date(nowMs).toISOString(),
    observer_generation: "observer-1",
    assessment: pressureAssessmentFixture({
      observed_at: new Date(nowMs).toISOString(),
      ...options.assessment,
    }),
    prior_hysteresis: options.prior ?? null,
    ...options.record,
  };
  writePrivateJsonAtomic(supervisorPaths(root).pressure, record);
  // Keep the record's modification time consistent with its stated sample time,
  // so a fixture that backdates the snapshot also backdates the assessment.
  const stamp = new Date(nowMs);
  utimesSync(supervisorPaths(root).pressure, stamp, stamp);
  return record;
}

export function resourceFindingFixture(kind = "machine.cpu-pressure", severity = "warning") {
  return {
    schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
    id: `finding:${kind}`,
    fingerprint: kind,
    source_kind: "resource-snapshot",
    finding_kind: kind,
    finding_class: kind.startsWith("machine.") ? "contention" : "attribution",
    severity,
    state: "opened",
    scope_kind: "machine",
    scope_id: "local",
    summary: "Measured resource pressure",
    opened_at: new Date().toISOString(),
    observed_at: new Date().toISOString(),
    occurrence_count: 1,
    evidence: [],
    capabilities: [],
  };
}
