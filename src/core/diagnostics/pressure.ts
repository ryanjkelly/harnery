/**
 * The deterministic pressure assessment.
 *
 * Two rules shape everything below. State is derived only from contention
 * dimensions the kernel measures, so a large process or a heavy hook can never
 * make the machine look critical on its own; those findings are carried as
 * contributors instead. And a dimension the platform does not expose is
 * reported as unavailable rather than read as healthy, so an unavailable
 * measurement can never pull a known critical signal down to normal.
 *
 * The module is pure. It reads no clock, no filesystem, and no findings store,
 * and it imports only the frozen contract. `now_ms`, `observer_generation`, and
 * `prior` come from the caller, which is what makes a frozen bundle replayable.
 *
 * Every numeric threshold is read from `PRESSURE_POLICY`. The only literals
 * here are unit conversions used to phrase a summary in readable units.
 */

import type { ResourceSnapshot } from "../resources/contract.ts";
import {
  type AssessPressure,
  type AssessPressureInput,
  PRESSURE_ASSESSMENT_SCHEMA_VERSION,
  PRESSURE_POLICY,
  type PressureAssessment,
  type PressureContributor,
  type PressureDimension,
  type PressureEvidenceDimension,
  type PressureFindingInput,
  type PressureHistorySample,
  type PressureHysteresisState,
  type PressureLimitingResource,
  type PressureReason,
  type PressureRecommendedAction,
  type PressureScope,
  type PressureState,
  type PressureTrend,
  type PressureWorkloadClass,
  type PressureWorkloadGuidance,
} from "./pressure-contract.ts";

/** Unit conversions for readable prose, not thresholds. */
const BYTES_PER_MIB = 1_024 * 1_024;
const BYTES_PER_GIB = 1_024 * BYTES_PER_MIB;

/** Report order for evidence, and the tie-break order for the limiting resource. */
const DIMENSION_ORDER: readonly PressureDimension[] = [
  "oom_kills",
  "memory_stall",
  "swap_activity",
  "direct_reclaim",
  "memory_available",
  "io_stall",
  "cpu_stall",
  "disk_available",
  "host_memory",
];

const WORKLOAD_CLASSES: readonly PressureWorkloadClass[] = [
  "lightweight",
  "cpu-heavy",
  "memory-heavy",
  "storage-heavy",
];

const STATE_RANK: Readonly<Record<PressureState, number>> = {
  unknown: -1,
  normal: 0,
  elevated: 1,
  critical: 2,
};

const DIMENSION_RESOURCE: Readonly<Record<PressureDimension, PressureLimitingResource>> = {
  memory_stall: "memory",
  io_stall: "io",
  cpu_stall: "cpu",
  oom_kills: "memory",
  swap_activity: "memory",
  direct_reclaim: "memory",
  memory_available: "memory",
  disk_available: "storage",
  host_memory: "memory",
};

/** The memory-family dimensions direct reclaim needs a companion signal from. */
const MEMORY_COMPANION_DIMENSIONS: readonly PressureDimension[] = [
  "memory_stall",
  "swap_activity",
  "memory_available",
  "oom_kills",
];

interface StallReading {
  avg10: number;
  avg60: number;
}

interface CapacityReading {
  available_percent: number;
  swap_used_percent: number | null;
}

interface DiskReading {
  path: string;
  available_bytes: number;
  used_percent: number | null;
}

interface Readings {
  memory_stall: StallReading | null;
  io_stall: StallReading | null;
  cpu_stall: number | null;
  oom_total_kills: number | null;
  swap_out_bytes_per_second: number | null;
  direct_reclaim_pages_per_second: number | null;
  memory_available: CapacityReading | null;
  disk_available: DiskReading | null;
  host_memory: CapacityReading | null;
  unavailable_reasons: Partial<Record<PressureDimension, string>>;
  /** `host_memory` is only applicable when the snapshot carries a host block. */
  host_applicable: boolean;
}

