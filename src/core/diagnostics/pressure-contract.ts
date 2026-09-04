/**
 * Pressure assessment: the one explained answer to "is this machine under
 * contention, and what should an agent do about it?"
 *
 * Two rules are structural rather than advisory. State comes only from
 * contention evidence the kernel reports (stall time, kills, reclaim rates,
 * exhausted capacity); attribution findings name who is using a resource and
 * are carried as contributors that can never raise or lower the state. And a
 * dimension the platform does not expose is reported as unavailable, never
 * silently read as healthy.
 */

import type { ResourceSnapshot } from "../resources/contract.ts";

export const PRESSURE_ASSESSMENT_SCHEMA_VERSION = 1 as const;

export type PressureState = "normal" | "elevated" | "critical" | "unknown";
export type PressureScope = "guest" | "native" | "windows-host";
export type PressureLimitingResource = "memory" | "cpu" | "io" | "storage" | "none" | "unknown";
export type PressureTrend = "rising" | "steady" | "falling" | "unknown";
export type PressureRecommendedAction =
  | "proceed"
  | "limit-heavy-work"
  | "avoid-new-heavy-work"
  | "unknown";

/** What an agent is about to do, so guidance can differ by the resource it consumes. */
export type PressureWorkloadClass = "lightweight" | "cpu-heavy" | "memory-heavy" | "storage-heavy";

/** One measurable contention dimension. Each maps to exactly one snapshot field. */
export type PressureDimension =
  | "memory_stall"
  | "io_stall"
  | "cpu_stall"
  | "oom_kills"
  | "swap_activity"
  | "direct_reclaim"
  | "memory_available"
  | "disk_available"
  | "host_memory";

export type PressureUnit =
  | "percent"
  | "bytes"
  | "bytes-per-second"
  | "pages-per-second"
  | "count"
  | "milliseconds";

export interface PressureEvidenceDimension {
  dimension: PressureDimension;
  state: "supported" | "unavailable";
  observed_value: number | null;
  unit: PressureUnit | null;
  /** Consecutive samples this dimension has held its current side of a threshold. */
  sample_count: number;
  reason_code?: string;
}

export type PressureReasonCode =
  | "memory_full_stall_critical"
  | "memory_full_stall_elevated"
  | "io_full_stall_critical"
  | "io_full_stall_elevated"
  | "cpu_stall_elevated"
  | "new_oom_kill"
  | "swap_out_rate_critical"
  | "swap_out_rate_elevated"
  | "direct_reclaim_with_memory_signal"
  | "direct_reclaim_elevated"
  | "memory_and_swap_exhausted"
  | "memory_available_low"
  | "disk_space_critical"
  | "disk_space_low"
  | "host_memory_pressure"
  | "recovering_within_dwell"
  | "no_contention_evidence"
  | "evidence_unavailable"
  | "snapshot_stale";

export interface PressureReason {
  code: PressureReasonCode;
  dimension: PressureDimension | null;
  summary: string;
  observed_value: number | null;
  threshold_value: number | null;
  unit: PressureUnit | null;
  sample_count: number;
  contributes_to: PressureState;
}

/**
 * A finding that names who is consuming a resource. Present so an operator can
 * see the likely owner; never an input to `state`.
 */
export interface PressureContributor {
  finding_id: string;
  finding_kind: string;
  finding_class: "contention" | "attribution" | "diagnostic";
  severity: "info" | "warning" | "critical";
  summary: string;
  scope_kind: string;
  scope_id: string;
  occurrence_count: number;
  attribution_state: "attributed" | "unattributed" | "unknown";
  /** `exact` is the only value that may be rendered as a named owner. */
  attribution_confidence: "exact" | "none";
  owner_kind?: "agent" | "service";
  owner_id?: string;
  workload_relationship?: "active-work" | "unexpected-idle-growth" | "unknown";
}

export interface PressureWorkloadGuidance {
  workload_class: PressureWorkloadClass;
  recommendation: PressureRecommendedAction;
  summary: string;
}

/**
 * The carried-forward inputs a later sample needs to reproduce a hysteresis
 * transition. Frozen in advice v2 and in diagnostic bundles so a replay is
 * deterministic without the observer's memory.
 */
export interface PressureHysteresisState {
  state: PressureState;
  state_since: string;
  /** Consecutive samples clear of every elevated threshold. */
  consecutive_clear_samples: number;
  /** Per-dimension consecutive samples above the elevated threshold. */
  dimension_streaks: Readonly<Partial<Record<PressureDimension, number>>>;
  /** Baseline for the OOM counter, so historical kills never open a finding. */
  oom_baseline_total_kills: number | null;
  /** While set, a new OOM kill holds `critical` until this instant. */
  oom_hold_until: string | null;
  /**
   * Identity of the observer run that produced this state. A change resets
   * every streak, because counters and PSI averages restart with it.
   */
  observer_generation: string | null;
}

