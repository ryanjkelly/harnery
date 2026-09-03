import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// `AgentChip` is an interactive client leaf that reads the app router. Static
// rendering has no router, so the test supplies one.
mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/resources",
  useSearchParams: () => new URLSearchParams(),
}));

import { unknownPressureAssessment } from "../../../src/core/diagnostics/advice";
import type { PressureAssessment } from "../../../src/core/diagnostics/contract";
import { pressureAssessmentFixture } from "../../../tests/helpers/resource-status";
import { PressureSummaryCard } from "./PressureSummaryCard";

const supported = { source_kind: "supervisor.pressure", state: "supported" as const };

describe("PressureSummaryCard", () => {
  test("shows state, scope, trend, evidence age, limiting resource, and the action", () => {
    const html = renderToStaticMarkup(
      <PressureSummaryCard
        assessment={pressureAssessmentFixture({
          state: "critical",
          scope: "guest",
          trend: "rising",
          limiting_resource: "memory",
          sample_age_ms: 2_000,
          recommended_action: "avoid-new-heavy-work",
          summary: "Memory is contended, so do not start new heavy work.",
        })}
        capability={supported}
      />,
    );
    expect(html).toContain('data-pressure-summary="critical"');
    expect(html).toContain("Memory is contended, so do not start new heavy work.");
    expect(html).toContain("guest scope");
    expect(html).toContain("recommended: avoid-new-heavy-work");
    expect(html).toContain("Trend");
    expect(html).toContain("rising");
    expect(html).toContain("Evidence age");
    expect(html).toContain("2 seconds");
    expect(html).toContain("Limiting resource");
  });

  test("renders an unavailable dimension as unavailable, never as healthy", () => {
    const assessment: PressureAssessment = pressureAssessmentFixture({
      evidence_state: "partial",
      evidence: [
        {
          dimension: "memory_stall",
          state: "supported",
          observed_value: 12,
          unit: "percent",
          sample_count: 3,
        },
        {
          dimension: "swap_activity",
          state: "unavailable",
          observed_value: null,
          unit: null,
          sample_count: 0,
          reason_code: "evidence_unavailable",
        },
      ],
    });
    const html = renderToStaticMarkup(
      <PressureSummaryCard assessment={assessment} capability={supported} />,
    );
    expect(html).toContain("swap activity: unavailable");
    expect(html).toContain("memory stall: 12%");
    expect(html).toContain("Evidence is partial");
  });

  test("names an owner only when the contributor attribution is exact", () => {
    const html = renderToStaticMarkup(
      <PressureSummaryCard
        assessment={pressureAssessmentFixture({
          unattributed_memory_percent: 31,
          contributors: [
            {
              finding_id: "finding:a",
              finding_kind: "process.memory-pressure",
              finding_class: "attribution",
              severity: "warning",
              summary: "One process holds 1.2 GiB.",
              scope_kind: "process",
              scope_id: "11",
              occurrence_count: 1,
              attribution_state: "attributed",
              attribution_confidence: "exact",
              owner_kind: "agent",
              owner_id: "agent-Named",
            },
            {
              finding_id: "finding:b",
              finding_kind: "group.memory-pressure",
              finding_class: "attribution",
              severity: "warning",
              summary: "An unowned group holds 2 GiB.",
              scope_kind: "group",
              scope_id: "22",
              occurrence_count: 1,
              attribution_state: "unattributed",
              attribution_confidence: "none",
              owner_kind: "agent",
              owner_id: "agent-Guessed",
            },
          ],
          omitted_contributor_count: 2,
        })}
        capability={supported}
      />,
    );
    expect(html).toContain("Named");
    expect(html).not.toContain("Guessed");
    expect(html).toContain("no validated owner");
    expect(html).toContain("31% of machine memory has no validated owner");
    expect(html).toContain("2 further contributors were omitted");
  });

  test("marks an unavailable assessment as unknown and states the source gap", () => {
    const html = renderToStaticMarkup(
      <PressureSummaryCard
        assessment={unknownPressureAssessment({
          observedAt: "2026-09-03T09:00:00.000Z",
          reasonCode: "evidence_unavailable",
          summary:
            "Local resource pressure cannot be determined because the observer has not published an assessment yet.",
        })}
        capability={{
          source_kind: "supervisor.pressure",
          state: "unsupported",
          reason_code: "pressure_record_missing",
        }}
      />,
    );
    expect(html).toContain('data-pressure-summary="unknown"');
    expect(html).toContain("cannot be determined");
    expect(html).toContain("pressure_record_missing");
    expect(html).toContain("Evidence is unavailable");
    expect(html).not.toContain(">normal<");
    expect(html).not.toContain(">elevated<");
    expect(html).not.toContain(">critical<");
  });

  test("labels guidance by the work each entry is about", () => {
    const html = renderToStaticMarkup(
      <PressureSummaryCard assessment={pressureAssessmentFixture()} capability={supported} />,
    );
    for (const label of [
      "Reads and small edits",
      "Builds and test runs",
      "Browser captures and page QA",
      "Large writes and exports",
    ]) {
      expect(html).toContain(label);
    }
  });
});
