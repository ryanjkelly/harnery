import { describe, expect, test } from "bun:test";
import {
  hysteresisFixture,
  pressureAssessmentFixture,
} from "../../../tests/helpers/resource-status.ts";
import {
  SUPERVISOR_FINDING_SCHEMA_VERSION,
  type SupervisorCapability,
  type SupervisorFinding,
} from "../supervisor/contract.ts";
import { buildDiagnosticAdvice } from "./advice.ts";
import { compareValidatedDiagnosticBundles } from "./comparison.ts";
import {
  DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
  DIAGNOSTIC_EXPECTED_SCHEMA_VERSION,
  DIAGNOSTIC_INPUT_SCHEMA_VERSION,
  DIAGNOSTIC_SUMMARY_SCHEMA_VERSION,
  type DiagnosticCapturedSource,
  type DiagnosticPressure,
  type ValidatedDiagnosticBundle,
} from "./contract.ts";

describe("diagnostic bundle comparison", () => {
  test("classifies regressions, recoveries, and persistent signal changes deterministically", () => {
    const before = bundle("artifact_before", [
      finding("memory", { severity: "warning", occurrenceCount: 1, peak: 70 }),
      finding("retry", { severity: "warning" }),
      finding("cpu", { severity: "critical", peak: 95 }),
      finding("steady", { severity: "info", state: "resolved" }),
    ]);
    const after = bundle("artifact_after", [
      finding("memory", { severity: "critical", occurrenceCount: 4, peak: 91 }),
      finding("cpu", { severity: "warning", peak: 70 }),
      finding("steady", { severity: "info", state: "resolved" }),
      finding("hook", { severity: "critical" }),
    ]);

    const first = compareValidatedDiagnosticBundles(before, after);
    const second = compareValidatedDiagnosticBundles(before, after);

    expect(first.comparison_digest).toBe(second.comparison_digest);
    expect(first.findings).toMatchObject({
      total: 5,
      regressions: 1,
      worsened: 1,
      improved: 1,
      recoveries: 1,
      unchanged: 1,
    });
    expect(first.findings.rows.map((row) => [row.fingerprint, row.impact])).toEqual([
      ["fp:hook", "regression"],
      ["fp:memory", "worsened"],
      ["fp:cpu", "improved"],
      ["fp:retry", "recovery"],
      ["fp:steady", "unchanged"],
    ]);
    expect(
      first.findings.rows.find((row) => row.fingerprint === "fp:memory")?.field_changes,
    ).toEqual([
      { field: "severity", before: "warning", after: "critical", impact: "worsened" },
      { field: "occurrence_count", before: 1, after: 4, impact: "worsened" },
      { field: "peak_observed_value", before: 70, after: 91, impact: "worsened" },
    ]);
    expect(first.observer_only).toBe(true);
  });

  test("compares bounded hook-health and shadow-admission summaries", () => {
    const before = bundle("artifact_before", [], {
      sources: [hookSource(10, 1, 0, 2_000), admissionSource(["normal", "elevated"])],
    });
    const after = bundle("artifact_after", [], {
      sources: [hookSource(18, 3, 1, 6_000), admissionSource(["critical", "unknown"])],
    });

    const result = compareValidatedDiagnosticBundles(before, after);

    expect(result.hook_health.before).toMatchObject({
      invocation_count: 10,
      degraded_count: 1,
      faulted_count: 0,
      aggregates: [{ key: "codex:pre-tool-use", duration_p95_ms: 2_000 }],
    });
    expect(result.hook_health.after).toMatchObject({
      invocation_count: 18,
      degraded_count: 3,
      faulted_count: 1,
      aggregates: [{ key: "codex:pre-tool-use", duration_p95_ms: 6_000 }],
    });
    expect(result.shadow_admission.before).toMatchObject({
      record_count: 2,
      normal_count: 1,
      elevated_count: 1,
    });
    expect(result.shadow_admission.after).toMatchObject({
      record_count: 2,
      critical_count: 1,
      unknown_count: 1,
      unavailable_count: 1,
    });
    expect(result.warnings).toEqual([]);
    expect(result.comparability).toBe("comparable");
  });

  test("reports threshold, engine, machine, capability, and optional-source gaps", () => {
    const before = bundle("artifact_before", [], {
      thresholdDigest: "threshold-before",
      engineVersion: "build-before",
      machineId: "machine-before",
      capabilities: [{ source_kind: "supervisor.findings", state: "supported" }],
    });
    const after = bundle("artifact_after", [], {
      thresholdDigest: "threshold-after",
      engineVersion: "build-after",
      machineId: "machine-after",
      capabilities: [
        {
          source_kind: "supervisor.findings",
          state: "partial",
          reason_code: "truncated",
        },
      ],
    });

    const result = compareValidatedDiagnosticBundles(before, after);
    expect(result.comparability).toBe("partial");
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "threshold_digest_changed",
      "engine_version_changed",
      "machine_changed",
      "source_capability_changed",
      "hook_health_unavailable",
      "shadow_admission_unavailable",
    ]);
    expect(result.capabilities).toEqual([
      {
        source_kind: "supervisor.findings",
        change: "changed",
        before: { source_kind: "supervisor.findings", state: "supported" },
        after: {
          source_kind: "supervisor.findings",
          state: "partial",
          reason_code: "truncated",
        },
      },
    ]);
  });

  test("uses the newest episode for a duplicate fingerprint and reports the omission", () => {
    const older = finding("memory", { idSuffix: "old", observedAt: "2026-09-01T01:00:00.000Z" });
    const newer = finding("memory", { idSuffix: "new", observedAt: "2026-09-01T02:00:00.000Z" });
    const result = compareValidatedDiagnosticBundles(
      bundle("artifact_before", [older, newer]),
      bundle("artifact_after", [newer]),
    );

    expect(result.warnings.some((warning) => warning.code === "duplicate_fingerprint")).toBe(true);
    expect(result.findings.rows).toHaveLength(1);
    expect(result.findings.rows[0]?.before?.id).toBe("find_memory_new");
  });
});