export const assessPressure: AssessPressure = (input) => {
  const policy = PRESSURE_POLICY;
  const prior = carryPrior(input.prior, input.observer_generation);
  const snapshot = input.snapshot;
  const sampleAgeMs = snapshot ? sampleAge(snapshot, input.now_ms) : null;
  if (!snapshot) {
    return unknownAssessment(input, prior, sampleAgeMs, {
      code: "evidence_unavailable",
      summary: `No resource snapshot is available${input.snapshot_reason ? `, because ${input.snapshot_reason}` : ""}, so no contention dimension can be read.`,
    });
  }
  const staleReason = stalenessReason(sampleAgeMs);
  if (staleReason) return unknownAssessment(input, prior, sampleAgeMs, staleReason);

  const readings = readSnapshot(snapshot, input.now_ms);
  // A snapshot that measures nothing is a gap, never a healthy machine.
  if (
    applicableDimensions(readings.host_applicable).every(
      (dimension) => measuredValue(readings, dimension) === null,
    )
  ) {
    return unknownAssessment(input, prior, sampleAgeMs, {
      code: "evidence_unavailable",
      summary: `The ${snapshot.platform} snapshot exposes no contention dimension, so the machine state cannot be read from it.`,
    });
  }
  const hot = hotDimensions(readings);
  const streaks = advanceStreaks(prior.dimension_streaks, hot, readings);

  const oom = evaluateOom(readings.oom_total_kills, prior, input.now_ms);
  const reasons: PressureReason[] = [];

  if (readings.memory_stall) {
    const stall = readings.memory_stall;
    const count = streaks.memory_stall ?? 0;
    if (stall.avg10 >= policy.memory_stall.critical_avg10) {
      reasons.push({
        code: "memory_full_stall_critical",
        dimension: "memory_stall",
        summary: `All non-idle work stalled on memory for ${percent(stall.avg10)} of the last ten seconds, at or above the critical threshold of ${percent(policy.memory_stall.critical_avg10)}.`,
        observed_value: stall.avg10,
        threshold_value: policy.memory_stall.critical_avg10,
        unit: "percent",
        sample_count: count,
        contributes_to: "critical",
      });
    } else if (
      stall.avg10 >= policy.memory_stall.elevated_avg10 &&
      stall.avg10 > stall.avg60 &&
      count >= policy.memory_stall.elevated_samples
    ) {
      reasons.push({
        code: "memory_full_stall_elevated",
        dimension: "memory_stall",
        summary: `Memory stalls are rising across ${samples(count)}, now ${percent(stall.avg10)} over ten seconds against ${percent(stall.avg60)} over a minute, at or above the elevated threshold of ${percent(policy.memory_stall.elevated_avg10)}.`,
        observed_value: stall.avg10,
        threshold_value: policy.memory_stall.elevated_avg10,
        unit: "percent",
        sample_count: count,
        contributes_to: "elevated",
      });
    }
  }

  if (readings.io_stall) {
    const stall = readings.io_stall;
    const count = streaks.io_stall ?? 0;
    if (stall.avg10 >= policy.io_stall.critical_avg10) {
      reasons.push({
        code: "io_full_stall_critical",
        dimension: "io_stall",
        summary: `All non-idle work stalled on input and output for ${percent(stall.avg10)} of the last ten seconds, at or above the critical threshold of ${percent(policy.io_stall.critical_avg10)}.`,
        observed_value: stall.avg10,
        threshold_value: policy.io_stall.critical_avg10,
        unit: "percent",
        sample_count: count,
        contributes_to: "critical",
      });
    } else if (
      stall.avg10 >= policy.io_stall.elevated_avg10 &&
      stall.avg10 > stall.avg60 &&
      count >= policy.io_stall.elevated_samples
    ) {
      reasons.push({
        code: "io_full_stall_elevated",
        dimension: "io_stall",
        summary: `Input and output stalls are rising across ${samples(count)}, now ${percent(stall.avg10)} over ten seconds against ${percent(stall.avg60)} over a minute, at or above the elevated threshold of ${percent(policy.io_stall.elevated_avg10)}.`,
        observed_value: stall.avg10,
        threshold_value: policy.io_stall.elevated_avg10,
        unit: "percent",
        sample_count: count,
        contributes_to: "elevated",
      });
    }
  }

  if (oom.reason) reasons.push(oom.reason);

  if (readings.swap_out_bytes_per_second !== null) {
    const rate = readings.swap_out_bytes_per_second;
    const count = streaks.swap_activity ?? 0;
    if (
      rate >= policy.swap_activity.critical_out_bytes_per_second &&
      count >= policy.swap_activity.critical_samples
    ) {
      reasons.push({
        code: "swap_out_rate_critical",
        dimension: "swap_activity",
        summary: `The kernel is writing ${mib(rate)} to swap each second and has been swapping for ${samples(count)}, at or above the critical threshold of ${mib(policy.swap_activity.critical_out_bytes_per_second)} each second.`,
        observed_value: rate,
        threshold_value: policy.swap_activity.critical_out_bytes_per_second,
        unit: "bytes-per-second",
        sample_count: count,
        contributes_to: "critical",
      });
    } else if (
      rate >= policy.swap_activity.elevated_out_bytes_per_second &&
      count >= policy.swap_activity.elevated_samples
    ) {
      reasons.push({
        code: "swap_out_rate_elevated",
        dimension: "swap_activity",
        summary: `The kernel has written to swap for ${samples(count)}, now ${mib(rate)} each second, at or above the elevated threshold of ${mib(policy.swap_activity.elevated_out_bytes_per_second)} each second.`,
        observed_value: rate,
        threshold_value: policy.swap_activity.elevated_out_bytes_per_second,
        unit: "bytes-per-second",
        sample_count: count,
        contributes_to: "elevated",
      });
    }
  }

  if (readings.direct_reclaim_pages_per_second !== null) {
    const rate = readings.direct_reclaim_pages_per_second;
    const count = streaks.direct_reclaim ?? 0;
    if (
      rate >= policy.direct_reclaim.elevated_pages_per_second &&
      count >= policy.direct_reclaim.elevated_samples
    ) {
      // Direct reclaim alone is elevated. Paired with another memory signal it
      // is the reclaim storm the incident review calls decisive.
      const companion = reasons.find(
        (reason) =>
          reason.dimension !== null && MEMORY_COMPANION_DIMENSIONS.includes(reason.dimension),
      );
      reasons.push(
        companion
          ? {
              code: "direct_reclaim_with_memory_signal",
              dimension: "direct_reclaim",
              summary: `Processes are reclaiming ${pages(rate)} directly each second across ${samples(count)} while another memory signal is also open, at or above the threshold of ${pages(policy.direct_reclaim.elevated_pages_per_second)} each second.`,
              observed_value: rate,
              threshold_value: policy.direct_reclaim.elevated_pages_per_second,
              unit: "pages-per-second",
              sample_count: count,
              contributes_to: "critical",
            }
          : {
              code: "direct_reclaim_elevated",
              dimension: "direct_reclaim",
              summary: `Processes are reclaiming ${pages(rate)} directly each second across ${samples(count)}, at or above the elevated threshold of ${pages(policy.direct_reclaim.elevated_pages_per_second)} each second.`,
              observed_value: rate,
              threshold_value: policy.direct_reclaim.elevated_pages_per_second,
              unit: "pages-per-second",
              sample_count: count,
              contributes_to: "elevated",
            },
      );
    }
  }

  if (readings.memory_available) {
    const capacity = readings.memory_available;
    const count = streaks.memory_available ?? 0;
    if (
      capacity.available_percent < policy.memory_available.critical_available_percent &&
      capacity.swap_used_percent !== null &&
      capacity.swap_used_percent >= policy.memory_available.critical_swap_used_percent
    ) {
      reasons.push({
        code: "memory_and_swap_exhausted",
        dimension: "memory_available",
        summary: `Only ${percent(capacity.available_percent)} of memory is available and swap is ${percent(capacity.swap_used_percent)} used, so both memory tiers are exhausted against the thresholds of ${percent(policy.memory_available.critical_available_percent)} available and ${percent(policy.memory_available.critical_swap_used_percent)} swap used.`,
        observed_value: capacity.available_percent,
        threshold_value: policy.memory_available.critical_available_percent,
        unit: "percent",
        sample_count: count,
        contributes_to: "critical",
      });
    } else if (
      capacity.available_percent < policy.memory_available.elevated_available_percent &&
      count >= policy.memory_available.elevated_samples
    ) {
      reasons.push({
        code: "memory_available_low",
        dimension: "memory_available",
        summary: `Available memory has stayed under the elevated threshold of ${percent(policy.memory_available.elevated_available_percent)} for ${samples(count)} and is now ${percent(capacity.available_percent)}.`,
        observed_value: capacity.available_percent,
        threshold_value: policy.memory_available.elevated_available_percent,
        unit: "percent",
        sample_count: count,
        contributes_to: "elevated",
      });
    }
  }

  if (readings.cpu_stall !== null) {
    const value = readings.cpu_stall;
    const count = streaks.cpu_stall ?? 0;
    if (
      value >= policy.cpu_stall.elevated_some_avg60 &&
      count >= policy.cpu_stall.elevated_samples
    ) {
      reasons.push({
        code: "cpu_stall_elevated",
        dimension: "cpu_stall",
        summary: `Work has waited on the processor for ${percent(value)} of the last minute across ${samples(count)}, at or above the elevated threshold of ${percent(policy.cpu_stall.elevated_some_avg60)}.`,
        observed_value: value,
        threshold_value: policy.cpu_stall.elevated_some_avg60,
        unit: "percent",
        sample_count: count,
        contributes_to: "elevated",
      });
    }
  }

  if (readings.disk_available) {
    const disk = readings.disk_available;
    const count = streaks.disk_available ?? 0;
    const criticalByBytes = disk.available_bytes < policy.disk.critical_available_bytes;
    const criticalByPercent =
      disk.used_percent !== null && disk.used_percent >= policy.disk.critical_used_percent;
    const elevatedByBytes = disk.available_bytes < policy.disk.elevated_available_bytes;
    const elevatedByPercent =
      disk.used_percent !== null && disk.used_percent >= policy.disk.elevated_used_percent;
    if (criticalByBytes || criticalByPercent) {
      reasons.push({
        code: "disk_space_critical",
        dimension: "disk_available",
        summary: `Filesystem ${disk.path} has ${gib(disk.available_bytes)} available${disk.used_percent === null ? "" : ` and is ${percent(disk.used_percent)} used`}, past the critical thresholds of ${gib(policy.disk.critical_available_bytes)} available and ${percent(policy.disk.critical_used_percent)} used.`,
        observed_value: disk.available_bytes,
        threshold_value: policy.disk.critical_available_bytes,
        unit: "bytes",
        sample_count: count,
        contributes_to: "critical",
      });
    } else if (elevatedByBytes || elevatedByPercent) {
      reasons.push({
        code: "disk_space_low",
        dimension: "disk_available",
        summary: `Filesystem ${disk.path} has ${gib(disk.available_bytes)} available${disk.used_percent === null ? "" : ` and is ${percent(disk.used_percent)} used`}, past the elevated thresholds of ${gib(policy.disk.elevated_available_bytes)} available and ${percent(policy.disk.elevated_used_percent)} used.`,
        observed_value: disk.available_bytes,
        threshold_value: policy.disk.elevated_available_bytes,
        unit: "bytes",
        sample_count: count,
        contributes_to: "elevated",
      });
    }
  }

  // The Windows host is assessed separately so it can raise the combined state
  // without ever masking a guest signal.
  if (readings.host_memory) {
    const host = readings.host_memory;
    const count = streaks.host_memory ?? 0;
    const hostCritical =
      host.available_percent < policy.memory_available.critical_available_percent &&
      host.swap_used_percent !== null &&
      host.swap_used_percent >= policy.memory_available.critical_swap_used_percent;
    const hostElevated =
      host.available_percent < policy.memory_available.elevated_available_percent;
    if (hostCritical || hostElevated) {
      reasons.push({
        code: "host_memory_pressure",
        dimension: "host_memory",
        summary: `The Windows host has ${percent(host.available_percent)} of its memory available${host.swap_used_percent === null ? "" : ` with its page file ${percent(host.swap_used_percent)} used`}, past the threshold of ${percent(hostCritical ? policy.memory_available.critical_available_percent : policy.memory_available.elevated_available_percent)} available.`,
        observed_value: host.available_percent,
        threshold_value: hostCritical
          ? policy.memory_available.critical_available_percent
          : policy.memory_available.elevated_available_percent,
        unit: "percent",
        sample_count: count,
        contributes_to: hostCritical ? "critical" : "elevated",
      });
    }
  }

  const guestReasons = reasons.filter((reason) => reason.dimension !== "host_memory");
  const hostReasons = reasons.filter((reason) => reason.dimension === "host_memory");
  const guestRaw = worstState(guestReasons);
  const hostRaw = worstState(hostReasons);
  const rawState = STATE_RANK[hostRaw] > STATE_RANK[guestRaw] ? hostRaw : guestRaw;

  const exitClear =
    rawState === "normal" &&
    (readings.memory_stall === null ||
      readings.memory_stall.avg10 < policy.memory_stall.exit_avg10) &&
    (readings.io_stall === null || readings.io_stall.avg10 < policy.io_stall.exit_avg10) &&
    !oom.hold_active &&
    !oom.new_kill;
  const transition = applyHysteresis(prior.state, rawState, exitClear, prior);

  if (STATE_RANK[transition.state] > STATE_RANK[rawState]) {
    const required =
      transition.state === "critical"
        ? policy.recovery.critical_exit_samples
        : policy.recovery.elevated_exit_samples;
    reasons.push({
      code: "recovering_within_dwell",
      dimension: null,
      summary: `Current evidence reads ${transition.state === "critical" ? "below critical" : "clear"}, and the state stays ${transition.state} until ${samples(required)} in a row are clear. ${transition.consecutive_clear_samples} of ${required} have been seen.`,
      observed_value: transition.consecutive_clear_samples,
      threshold_value: required,
      unit: "count",
      sample_count: transition.consecutive_clear_samples,
      contributes_to: transition.state,
    });
  }

  const evidence = buildEvidence(readings, streaks);
  const evidenceState = evidenceStateOf(evidence);
  if (evidenceState !== "complete") {
    reasons.push({
      code: "evidence_unavailable",
      dimension: null,
      summary:
        evidenceState === "unavailable"
          ? "No contention dimension is measurable on this platform, so nothing here is evidence of a healthy machine."
          : `${evidence.filter((entry) => entry.state === "unavailable").length} of ${evidence.length} contention dimensions are unavailable, so this reading rests on partial evidence.`,
      observed_value: evidence.filter((entry) => entry.state === "unavailable").length,
      threshold_value: null,
      unit: "count",
      sample_count: 0,
      contributes_to: "unknown",
    });
  }
  if (reasons.length === 0) {
    reasons.push({
      code: "no_contention_evidence",
      dimension: null,
      summary: "Every measurable contention dimension is below its elevated threshold.",
      observed_value: null,
      threshold_value: null,
      unit: null,
      sample_count: transition.consecutive_clear_samples,
      contributes_to: "normal",
    });
  }

  const ordered = orderReasons(reasons);
  const dominant = ordered.find(
    (reason) => reason.dimension !== null && reason.contributes_to === transition.state,
  );
  const limiting = limitingResource(transition.state, dominant?.dimension ?? null);
  const scope =
    STATE_RANK[hostRaw] > STATE_RANK[guestRaw] ? "windows-host" : baseScope(snapshot.namespace);
  const contributors = buildContributors(input.findings);
  const action = recommendedAction(transition.state);
  const unattributed = unattributedMemoryPercent(snapshot);

  return {
    schema_version: PRESSURE_ASSESSMENT_SCHEMA_VERSION,
    observer_only: true,
    state: transition.state,
    scope,
    limiting_resource: limiting,
    trend: computeTrend(input.history, readings, limiting),
    observed_at: snapshot.sampled_at,
    sample_age_ms: sampleAgeMs,
    evidence_state: evidenceState,
    evidence,
    reasons: ordered.slice(0, policy.limits.max_reasons),
    contributors: contributors.kept,
    omitted_contributor_count: contributors.omitted,
    unattributed_memory_percent: unattributed,
    recommended_action: action,
    summary: buildSummary({
      state: transition.state,
      scope,
      limiting,
      action,
      evidenceState,
      findingsCapabilityState: input.findings_capability.state,
      unattributed,
      residualSwapPercent: readings.memory_available?.swap_used_percent ?? null,
      swapOutBytesPerSecond: readings.swap_out_bytes_per_second,
    }),
    guidance: buildGuidance(transition.state, limiting),
    hysteresis: {
      state: transition.state,
      state_since:
        transition.state === prior.state && input.prior?.state_since
          ? input.prior.state_since
          : new Date(input.now_ms).toISOString(),
      consecutive_clear_samples: transition.consecutive_clear_samples,
      dimension_streaks: streaks,
      oom_baseline_total_kills: oom.baseline_total_kills,
      oom_hold_until: oom.hold_until,
      observer_generation: input.observer_generation,
    },
    policy_version: policy.policy_version,
  };
};

