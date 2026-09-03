import { describe, expect, test } from "bun:test";
import {
  hysteresisFixture,
  pressureAssessmentFixture,
} from "../../../tests/helpers/resource-status.ts";
import type { SupervisorCapability, SupervisorHistoryPoint } from "../supervisor/contract.ts";
import {
  buildDiagnosticAdvice,
  PRESSURE_DIMENSIONS,
  pressureHistoryFromSupervisor,
  unknownPressureAssessment,
} from "./advice.ts";
import { DIAGNOSTIC_ADVICE_SCHEMA_VERSION, PRESSURE_POLICY } from "./contract.ts";

const supported: SupervisorCapability = {
  source_kind: "supervisor.pressure",
  state: "supported",
};

describe("diagnostic advice", () => {
  test("carries the assessment it was given without recomputing any state", () => {
    const assessment = pressureAssessmentFixture({ state: "critical" });
    const prior = hysteresisFixture({ state: "elevated" });
    const advice = buildDiagnosticAdvice({
      assessment,
      priorHysteresis: prior,
      sourceCapability: supported,
      activeFindingCount: 4,
      evaluatedAt: "2026-09-03T09:00:12.000Z",
    });
    expect(advice).toEqual({
      schema_version: DIAGNOSTIC_ADVICE_SCHEMA_VERSION,
      evaluated_at: "2026-09-03T09:00:12.000Z",
      observer_only: true,
      assessment,
      prior_hysteresis: prior,
      source_capability: supported,
      active_finding_count: 4,
      summary: assessment.summary,
    });
  });

  test("does not let a critical attribution finding raise the reported state", () => {
    // The defect this replaced: a 1 GiB process opened a critical finding and
    // advice reported machine-wide critical while no kernel signal was set.
    const assessment = pressureAssessmentFixture({
      state: "normal",
      contributors: [
        {
          finding_id: "finding:process.memory-pressure",
          finding_kind: "process.memory-pressure",
          finding_class: "attribution",
          severity: "critical",
          summary: "One process holds 1.2 GiB.",
          scope_kind: "process",
          scope_id: "4242",
          occurrence_count: 3,
          attribution_state: "attributed",
          attribution_confidence: "exact",
          owner_kind: "agent",
          owner_id: "agent-Fixture",
        },
      ],
    });
    const advice = buildDiagnosticAdvice({
      assessment,
      priorHysteresis: null,
      sourceCapability: supported,
      activeFindingCount: 1,
      evaluatedAt: "2026-09-03T09:00:12.000Z",
    });
    expect(advice.assessment.state).toBe("normal");
    expect(advice.assessment.recommended_action).toBe("proceed");
    expect(advice.assessment.contributors[0]?.severity).toBe("critical");
  });

  test("reports an unknown assessment when the published source is unavailable", () => {
    const assessment = unknownPressureAssessment({
      observedAt: "2026-09-03T09:00:12.000Z",
      reasonCode: "evidence_unavailable",
      summary:
        "Local resource pressure cannot be determined because the observer has not published an assessment yet.",
    });
    const advice = buildDiagnosticAdvice({
      assessment,
      priorHysteresis: null,
      sourceCapability: {
        source_kind: "supervisor.pressure",
        state: "unsupported",
        reason_code: "pressure_record_missing",
      },
      activeFindingCount: 0,
      evaluatedAt: "2026-09-03T09:00:12.000Z",
    });
    expect(advice.assessment.state).toBe("unknown");
    expect(advice.assessment.recommended_action).toBe("unknown");
    expect(advice.assessment.evidence_state).toBe("unavailable");
    expect(advice.assessment.evidence).toHaveLength(PRESSURE_DIMENSIONS.length);
    expect(advice.assessment.evidence.every((row) => row.state === "unavailable")).toBe(true);
    expect(advice.assessment.contributors).toEqual([]);
    expect(advice.assessment.guidance.map((row) => row.workload_class)).toEqual([
      "lightweight",
      "cpu-heavy",
      "memory-heavy",
      "storage-heavy",
    ]);
    expect(advice.summary).toContain("cannot be determined");
  });

  test("keeps the unknown assessment inside the policy limits", () => {
    const assessment = unknownPressureAssessment({
      observedAt: "2026-09-03T09:00:12.000Z",
      reasonCode: "snapshot_stale",
      summary: "Local resource pressure cannot be determined because the sample is 40 seconds old.",
    });
    expect(assessment.evidence.length).toBeLessThanOrEqual(PRESSURE_POLICY.limits.max_evidence);
    expect(assessment.reasons.length).toBeLessThanOrEqual(PRESSURE_POLICY.limits.max_reasons);
    expect(assessment.hysteresis.state).toBe("unknown");
    expect(assessment.policy_version).toBe(PRESSURE_POLICY.policy_version);
  });

  test("projects bounded supervisor history into trend samples", () => {
    const points: SupervisorHistoryPoint[] = Array.from({ length: 20 }, (_, index) => ({
      sampled_at: new Date(Date.UTC(2026, 8, 3, 9, 0, index)).toISOString(),
      machine: {
        cpu_percent: 10,
        memory_percent: 40 + index,
        memory_used_bytes: null,
        swap_used_bytes: null,
        process_count: null,
      },
      groups: [],
    }));
    const samples = pressureHistoryFromSupervisor(points);
    expect(samples).toHaveLength(PRESSURE_POLICY.max_history_samples);
    expect(samples.at(-1)?.memory_available_percent).toBe(100 - 59);
    expect(samples.at(-1)?.memory_full_avg10).toBeNull();
  });
});