function bundle(
  artifactId: string,
  findings: readonly SupervisorFinding[],
  options: {
    sources?: readonly DiagnosticCapturedSource[];
    thresholdDigest?: string;
    engineVersion?: string;
    machineId?: string;
    capabilities?: readonly SupervisorCapability[];
    pressure?: DiagnosticPressure;
  } = {},
): ValidatedDiagnosticBundle {
  const capturedAt = artifactId.endsWith("before")
    ? "2026-09-01T03:00:00.000Z"
    : "2026-09-01T04:00:00.000Z";
  const selection = {
    start_at: "2026-09-01T00:00:00.000Z",
    end_at: "2026-09-01T05:00:00.000Z",
  };
  const thresholdDigest = options.thresholdDigest ?? "threshold-same";
  const machineId = options.machineId ?? "machine-same";
  const capabilities: readonly SupervisorCapability[] =
    options.capabilities ?? options.sources?.map(capturedSourceCapability) ?? [];
  const findingsCapability = capabilities.find(
    (row) => row.source_kind === "supervisor.findings",
  ) ?? {
    source_kind: "supervisor.findings",
    state: "supported" as const,
  };
  const advice = buildDiagnosticAdvice({
    assessment: pressureAssessmentFixture({
      state: options.pressure ?? "normal",
      observed_at: capturedAt,
    }),
    priorHysteresis: hysteresisFixture({ state: options.pressure ?? "normal" }),
    sourceCapability: findingsCapability,
    activeFindingCount: findings.filter((row) => row.state === "opened").length,
    evaluatedAt: capturedAt,
  });
  const forcedAdvice = advice;
  return {
    path: `/managed/${artifactId}`,
    manifest: {
      schema_version: DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
      artifact_id: artifactId,
      captured_at: capturedAt,
      machine_id: machineId,
      time_range: selection,
      engine_version: options.engineVersion ?? "build-same",
      threshold_digest: thresholdDigest,
      sources: [],
      capabilities,
      files: [],
      replay: {
        input_file: "inputs/observations.json",
        thresholds_file: "inputs/thresholds.json",
        expected_file: "expected.json",
      },
    },
    observations: {
      schema_version: DIAGNOSTIC_INPUT_SCHEMA_VERSION,
      captured_at: capturedAt,
      selection,
      sources: options.sources ?? [],
    },
    thresholds: { schema_version: DIAGNOSTIC_INPUT_SCHEMA_VERSION, values: {} },
    expected: {
      schema_version: DIAGNOSTIC_EXPECTED_SCHEMA_VERSION,
      threshold_digest: thresholdDigest,
      selection,
      findings,
      timelines: [],
      explanations: [],
      advice: forcedAdvice,
    },
    summary: {
      schema_version: DIAGNOSTIC_SUMMARY_SCHEMA_VERSION,
      artifact_id: artifactId,
      captured_at: capturedAt,
      machine_id: machineId,
      machine_id_kind: "pseudonymous",
      selection,
      source_count: options.sources?.length ?? 0,
      supported_source_count:
        options.sources?.filter((row) => row.capability === "supported").length ?? 0,
      sanitized_value_count: 0,
      omitted_value_count: 0,
      total_bytes: 0,
    },
  };
}