/**
 * Carry the prior state forward. An observer generation change restarts every
 * streak and the OOM baseline, because PSI averages and kernel counters restart
 * with the process that reads them. The state itself is carried so a restart
 * cannot turn a known critical machine into a normal one in a single sample.
 */
function carryPrior(
  prior: PressureHysteresisState | null,
  observerGeneration: string,
): PressureHysteresisState {
  if (!prior) {
    return {
      state: "unknown",
      state_since: "",
      consecutive_clear_samples: 0,
      dimension_streaks: {},
      oom_baseline_total_kills: null,
      oom_hold_until: null,
      observer_generation: observerGeneration,
    };
  }
  if (prior.observer_generation !== observerGeneration) {
    return {
      ...prior,
      consecutive_clear_samples: 0,
      dimension_streaks: {},
      oom_baseline_total_kills: null,
      oom_hold_until: null,
      observer_generation: observerGeneration,
    };
  }
  return prior;
}

function sampleAge(snapshot: ResourceSnapshot, nowMs: number): number | null {
  const sampledMs = Date.parse(snapshot.sampled_at);
  if (!Number.isFinite(sampledMs) || !Number.isFinite(nowMs)) return null;
  return Math.round(nowMs - sampledMs);
}

function stalenessReason(ageMs: number | null): { code: "snapshot_stale"; summary: string } | null {
  if (ageMs === null) {
    return {
      code: "snapshot_stale",
      summary: "The resource snapshot carries no readable sample time, so its age cannot be shown.",
    };
  }
  const limit = PRESSURE_POLICY.sample_staleness_ms;
  if (ageMs > limit) {
    return {
      code: "snapshot_stale",
      summary: `The resource snapshot is ${seconds(ageMs)} old, past the freshness limit of ${seconds(limit)}.`,
    };
  }
  if (ageMs < -limit) {
    return {
      code: "snapshot_stale",
      summary: `The resource snapshot is dated ${seconds(-ageMs)} in the future, so the clocks disagree by more than the freshness limit of ${seconds(limit)}.`,
    };
  }
  return null;
}

