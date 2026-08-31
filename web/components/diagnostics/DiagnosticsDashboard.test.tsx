import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SUPERVISOR_FINDING_SCHEMA_VERSION,
  type SupervisorFinding,
} from "../../../src/core/supervisor/contract";
import { DiagnosticsDashboard } from "./DiagnosticsDashboard";

const finding: SupervisorFinding = {
  schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
  id: "find_memory",
  fingerprint: "memory",
  source_kind: "resource.snapshot",
  finding_kind: "machine.memory-pressure",
  severity: "critical",
  state: "opened",
  scope_kind: "machine",
  scope_id: "local",
  summary: "Machine memory is under pressure.",
  opened_at: "2026-08-30T20:00:00.000Z",
  observed_at: "2026-08-30T20:01:00.000Z",
  occurrence_count: 3,
  peak_observed_value: 91,
  peak_observed_at: "2026-08-30T20:01:00.000Z",
  peak_unit: "percent",
  attribution: {
    state: "unattributed",
    reason_code: "no-validated-process-anchor",
  },
  workload_context: {
    relationship: "unexpected-idle-growth",
    declared_activity: "idle",
    task_state: "active",
    observed_at: "2026-08-30T20:01:00.000Z",
    source: {
      id: "src_activity",
      source_kind: "coordination.activity-projection",
      source_id: "inst_agent:gen_test",
      observed_at: "2026-08-30T20:01:00.000Z",
      capability: "supported",
    },
  },
  primary_source: {
    id: "src_memory",
    source_kind: "resource.snapshot",
    source_id: "linux:local",
    observed_at: "2026-08-30T20:01:00.000Z",
    capability: "supported",
  },
  evidence: [],
  capabilities: [{ source_kind: "process.io", state: "unsupported", reason_code: "platform" }],
};

describe("DiagnosticsDashboard", () => {
  test("renders semantic unvirtualized findings and explicit evidence tiers", () => {
    const html = renderToStaticMarkup(
      <DiagnosticsDashboard
        model={{
          mode: "live",
          findings: [finding],
          selectedFinding: finding,
          capabilities: finding.capabilities,
          timeline: {
            schema_version: 1,
            finding_id: finding.id,
            start_at: finding.opened_at,
            end_at: finding.observed_at,
            max_entries: 160,
            omitted_entries: 0,
            capabilities: [],
            entries: [
              {
                id: "timeline_memory",
                occurred_at: finding.observed_at,
                relation: "observed",
                summary: "Memory crossed the threshold.",
                source: finding.primary_source,
              },
            ],
          },
          explanation: {
            schema_version: 1,
            finding_id: finding.id,
            generated_at: finding.observed_at,
            observed: [{ id: "obs", code: "memory", summary: "Memory is high.", evidence_ids: [] }],
            related: [],
            possible: [
              {
                id: "possible",
                code: "growth",
                summary: "A process may be growing.",
                evidence_ids: [],
                confidence: "low",
                evidence_against_ids: [],
              },
            ],
            missing_capabilities: finding.capabilities,
          },
        }}
        filters={{ finding: finding.id }}
        basePath="/diagnostics"
        binName="harn"
      />,
    );

    expect(html).toContain("<ol");
    expect(html).toContain('aria-label="Diagnostic findings"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('data-diagnostics-mode="live"');
    expect(html).toContain('data-finding-id="find_memory"');
    expect(html).toContain('data-explanation-tier="possible"');
    expect(html).toContain('data-capability-state="unsupported"');
    expect(html).toContain("motion-reduce:transition-none");
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).toContain('href="/resources"');
    expect(html).toContain("Observed");
    expect(html).toContain("Related");
    expect(html).toContain("Hypotheses, not causes");
    expect(html).toContain("unsupported");
    expect(html).toContain("harn diagnostics capture --finding find_memory");
    expect(html).toContain("Occurrences");
    expect(html).toContain("91%");
    expect(html).toContain("Unattributed · no validated process anchor");
    expect(html).toContain("unexpected idle growth · idle · active");
  });

  test("labels frozen evidence and omits the live capture handoff", () => {
    const html = renderToStaticMarkup(
      <DiagnosticsDashboard
        model={{
          mode: "frozen",
          findings: [finding],
          selectedFinding: finding,
          capabilities: [],
          capturedAt: finding.observed_at,
          bundle: {
            schema_version: 2,
            artifact_id: "artifact_bundle",
            captured_at: finding.observed_at,
            machine_id: "machine_hash",
            time_range: { start_at: finding.opened_at, end_at: finding.observed_at },
            engine_version: "test",
            threshold_digest: "digest",
            sources: [],
            capabilities: [],
            files: [],
            replay: {
              input_file: "inputs/observations.json",
              thresholds_file: "inputs/thresholds.json",
              expected_file: "expected.json",
            },
          },
        }}
        filters={{}}
        basePath="/diagnostics/bundles/artifact_bundle"
        binName="harn"
      />,
    );

    expect(html).toContain("Frozen bundle");
    expect(html).toContain("does not read or merge current supervisor state");
    expect(html).not.toContain("diagnostics capture --finding");
  });

  test("keeps the findings list visible for an unavailable selection", () => {
    const html = renderToStaticMarkup(
      <DiagnosticsDashboard
        model={{ mode: "live", findings: [finding], capabilities: [] }}
        filters={{ finding: "__invalid_selection__" }}
        basePath="/diagnostics"
        binName="harn"
      />,
    );

    expect(html.replaceAll("\u00a0", " ")).toContain("Machine memory is under pressure.");
    expect(html).toContain("requested finding is unavailable");
    expect(html).not.toContain('aria-current="true"');
  });
});