function finding(
  key: string,
  options: {
    idSuffix?: string;
    severity?: SupervisorFinding["severity"];
    state?: SupervisorFinding["state"];
    occurrenceCount?: number;
    peak?: number;
    observedAt?: string;
  } = {},
): SupervisorFinding {
  const observedAt = options.observedAt ?? "2026-09-01T02:00:00.000Z";
  return {
    schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
    id: `find_${key}${options.idSuffix ? `_${options.idSuffix}` : ""}`,
    fingerprint: `fp:${key}`,
    source_kind: "resource.snapshot",
    finding_kind: `test.${key}`,
    finding_class: "contention",
    severity: options.severity ?? "warning",
    state: options.state ?? "opened",
    scope_kind: "machine",
    scope_id: "local",
    summary: `${key} signal`,
    opened_at: "2026-09-01T01:00:00.000Z",
    observed_at: observedAt,
    ...(options.state === "resolved" ? { resolved_at: observedAt } : {}),
    occurrence_count: options.occurrenceCount ?? 1,
    ...(options.peak !== undefined
      ? {
          peak_observed_value: options.peak,
          peak_observed_at: observedAt,
          peak_unit: "percent" as const,
        }
      : {}),
    primary_source: {
      id: `source_${key}`,
      source_kind: "resource.snapshot",
      source_id: "machine:local",
      observed_at: observedAt,
      capability: "supported",
    },
    evidence: [],
    capabilities: [],
  };
}

function hookSource(
  invocationCount: number,
  degradedCount: number,
  faultedCount: number,
  durationP95: number,
): DiagnosticCapturedSource {
  return {
    source_kind: "supervisor.hook-health",
    capability: "supported",
    schema_version: 1,
    value: {
      summary: {
        invocation_count: invocationCount,
        degraded_count: degradedCount,
        faulted_count: faultedCount,
        slow_count: durationP95 >= 30_000 ? 1 : 0,
        high_memory_count: 0,
        retry_count: 0,
      },
      aggregates: [
        {
          key: "codex:pre-tool-use",
          hook_name: "pre-tool-use",
          adapter: "codex",
          invocation_count: invocationCount,
          degraded_count: degradedCount,
          faulted_count: faultedCount,
          retry_count: 0,
          duration_p95_ms: durationP95,
          rss_end_max_bytes: 128 * 1024 * 1024,
        },
      ],
    },
  };
}

function admissionSource(pressures: readonly DiagnosticPressure[]): DiagnosticCapturedSource {
  return {
    source_kind: "workflow.diagnostic-admission",
    capability: "supported",
    schema_version: 1,
    value: {
      records: pressures.map((pressure, index) => ({
        state: "observed",
        pressure,
        freshness: pressure === "unknown" ? "unavailable" : "fresh",
        wait_ms: 20 + index,
      })),
    },
  };
}

function capturedSourceCapability(source: DiagnosticCapturedSource): SupervisorCapability {
  return {
    source_kind: source.source_kind,
    state: source.capability,
    ...(source.reason_code ? { reason_code: source.reason_code } : {}),
  };
}