/**
 * No snapshot, an unreadable sample time, or a stale sample means the machine
 * state is unknown. Contributors are withheld here, because an attribution
 * finding is never evidence about the machine and must not read as one when
 * there is no contention measurement beside it.
 */
function unknownAssessment(
  input: AssessPressureInput,
  prior: PressureHysteresisState,
  sampleAgeMs: number | null,
  gap: { code: "snapshot_stale" | "evidence_unavailable"; summary: string },
): PressureAssessment {
  const snapshot = input.snapshot;
  const dimensions = applicableDimensions(Boolean(snapshot?.host));
  const reasonCode = gap.code;
  const summary = gap.summary;
  const observedAt = snapshot?.sampled_at ?? new Date(input.now_ms).toISOString();
  return {
    schema_version: PRESSURE_ASSESSMENT_SCHEMA_VERSION,
    observer_only: true,
    state: "unknown",
    scope: baseScope(snapshot?.namespace),
    limiting_resource: "unknown",
    trend: "unknown",
    observed_at: observedAt,
    sample_age_ms: sampleAgeMs,
    evidence_state: "unavailable",
    evidence: dimensions.map((dimension) => ({
      dimension,
      state: "unavailable" as const,
      observed_value: null,
      unit: null,
      sample_count: 0,
      reason_code: reasonCode,
    })),
    reasons: [
      {
        code: reasonCode,
        dimension: null,
        summary,
        observed_value: sampleAgeMs,
        threshold_value: PRESSURE_POLICY.sample_staleness_ms,
        unit: "milliseconds",
        sample_count: 0,
        contributes_to: "unknown",
      },
    ],
    contributors: [],
    omitted_contributor_count: 0,
    unattributed_memory_percent: null,
    recommended_action: "unknown",
    summary: `${summary} No owner is named and no recommendation is available until a fresh snapshot arrives.`,
    guidance: WORKLOAD_CLASSES.map((workloadClass) => ({
      workload_class: workloadClass,
      recommendation: "unknown" as const,
      summary: "No guidance is available until a fresh resource snapshot arrives.",
    })),
    hysteresis: {
      state: "unknown",
      state_since:
        prior.state === "unknown" && input.prior?.state_since
          ? input.prior.state_since
          : new Date(input.now_ms).toISOString(),
      consecutive_clear_samples: 0,
      dimension_streaks: {},
      // A stale sample must not discard a kill that is still holding critical.
      oom_baseline_total_kills: prior.oom_baseline_total_kills,
      oom_hold_until: prior.oom_hold_until,
      observer_generation: input.observer_generation,
    },
    policy_version: PRESSURE_POLICY.policy_version,
  };
}

