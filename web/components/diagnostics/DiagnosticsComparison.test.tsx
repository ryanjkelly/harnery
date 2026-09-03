import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiagnosticBundleComparison } from "../../../src/core/diagnostics/contract";
import { SUPERVISOR_FINDING_SCHEMA_VERSION } from "../../../src/core/supervisor/contract";
import { pressureAssessmentFixture } from "../../../tests/helpers/resource-status";
import { DiagnosticsComparison } from "./DiagnosticsComparison";

describe("DiagnosticsComparison", () => {
  test("renders every frozen signal and optional evidence source semantically", () => {
    const html = renderToStaticMarkup(
      <DiagnosticsComparison comparison={fixtureComparison()} binName="harn" />,
    );

    expect(html).toContain('data-diagnostics-comparison="digest-comparison"');
    expect(html).toContain('aria-label="Diagnostic comparison findings"');
    expect(html).toContain('data-comparison-impact="regression"');
    expect(html).toContain("Memory pressure opened.");
    expect(html).toContain("Completed hook health");
    expect(html).toContain("Shadow admission");
    expect(html).toContain("threshold_digest_changed");
    expect(html).toContain("harn diagnostics compare artifact_before artifact_after");
    expect(html).toContain("motion-reduce:transition-none");
    expect(html).toContain("Before episode");
    expect(html).toContain("After episode");
    expect(html).toContain("Observer only");
  });
});

function fixtureComparison(): DiagnosticBundleComparison {
  const observedAt = "2026-09-01T04:00:00.000Z";
  const finding = {
    schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
    id: "find_memory_after",
    fingerprint: "fp:memory",
    source_kind: "resource.snapshot",
    finding_kind: "machine.memory-pressure",
    finding_class: "contention" as const,
    severity: "critical" as const,
    state: "opened" as const,
    scope_kind: "machine",
    scope_id: "local",
    summary: "Memory pressure opened.",
    opened_at: observedAt,
    observed_at: observedAt,
    occurrence_count: 2,
    primary_source: {
      id: "source_memory",
      source_kind: "resource.snapshot",
      source_id: "machine:local",
      observed_at: observedAt,
      capability: "supported" as const,
    },
    evidence: [],
    capabilities: [],
  };
  const advice = {
    schema_version: 2 as const,
    evaluated_at: observedAt,
    observer_only: true as const,
    assessment: pressureAssessmentFixture({
      state: "critical",
      limiting_resource: "memory",
      recommended_action: "avoid-new-heavy-work",
      observed_at: observedAt,
      summary: "Memory is contended, so do not start new heavy work.",
    }),
    prior_hysteresis: null,
    source_capability: { source_kind: "supervisor.pressure", state: "supported" as const },
    active_finding_count: 1,
    summary: "Memory is contended, so do not start new heavy work.",
  };
  return {
    schema_version: 1,
    observer_only: true,
    before: {
      artifact_id: "artifact_before",
      captured_at: "2026-09-01T03:00:00.000Z",
      machine_id: "machine",
      engine_version: "before-build",
      threshold_digest: "before-threshold",
      finding_count: 1,
      pressure: "elevated",
    },
    after: {
      artifact_id: "artifact_after",
      captured_at: observedAt,
      machine_id: "machine",
      engine_version: "after-build",
      threshold_digest: "after-threshold",
      finding_count: 1,
      pressure: "critical",
    },
    comparability: "partial",
    warnings: [
      {
        code: "threshold_digest_changed",
        summary: "Finding thresholds changed between captures.",
      },
    ],
    advice: {
      before: {
        ...advice,
        assessment: pressureAssessmentFixture({
          state: "elevated",
          limiting_resource: "memory",
          recommended_action: "limit-heavy-work",
          observed_at: observedAt,
          summary: "Memory stalls are rising, so limit new heavy work.",
        }),
        summary: "Memory stalls are rising, so limit new heavy work.",
      },
      after: advice,
      direction: "escalated",
    },
    findings: {
      total: 1,
      regressions: 1,
      worsened: 0,
      changed: 0,
      improved: 0,
      recoveries: 0,
      unchanged: 0,
      rows: [
        {
          fingerprint: finding.fingerprint,
          change_class: "persistent",
          impact: "regression",
          before: { ...finding, id: "find_memory_before", severity: "warning" },
          after: finding,
          field_changes: [
            {
              field: "severity",
              before: "warning",
              after: "critical",
              impact: "worsened",
            },
          ],
        },
      ],
    },
    capabilities: [
      {
        source_kind: "supervisor.findings",
        change: "changed",
        before: { source_kind: "supervisor.findings", state: "partial" },
        after: { source_kind: "supervisor.findings", state: "supported" },
      },
    ],
    hook_health: {
      before_capability: { source_kind: "supervisor.hook-health", state: "supported" },
      after_capability: { source_kind: "supervisor.hook-health", state: "supported" },
      before: {
        invocation_count: 4,
        degraded_count: 0,
        faulted_count: 0,
        slow_count: 0,
        high_memory_count: 0,
        retry_count: 0,
        aggregates: [],
      },
      after: {
        invocation_count: 8,
        degraded_count: 1,
        faulted_count: 0,
        slow_count: 0,
        high_memory_count: 0,
        retry_count: 1,
        aggregates: [],
      },
    },
    shadow_admission: {
      before_capability: {
        source_kind: "workflow.diagnostic-admission",
        state: "supported",
      },
      after_capability: {
        source_kind: "workflow.diagnostic-admission",
        state: "supported",
      },
      before: {
        record_count: 1,
        observed_count: 1,
        not_needed_count: 0,
        unavailable_count: 0,
        normal_count: 0,
        elevated_count: 1,
        critical_count: 0,
        unknown_count: 0,
        max_wait_ms: 20,
      },
      after: {
        record_count: 1,
        observed_count: 1,
        not_needed_count: 0,
        unavailable_count: 0,
        normal_count: 0,
        elevated_count: 0,
        critical_count: 1,
        unknown_count: 0,
        max_wait_ms: 30,
      },
    },
    comparison_digest: "digest-comparison",
  };
}