export interface PressureAssessment {
  schema_version: typeof PRESSURE_ASSESSMENT_SCHEMA_VERSION;
  observer_only: true;
  state: PressureState;
  scope: PressureScope;
  limiting_resource: PressureLimitingResource;
  trend: PressureTrend;
  observed_at: string;
  sample_age_ms: number | null;
  evidence_state: "complete" | "partial" | "unavailable";
  evidence: readonly PressureEvidenceDimension[];
  reasons: readonly PressureReason[];
  contributors: readonly PressureContributor[];
  omitted_contributor_count: number;
  /** Share of machine memory held by processes with no validated owner. */
  unattributed_memory_percent: number | null;
  recommended_action: PressureRecommendedAction;
  summary: string;
  guidance: readonly PressureWorkloadGuidance[];
  /** The state this sample carries forward; also the replay input of the next. */
  hysteresis: PressureHysteresisState;
  policy_version: typeof PRESSURE_POLICY.policy_version;
}

const MIB = 1_024 * 1_024;
const GIB = 1_024 * MIB;

/**
 * Every numeric threshold the assessment uses. Included in the diagnostic
 * bundle `threshold_digest`, so tuning any value invalidates a frozen replay
 * instead of silently changing its expected result.
 */
export const PRESSURE_POLICY = {
  policy_version: 1,
  /** A snapshot older than this cannot support any state but `unknown`. */
  sample_staleness_ms: 15_000,
  /**
   * A snapshot may carry a sample time slightly ahead of the assessment clock,
   * because the observer samples and then assesses. Within this tolerance the
   * age reads as zero; beyond it the clock is untrustworthy and the state is
   * `unknown`. A negative age is never published.
   */
  sample_future_tolerance_ms: 1_000,
  /** Samples of recent history the assessment may consider. */
  max_history_samples: 12,
  memory_stall: { critical_avg10: 50, elevated_avg10: 20, elevated_samples: 2, exit_avg10: 10 },
  io_stall: { critical_avg10: 50, elevated_avg10: 20, elevated_samples: 2, exit_avg10: 10 },
  cpu_stall: { elevated_some_avg60: 40, elevated_samples: 3 },
  oom: { critical_hold_ms: 60_000 },
  swap_activity: {
    critical_out_bytes_per_second: 50 * MIB,
    critical_samples: 3,
    elevated_out_bytes_per_second: 5 * MIB,
    elevated_samples: 3,
  },
  direct_reclaim: { elevated_pages_per_second: 100_000, elevated_samples: 3 },
  memory_available: {
    critical_available_percent: 5,
    critical_swap_used_percent: 90,
    elevated_available_percent: 10,
    elevated_samples: 3,
  },
  disk: {
    critical_available_bytes: 1 * GIB,
    critical_used_percent: 97,
    elevated_available_bytes: 5 * GIB,
    elevated_used_percent: 90,
  },
  recovery: { critical_exit_samples: 3, elevated_exit_samples: 5 },
  limits: { max_reasons: 6, max_contributors: 8, max_evidence: 12 },
} as const;

/**
 * Everything the assessment is allowed to read. Pure input: no clock, no
 * filesystem, no findings store. `now_ms` and `observer_generation` are
 * supplied by the caller so a fixture can drive a fake clock and a restart.
 */
export interface AssessPressureInput {
  /** The latest snapshot, or null when it is missing, corrupt, or too large. */
  snapshot: ResourceSnapshot | null;
  /** Why the snapshot is absent, when it is. */
  snapshot_reason?: string | null;
  /**
   * Recent samples, oldest first, bounded by `PRESSURE_POLICY.max_history_samples`.
   * Used only for trend; consecutive-sample streaks come from `prior`.
   */
  history: readonly PressureHistorySample[];
  /** Active findings, for contributors only. */
  findings: readonly PressureFindingInput[];
  findings_capability: PressureCapabilityInput;
  /** The state the previous sample carried forward, or null on a cold start. */
  prior: PressureHysteresisState | null;
  observer_generation: string;
  now_ms: number;
}

/**
 * The finding fields a contributor is built from. Structurally satisfied by
 * `SupervisorFinding`; declared here so this module stays a leaf and so the
 * assessment cannot reach any finding field that could set state.
 */
export interface PressureFindingInput {
  id: string;
  finding_kind: string;
  finding_class: "contention" | "attribution" | "diagnostic";
  severity: "info" | "warning" | "critical";
  state: "opened" | "resolved";
  summary: string;
  scope_kind: string;
  scope_id: string;
  observed_at: string;
  occurrence_count: number;
  attribution?: {
    state: "attributed" | "unattributed";
    owner_kind?: "agent" | "service";
    owner_id?: string;
  };
  workload_context?: { relationship: "active-work" | "unexpected-idle-growth" | "unknown" };
}

export interface PressureCapabilityInput {
  source_kind: string;
  state: string;
  reason_code?: string;
}

/** The subset of a past sample the trend calculation needs. */
export interface PressureHistorySample {
  sampled_at: string;
  memory_full_avg10: number | null;
  io_full_avg10: number | null;
  cpu_some_avg60: number | null;
  memory_available_percent: number | null;
  swap_out_bytes_per_second: number | null;
}

/**
 * Compute one explained assessment. Deterministic in its input: the same input
 * always yields the same output, which is what makes a frozen bundle replayable.
 */
export type AssessPressure = (input: AssessPressureInput) => PressureAssessment;