function applicableDimensions(hostPresent: boolean): readonly PressureDimension[] {
  return hostPresent
    ? DIMENSION_ORDER
    : DIMENSION_ORDER.filter((dimension) => dimension !== "host_memory");
}

function readSnapshot(snapshot: ResourceSnapshot, nowMs: number): Readings {
  const unavailable: Partial<Record<PressureDimension, string>> = {};
  const pressure = snapshot.pressure;
  const pressureUsable = pressure?.state === "supported" || pressure?.state === "partial";
  const memoryStall = pressureUsable && pressure.memory_full ? pressure.memory_full : null;
  const ioStall = pressureUsable && pressure.io_full ? pressure.io_full : null;
  const cpuStall = pressureUsable && pressure.cpu ? pressure.cpu.avg60 : null;
  if (!memoryStall)
    unavailable.memory_stall = pressureUsable ? "memory_full_missing" : "psi_unavailable";
  if (!ioStall) unavailable.io_stall = pressureUsable ? "io_full_missing" : "psi_unavailable";
  if (cpuStall === null)
    unavailable.cpu_stall = pressureUsable ? "cpu_some_missing" : "psi_unavailable";

  const oom = snapshot.oom;
  const oomTotal = oom?.state === "supported" && oom.total_kills !== null ? oom.total_kills : null;
  if (oomTotal === null) unavailable.oom_kills = "oom_counter_unavailable";

  const vmstat = snapshot.vmstat;
  const vmstatUsable = vmstat?.state === "supported" || vmstat?.state === "partial";
  const swapOut = vmstatUsable ? vmstat.swap_out_bytes_per_second : null;
  const reclaim = vmstatUsable ? vmstat.direct_reclaim_pages_per_second : null;
  if (swapOut === null)
    unavailable.swap_activity = vmstat?.counters_reset
      ? "reclaim_baseline_restarted"
      : "vmstat_unavailable";
  if (reclaim === null)
    unavailable.direct_reclaim = vmstat?.counters_reset
      ? "reclaim_baseline_restarted"
      : "vmstat_unavailable";

  const machine = snapshot.machine;
  let memoryAvailable: CapacityReading | null = null;
  if (
    machine.memory_total_bytes !== null &&
    machine.memory_total_bytes > 0 &&
    machine.memory_available_bytes !== null
  ) {
    memoryAvailable = {
      available_percent: round2(
        (machine.memory_available_bytes / machine.memory_total_bytes) * 100,
      ),
      swap_used_percent: swapUsedPercent(machine.swap_total_bytes, machine.swap_used_bytes),
    };
  } else {
    unavailable.memory_available = "machine_memory_unavailable";
  }

  const disks = (snapshot.disks ?? []).filter(
    (disk) => disk.state === "supported" && disk.available_bytes !== null,
  );
  let worstDisk: DiskReading | null = null;
  for (const disk of disks) {
    const reading: DiskReading = {
      path: disk.path,
      available_bytes: disk.available_bytes!,
      used_percent: disk.used_percent,
    };
    if (!worstDisk || reading.available_bytes < worstDisk.available_bytes) worstDisk = reading;
  }
  if (!worstDisk) unavailable.disk_available = "disk_capacity_unavailable";

  const host = snapshot.host;
  const hostApplicable = Boolean(host);
  // The host block is collected on its own clock, so it is held to the same
  // freshness limit. A stale host reading must not raise the combined state.
  const hostAgeMs = host ? nowMs - Date.parse(host.sampled_at) : null;
  const hostFresh =
    hostAgeMs !== null &&
    Number.isFinite(hostAgeMs) &&
    Math.abs(hostAgeMs) <= PRESSURE_POLICY.sample_staleness_ms;
  let hostMemory: CapacityReading | null = null;
  if (
    host &&
    hostFresh &&
    (host.state === "supported" || host.state === "partial") &&
    host.machine &&
    host.machine.memory_percent !== null
  ) {
    hostMemory = {
      available_percent: round2(100 - host.machine.memory_percent),
      swap_used_percent: swapUsedPercent(
        host.machine.swap_total_bytes,
        host.machine.swap_used_bytes,
      ),
    };
  } else if (hostApplicable) {
    unavailable.host_memory = hostFresh ? "host_memory_unavailable" : "host_sample_stale";
  }

  return {
    memory_stall: memoryStall ? { avg10: memoryStall.avg10, avg60: memoryStall.avg60 } : null,
    io_stall: ioStall ? { avg10: ioStall.avg10, avg60: ioStall.avg60 } : null,
    cpu_stall: cpuStall,
    oom_total_kills: oomTotal,
    swap_out_bytes_per_second: swapOut,
    direct_reclaim_pages_per_second: reclaim,
    memory_available: memoryAvailable,
    disk_available: worstDisk,
    host_memory: hostMemory,
    unavailable_reasons: unavailable,
    host_applicable: hostApplicable,
  };
}

function swapUsedPercent(total: number | null, used: number | null): number | null {
  if (total === null || used === null || total <= 0) return null;
  return round2((used / total) * 100);
}

