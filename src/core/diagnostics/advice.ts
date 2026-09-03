import type { SupervisorCapability, SupervisorHistoryPoint } from "../supervisor/contract.ts";
import {
  DIAGNOSTIC_ADVICE_SCHEMA_VERSION,
  type DiagnosticAdvice,
  PRESSURE_ASSESSMENT_SCHEMA_VERSION,
  PRESSURE_POLICY,
  type PressureAssessment,
  type PressureDimension,
  type PressureEvidenceDimension,
  type PressureHysteresisState,
  type PressureReason,
  type PressureReasonCode,
  type PressureScope,
  type PressureWorkloadGuidance,
} from "./contract.ts";
import type { PressureHistorySample } from "./pressure-contract.ts";

/**
 * Advice is an envelope around one already-computed assessment. It maps
 * nothing: severity does not become pressure here, and no numeric threshold is
 * read. `assessPressure` owns the judgement, the observer publishes it, and
 * every surface renders this envelope so all of them agree.
 */
export interface BuildDiagnosticAdviceInput {
  assessment: PressureAssessment;
  /** The state the previous sample carried forward, so a replay can reproduce a transition. */
  priorHysteresis: PressureHysteresisState | null;
  /** Where the assessment came from, and why it is missing when it is. */
  sourceCapability: SupervisorCapability;
  activeFindingCount: number;
  evaluatedAt: string;
}

export function buildDiagnosticAdvice(input: BuildDiagnosticAdviceInput): DiagnosticAdvice {
  return {
    schema_version: DIAGNOSTIC_ADVICE_SCHEMA_VERSION,
    evaluated_at: input.evaluatedAt,
    observer_only: true,
    assessment: input.assessment,
    prior_hysteresis: input.priorHysteresis,
    source_capability: input.sourceCapability,
    active_finding_count: Math.max(0, Math.trunc(input.activeFindingCount)),
    summary: input.assessment.summary,
  };
}

export const PRESSURE_DIMENSIONS: readonly PressureDimension[] = [
  "memory_stall",
  "io_stall",
  "cpu_stall",
  "oom_kills",
  "swap_activity",
  "direct_reclaim",
  "memory_available",
  "disk_available",
  "host_memory",
];

export interface UnknownPressureAssessmentInput {
  observedAt: string;
  /** A stable code from the frozen union, normally `evidence_unavailable` or `snapshot_stale`. */
  reasonCode: PressureReasonCode;
  /** One plain sentence naming what is missing. Becomes the assessment summary. */
  summary: string;
  scope?: PressureScope;
  sampleAgeMs?: number | null;
  prior?: PressureHysteresisState | null;
  observerGeneration?: string | null;
}

/**
 * The assessment to publish when the source is absent, stale, or malformed.
 * Every dimension reads `unavailable` and no owner is named, because a gap in
 * the evidence is not a measurement of health.
 */
export function unknownPressureAssessment(
  input: UnknownPressureAssessmentInput,
): PressureAssessment {
  const reason: PressureReason = {
    code: input.reasonCode,
    dimension: null,
    summary: input.summary,
    observed_value: null,
    threshold_value: null,
    unit: null,
    sample_count: 0,
    contributes_to: "unknown",
  };
  return {
    schema_version: PRESSURE_ASSESSMENT_SCHEMA_VERSION,
    observer_only: true,
    state: "unknown",
    scope: input.scope ?? "native",
    limiting_resource: "unknown",
    trend: "unknown",
    observed_at: input.observedAt,
    sample_age_ms: input.sampleAgeMs ?? null,
    evidence_state: "unavailable",
    evidence: PRESSURE_DIMENSIONS.map(
      (dimension): PressureEvidenceDimension => ({
        dimension,
        state: "unavailable",
        observed_value: null,
        unit: null,
        sample_count: 0,
        reason_code: input.reasonCode,
      }),
    ).slice(0, PRESSURE_POLICY.limits.max_evidence),
    reasons: [reason],
    contributors: [],
    omitted_contributor_count: 0,
    unattributed_memory_percent: null,
    recommended_action: "unknown",
    summary: input.summary,
    guidance: unknownGuidance(),
    hysteresis: {
      state: "unknown",
      state_since: input.observedAt,
      consecutive_clear_samples: 0,
      dimension_streaks: {},
      oom_baseline_total_kills: input.prior?.oom_baseline_total_kills ?? null,
      oom_hold_until: null,
      observer_generation: input.observerGeneration ?? input.prior?.observer_generation ?? null,
    },
    policy_version: PRESSURE_POLICY.policy_version,
  };
}

function unknownGuidance(): PressureWorkloadGuidance[] {
  return [
    {
      workload_class: "lightweight",
      recommendation: "unknown",
      summary:
        "Reads and small edits cost almost nothing, so continue them while the measurements are missing.",
    },
    {
      workload_class: "cpu-heavy",
      recommendation: "unknown",
      summary:
        "Builds and test runs cannot be judged from here. Start one only if you already know the machine is idle.",
    },
    {
      workload_class: "memory-heavy",
      recommendation: "unknown",
      summary:
        "Browser captures and page QA cannot be judged from here. Run one at a time until the measurements return.",
    },
    {
      workload_class: "storage-heavy",
      recommendation: "unknown",
      summary:
        "Large writes and exports cannot be judged from here. Check free disk space yourself before starting one.",
    },
  ];
}

/**
 * Project bounded supervisor history into the trend input the assessment reads.
 * The observer and a bundle replay both call this, so the trend they compute
 * from the same stored history is the same trend.
 */
export function pressureHistoryFromSupervisor(
  points: readonly SupervisorHistoryPoint[],
): PressureHistorySample[] {
  return points.slice(-PRESSURE_POLICY.max_history_samples).map((point) => ({
    sampled_at: point.sampled_at,
    memory_full_avg10: null,
    io_full_avg10: null,
    cpu_some_avg60: null,
    memory_available_percent:
      point.machine.memory_percent === null ? null : 100 - point.machine.memory_percent,
    swap_out_bytes_per_second: null,
  }));
}