/** Whether each dimension currently sits on the hot side of its elevated threshold. */
function hotDimensions(readings: Readings): Partial<Record<PressureDimension, boolean>> {
  const policy = PRESSURE_POLICY;
  const hot: Partial<Record<PressureDimension, boolean>> = {};
  if (readings.memory_stall)
    hot.memory_stall = readings.memory_stall.avg10 >= policy.memory_stall.elevated_avg10;
  if (readings.io_stall) hot.io_stall = readings.io_stall.avg10 >= policy.io_stall.elevated_avg10;
  if (readings.cpu_stall !== null)
    hot.cpu_stall = readings.cpu_stall >= policy.cpu_stall.elevated_some_avg60;
  if (readings.swap_out_bytes_per_second !== null)
    hot.swap_activity =
      readings.swap_out_bytes_per_second >= policy.swap_activity.elevated_out_bytes_per_second;
  if (readings.direct_reclaim_pages_per_second !== null)
    hot.direct_reclaim =
      readings.direct_reclaim_pages_per_second >= policy.direct_reclaim.elevated_pages_per_second;
  if (readings.memory_available)
    hot.memory_available =
      readings.memory_available.available_percent <
      policy.memory_available.elevated_available_percent;
  if (readings.disk_available)
    hot.disk_available =
      readings.disk_available.available_bytes < policy.disk.elevated_available_bytes ||
      (readings.disk_available.used_percent !== null &&
        readings.disk_available.used_percent >= policy.disk.elevated_used_percent);
  if (readings.host_memory)
    hot.host_memory =
      readings.host_memory.available_percent < policy.memory_available.elevated_available_percent;
  return hot;
}

function advanceStreaks(
  prior: Readonly<Partial<Record<PressureDimension, number>>>,
  hot: Partial<Record<PressureDimension, boolean>>,
  readings: Readings,
): Partial<Record<PressureDimension, number>> {
  const next: Partial<Record<PressureDimension, number>> = {};
  for (const dimension of applicableDimensions(readings.host_applicable)) {
    if (dimension === "oom_kills") continue;
    if (!hot[dimension]) continue;
    next[dimension] = (prior[dimension] ?? 0) + 1;
  }
  return next;
}

/**
 * Only an increase over the carried baseline is a new kill. A historical total
 * opens nothing, and a total below the baseline is a counter reset that starts
 * a new baseline rather than a critical state.
 */
function evaluateOom(
  totalKills: number | null,
  prior: PressureHysteresisState,
  nowMs: number,
): {
  baseline_total_kills: number | null;
  hold_until: string | null;
  hold_active: boolean;
  new_kill: boolean;
  reason: PressureReason | null;
} {
  const holdMs = PRESSURE_POLICY.oom.critical_hold_ms;
  const priorHoldMs = prior.oom_hold_until === null ? null : Date.parse(prior.oom_hold_until);
  const holdRemaining =
    priorHoldMs !== null && Number.isFinite(priorHoldMs) ? priorHoldMs - nowMs : null;
  const holdCarried = holdRemaining !== null && holdRemaining > 0;
  if (totalKills === null) {
    return {
      baseline_total_kills: prior.oom_baseline_total_kills,
      hold_until: holdCarried ? prior.oom_hold_until : null,
      hold_active: holdCarried,
      new_kill: false,
      reason: holdCarried ? oomHoldReason(holdRemaining!, holdMs) : null,
    };
  }
  const baseline = prior.oom_baseline_total_kills;
  if (baseline === null) {
    // First reading. A historical total is a baseline, never an incident.
    return {
      baseline_total_kills: totalKills,
      hold_until: holdCarried ? prior.oom_hold_until : null,
      hold_active: holdCarried,
      new_kill: false,
      reason: holdCarried ? oomHoldReason(holdRemaining!, holdMs) : null,
    };
  }
  if (totalKills < baseline) {
    return {
      baseline_total_kills: totalKills,
      hold_until: holdCarried ? prior.oom_hold_until : null,
      hold_active: holdCarried,
      new_kill: false,
      reason: holdCarried ? oomHoldReason(holdRemaining!, holdMs) : null,
    };
  }
  if (totalKills > baseline) {
    const increase = totalKills - baseline;
    return {
      baseline_total_kills: totalKills,
      hold_until: new Date(nowMs + holdMs).toISOString(),
      hold_active: true,
      new_kill: true,
      reason: {
        code: "new_oom_kill",
        dimension: "oom_kills",
        summary: `The kernel killed ${increase === 1 ? "one process" : `${increase} processes`} for memory since the previous sample, and critical is held for ${seconds(holdMs)} after a kill. Work may have been lost.`,
        observed_value: increase,
        threshold_value: 0,
        unit: "count",
        sample_count: 1,
        contributes_to: "critical",
      },
    };
  }
  return {
    baseline_total_kills: baseline,
    hold_until: holdCarried ? prior.oom_hold_until : null,
    hold_active: holdCarried,
    new_kill: false,
    reason: holdCarried ? oomHoldReason(holdRemaining!, holdMs) : null,
  };
}

function oomHoldReason(remainingMs: number, holdMs: number): PressureReason {
  return {
    code: "new_oom_kill",
    dimension: "oom_kills",
    summary: `A recent kernel memory kill still holds the critical state for another ${seconds(remainingMs)} of its ${seconds(holdMs)} window.`,
    observed_value: Math.round(remainingMs),
    threshold_value: holdMs,
    unit: "milliseconds",
    sample_count: 0,
    contributes_to: "critical",
  };
}

function applyHysteresis(
  priorState: PressureState,
  rawState: PressureState,
  exitClear: boolean,
  prior: PressureHysteresisState,
): { state: PressureState; consecutive_clear_samples: number } {
  const policy = PRESSURE_POLICY.recovery;
  const clear = exitClear ? prior.consecutive_clear_samples + 1 : 0;
  if (rawState === "critical") return { state: "critical", consecutive_clear_samples: 0 };
  if (priorState === "critical") {
    return clear >= policy.critical_exit_samples
      ? { state: "elevated", consecutive_clear_samples: 0 }
      : { state: "critical", consecutive_clear_samples: clear };
  }
  if (rawState === "elevated") return { state: "elevated", consecutive_clear_samples: 0 };
  if (priorState === "elevated") {
    return clear >= policy.elevated_exit_samples
      ? { state: "normal", consecutive_clear_samples: 0 }
      : { state: "elevated", consecutive_clear_samples: clear };
  }
  return { state: "normal", consecutive_clear_samples: clear };
}

function buildEvidence(
  readings: Readings,
  streaks: Partial<Record<PressureDimension, number>>,
): readonly PressureEvidenceDimension[] {
  const entries: PressureEvidenceDimension[] = [];
  for (const dimension of applicableDimensions(readings.host_applicable)) {
    const measured = measuredValue(readings, dimension);
    entries.push(
      measured === null
        ? {
            dimension,
            state: "unavailable",
            observed_value: null,
            unit: null,
            sample_count: 0,
            reason_code: readings.unavailable_reasons[dimension] ?? "dimension_unavailable",
          }
        : {
            dimension,
            state: "supported",
            observed_value: measured.value,
            unit: measured.unit,
            sample_count: streaks[dimension] ?? 0,
          },
    );
  }
  return entries.slice(0, PRESSURE_POLICY.limits.max_evidence);
}

function measuredValue(
  readings: Readings,
  dimension: PressureDimension,
): { value: number; unit: PressureEvidenceDimension["unit"] } | null {
  switch (dimension) {
    case "memory_stall":
      return readings.memory_stall && { value: readings.memory_stall.avg10, unit: "percent" };
    case "io_stall":
      return readings.io_stall && { value: readings.io_stall.avg10, unit: "percent" };
    case "cpu_stall":
      return readings.cpu_stall === null ? null : { value: readings.cpu_stall, unit: "percent" };
    case "oom_kills":
      return readings.oom_total_kills === null
        ? null
        : { value: readings.oom_total_kills, unit: "count" };
    case "swap_activity":
      return readings.swap_out_bytes_per_second === null
        ? null
        : { value: readings.swap_out_bytes_per_second, unit: "bytes-per-second" };
    case "direct_reclaim":
      return readings.direct_reclaim_pages_per_second === null
        ? null
        : { value: readings.direct_reclaim_pages_per_second, unit: "pages-per-second" };
    case "memory_available":
      return (
        readings.memory_available && {
          value: readings.memory_available.available_percent,
          unit: "percent",
        }
      );
    case "disk_available":
      return (
        readings.disk_available && {
          value: readings.disk_available.available_bytes,
          unit: "bytes",
        }
      );
    case "host_memory":
      return (
        readings.host_memory && { value: readings.host_memory.available_percent, unit: "percent" }
      );
  }
}

function evidenceStateOf(
  evidence: readonly PressureEvidenceDimension[],
): PressureAssessment["evidence_state"] {
  const supported = evidence.filter((entry) => entry.state === "supported").length;
  if (supported === 0) return "unavailable";
  return supported === evidence.length ? "complete" : "partial";
}

function worstState(reasons: readonly PressureReason[]): PressureState {
  let worst: PressureState = "normal";
  for (const reason of reasons) {
    if (reason.contributes_to === "unknown") continue;
    if (STATE_RANK[reason.contributes_to] > STATE_RANK[worst]) worst = reason.contributes_to;
  }
  return worst;
}

function orderReasons(reasons: readonly PressureReason[]): PressureReason[] {
  return [...reasons].sort((left, right) => {
    const byState = STATE_RANK[right.contributes_to] - STATE_RANK[left.contributes_to];
    if (byState !== 0) return byState;
    return dimensionRank(left.dimension) - dimensionRank(right.dimension);
  });
}

function dimensionRank(dimension: PressureDimension | null): number {
  if (dimension === null) return DIMENSION_ORDER.length;
  return DIMENSION_ORDER.indexOf(dimension);
}

function limitingResource(
  state: PressureState,
  dimension: PressureDimension | null,
): PressureLimitingResource {
  if (state === "unknown") return "unknown";
  if (state === "normal") return "none";
  return dimension === null ? "unknown" : DIMENSION_RESOURCE[dimension];
}

function baseScope(namespace: ResourceSnapshot["namespace"] | undefined): PressureScope {
  return namespace === "wsl" ? "guest" : "native";
}

function recommendedAction(state: PressureState): PressureRecommendedAction {
  if (state === "critical") return "avoid-new-heavy-work";
  if (state === "elevated") return "limit-heavy-work";
  if (state === "normal") return "proceed";
  return "unknown";
}

/**
 * Every opened finding is carried, including contention-class ones. An owner is
 * named only when the finding's attribution is exact, so a guess never reaches
 * an operator as a name.
 */
function buildContributors(findings: readonly PressureFindingInput[]): {
  kept: readonly PressureContributor[];
  omitted: number;
} {
  const opened = findings.filter((finding) => finding.state === "opened");
  const sorted = [...opened].sort((left, right) => {
    const bySeverity = severityRank(right.severity) - severityRank(left.severity);
    if (bySeverity !== 0) return bySeverity;
    const byClass = classRank(left.finding_class) - classRank(right.finding_class);
    if (byClass !== 0) return byClass;
    const byKind = left.finding_kind.localeCompare(right.finding_kind);
    return byKind !== 0 ? byKind : left.id.localeCompare(right.id);
  });
  const limit = PRESSURE_POLICY.limits.max_contributors;
  const kept = sorted.slice(0, limit).map((finding): PressureContributor => {
    const attributed = finding.attribution?.state === "attributed";
    const owner =
      attributed && finding.attribution?.owner_kind && finding.attribution?.owner_id
        ? { owner_kind: finding.attribution.owner_kind, owner_id: finding.attribution.owner_id }
        : {};
    return {
      finding_id: finding.id,
      finding_kind: finding.finding_kind,
      finding_class: finding.finding_class,
      severity: finding.severity,
      summary: finding.summary,
      scope_kind: finding.scope_kind,
      scope_id: finding.scope_id,
      occurrence_count: finding.occurrence_count,
      attribution_state: finding.attribution?.state ?? "unknown",
      attribution_confidence: attributed ? "exact" : "none",
      ...owner,
      ...(finding.workload_context
        ? { workload_relationship: finding.workload_context.relationship }
        : {}),
    };
  });
  return { kept, omitted: Math.max(0, sorted.length - kept.length) };
}

function severityRank(severity: PressureContributor["severity"]): number {
  return severity === "critical" ? 3 : severity === "warning" ? 2 : 1;
}

function classRank(findingClass: PressureContributor["finding_class"]): number {
  return findingClass === "contention" ? 0 : findingClass === "attribution" ? 1 : 2;
}

function unattributedMemoryPercent(snapshot: ResourceSnapshot): number | null {
  const total = snapshot.machine.memory_total_bytes;
  if (total === null || total <= 0) return null;
  const rss = snapshot.groups
    .filter((group) => group.kind === "unattributed")
    .reduce((sum, group) => sum + group.rss_bytes, 0);
  return round2((rss / total) * 100);
}

/**
 * Trend follows one field for the whole window, chosen from what the current
 * sample can measure, so the series never mixes units. It compares the newest
 * reading with the oldest in the bounded window.
 */
function computeTrend(
  history: readonly PressureHistorySample[],
  readings: Readings,
  limiting: PressureLimitingResource,
): PressureTrend {
  const window = history.slice(-PRESSURE_POLICY.max_history_samples);
  const candidates: {
    current: number | null;
    select: (sample: PressureHistorySample) => number | null;
  }[] =
    limiting === "cpu"
      ? [{ current: readings.cpu_stall, select: (sample) => sample.cpu_some_avg60 }]
      : limiting === "io"
        ? [{ current: readings.io_stall?.avg10 ?? null, select: (s) => s.io_full_avg10 }]
        : [
            { current: readings.memory_stall?.avg10 ?? null, select: (s) => s.memory_full_avg10 },
            {
              current: readings.swap_out_bytes_per_second,
              select: (s) => s.swap_out_bytes_per_second,
            },
          ];
  for (const candidate of candidates) {
    if (candidate.current === null) continue;
    const series = [
      ...window.map(candidate.select).filter((value): value is number => value !== null),
      candidate.current,
    ];
    if (series.length < 2) continue;
    const oldest = series[0]!;
    const newest = series[series.length - 1]!;
    if (newest > oldest) return "rising";
    if (newest < oldest) return "falling";
    return "steady";
  }
  return "unknown";
}

function buildSummary(view: {
  state: PressureState;
  scope: PressureScope;
  limiting: PressureLimitingResource;
  action: PressureRecommendedAction;
  evidenceState: PressureAssessment["evidence_state"];
  findingsCapabilityState: string;
  unattributed: number | null;
  residualSwapPercent: number | null;
  swapOutBytesPerSecond: number | null;
}): string {
  const subject =
    view.scope === "guest"
      ? "The Linux guest"
      : view.scope === "windows-host"
        ? "The Windows host"
        : "This machine";
  const resource =
    view.limiting === "memory"
      ? "memory"
      : view.limiting === "cpu"
        ? "processor"
        : view.limiting === "io"
          ? "input and output"
          : view.limiting === "storage"
            ? "storage"
            : "resource";
  const stateClause =
    view.state === "normal"
      ? `${subject} shows no contention evidence.`
      : `${subject} is under ${view.state} ${resource} contention.`;
  const actionClause =
    view.action === "proceed"
      ? "Ordinary work can proceed."
      : view.action === "limit-heavy-work"
        ? "Limit heavy work until the evidence clears."
        : "Do not start new heavy work until the evidence clears.";
  const parts = [stateClause, actionClause];
  if (view.evidenceState === "partial")
    parts.push("Some dimensions are unavailable, so this reading rests on partial evidence.");
  if (view.evidenceState === "unavailable")
    parts.push("No contention dimension is measurable here, so treat the reading as uninformed.");
  if (view.findingsCapabilityState !== "supported")
    parts.push(
      `Contributor evidence is incomplete because the findings source reports ${view.findingsCapabilityState}.`,
    );
  // Residual swap occupancy is reported as a fact and is never a signal on its
  // own, because pages stay in swap long after the reclaim that wrote them.
  if (
    view.residualSwapPercent !== null &&
    view.residualSwapPercent > 0 &&
    view.swapOutBytesPerSecond !== null &&
    view.swapOutBytesPerSecond < PRESSURE_POLICY.swap_activity.elevated_out_bytes_per_second
  )
    parts.push(
      `Swap still holds ${percent(view.residualSwapPercent)} of its pages from earlier reclaim, and the kernel is writing ${mib(view.swapOutBytesPerSecond)} to swap each second now.`,
    );
  if (view.unattributed !== null && view.unattributed > 0)
    parts.push(
      `Processes with no validated owner hold ${percent(view.unattributed)} of machine memory.`,
    );
  return parts.join(" ");
}

/**
 * Guidance differs by the resource a workload consumes, and it never states a
 * safe number of agents, because no measurement here supports that claim.
 */
function buildGuidance(
  state: PressureState,
  limiting: PressureLimitingResource,
): readonly PressureWorkloadGuidance[] {
  const matching: PressureWorkloadClass | null =
    limiting === "cpu"
      ? "cpu-heavy"
      : limiting === "memory"
        ? "memory-heavy"
        : limiting === "storage" || limiting === "io"
          ? "storage-heavy"
          : null;
  return WORKLOAD_CLASSES.map((workloadClass): PressureWorkloadGuidance => {
    if (workloadClass === "lightweight") {
      return {
        workload_class: workloadClass,
        recommendation: "proceed",
        summary:
          state === "normal"
            ? "Reads, small edits, and status commands are safe to run now."
            : "Keep to reads, small edits, and status commands, and expect them to be slower than usual.",
      };
    }
    const recommendation: PressureRecommendedAction =
      state === "normal"
        ? "proceed"
        : state === "critical"
          ? "avoid-new-heavy-work"
          : workloadClass === matching
            ? "avoid-new-heavy-work"
            : "limit-heavy-work";
    return {
      workload_class: workloadClass,
      recommendation,
      summary: heavyGuidance(workloadClass, recommendation),
    };
  });
}

function heavyGuidance(
  workloadClass: PressureWorkloadClass,
  recommendation: PressureRecommendedAction,
): string {
  if (workloadClass === "cpu-heavy") {
    if (recommendation === "proceed") return "Builds and test suites can start now.";
    if (recommendation === "limit-heavy-work")
      return "Let a running build or test suite finish before starting another.";
    return "Do not start another build or test suite until the evidence clears.";
  }
  if (workloadClass === "memory-heavy") {
    if (recommendation === "proceed") return "Browser captures and page QA runs can start now.";
    if (recommendation === "limit-heavy-work")
      return "Let a running browser capture or QA run finish before starting another.";
    return "Do not start another browser capture or QA run until the evidence clears.";
  }
  if (recommendation === "proceed") return "Large writes, exports, and bundles can start now.";
  if (recommendation === "limit-heavy-work")
    return "Keep writes small and let a running export or bundle finish first.";
  return "Do not start a large write, export, or bundle until free space recovers.";
}

function percent(value: number): string {
  return `${trim(value)} percent`;
}

function mib(value: number): string {
  return `${trim(value / BYTES_PER_MIB)} MiB`;
}

function gib(value: number): string {
  return `${trim(value / BYTES_PER_GIB)} GiB`;
}

function pages(value: number): string {
  return `${trim(value)} pages`;
}

function seconds(value: number): string {
  return `${trim(value / 1_000)} seconds`;
}

function samples(count: number): string {
  return count === 1 ? "1 sample" : `${count} samples`;
}

function trim(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
