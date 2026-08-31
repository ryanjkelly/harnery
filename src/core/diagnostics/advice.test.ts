import { describe, expect, test } from "bun:test";
import {
  SUPERVISOR_FINDING_SCHEMA_VERSION,
  type SupervisorCapability,
  type SupervisorFinding,
} from "../supervisor/contract.ts";
import { buildDiagnosticAdvice } from "./advice.ts";
import { DIAGNOSTIC_ADVICE_LIMITS } from "./contract.ts";

const supported: SupervisorCapability = {
  source_kind: "supervisor.findings",
  state: "supported",
};

describe("diagnostic advice", () => {
  test("allows fan-out when the supported projection has no active pressure findings", () => {
    const advice = buildDiagnosticAdvice({
      findings: [finding("resolved", "critical", "resolved")],
      sourceCapability: supported,
      evaluatedAt: "2026-08-31T09:00:00.000Z",
    });
    expect(advice).toMatchObject({
      pressure: "normal",
      fan_out_recommendation: "proceed",
      observer_only: true,
      active_finding_count: 0,
      contributing_finding_count: 0,
    });
    expect(advice.reasons.map((reason) => reason.code)).toEqual(["no_active_pressure_findings"]);
  });

  test("turns warnings into caution and critical findings into an avoid recommendation", () => {
    const elevated = buildDiagnosticAdvice({
      findings: [finding("warning", "warning")],
      sourceCapability: supported,
      evaluatedAt: "2026-08-31T09:00:00.000Z",
    });
    expect(elevated).toMatchObject({
      pressure: "elevated",
      fan_out_recommendation: "use-caution",
      contributing_finding_count: 1,
    });
    expect(elevated.reasons[0]?.summary).toBe(
      "1 active warning finding indicates elevated pressure.",
    );

    const critical = buildDiagnosticAdvice({
      findings: [finding("warning", "warning"), finding("critical", "critical")],
      sourceCapability: supported,
      evaluatedAt: "2026-08-31T09:00:00.000Z",
    });
    expect(critical).toMatchObject({
      pressure: "critical",
      fan_out_recommendation: "avoid-new-fan-out",
      contributing_finding_count: 2,
    });
    expect(critical.contributing_findings.map((item) => item.finding_id)).toEqual([
      "critical",
      "warning",
    ]);
  });

  test("reports unknown when the projection is unavailable", () => {
    const advice = buildDiagnosticAdvice({
      findings: [],
      sourceCapability: {
        source_kind: "supervisor.findings",
        state: "unsupported",
        reason_code: "source_missing",
      },
      evaluatedAt: "2026-08-31T09:00:00.000Z",
    });
    expect(advice).toMatchObject({
      pressure: "unknown",
      fan_out_recommendation: "unknown",
    });
    expect(advice.reasons.map((reason) => reason.code)).toEqual(["findings_source_unavailable"]);
  });

  test("does not treat findings from an expired projection as current pressure", () => {
    const advice = buildDiagnosticAdvice({
      findings: [finding("critical", "critical")],
      sourceCapability: {
        source_kind: "supervisor.findings",
        state: "expired",
        reason_code: "supervisor_not_running",
      },
      evaluatedAt: "2026-08-31T09:00:00.000Z",
    });
    expect(advice).toMatchObject({
      pressure: "unknown",
      fan_out_recommendation: "unknown",
      active_finding_count: 0,
      contributing_finding_count: 0,
      source_capability: {
        state: "expired",
        reason_code: "supervisor_not_running",
      },
    });
    expect(advice.reasons.map((reason) => reason.code)).toEqual(["findings_source_unavailable"]);
  });

  test("bounds contributors after pressure is calculated", () => {
    const findings = Array.from(
      { length: DIAGNOSTIC_ADVICE_LIMITS.max_contributing_findings + 3 },
      (_, index) => finding(`critical-${index}`, "critical"),
    );
    const advice = buildDiagnosticAdvice({
      findings,
      sourceCapability: supported,
      evaluatedAt: "2026-08-31T09:00:00.000Z",
    });
    expect(advice.pressure).toBe("critical");
    expect(advice.contributing_finding_count).toBe(findings.length);
    expect(advice.contributing_findings).toHaveLength(
      DIAGNOSTIC_ADVICE_LIMITS.max_contributing_findings,
    );
    expect(advice.omitted_contributing_finding_count).toBe(3);
  });
});

function finding(
  id: string,
  severity: SupervisorFinding["severity"],
  state: SupervisorFinding["state"] = "opened",
): SupervisorFinding {
  const observedAt = id === "critical" ? "2026-08-31T09:02:00.000Z" : "2026-08-31T09:01:00.000Z";
  return {
    schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
    id,
    fingerprint: `fingerprint-${id}`,
    source_kind: "resources.process-group",
    finding_kind: "memory-growth",
    severity,
    state,
    scope_kind: "agent",
    scope_id: id,
    summary: `${severity} pressure for ${id}`,
    opened_at: "2026-08-31T09:00:00.000Z",
    observed_at: observedAt,
    resolved_at: state === "resolved" ? observedAt : undefined,
    occurrence_count: 1,
    primary_source: {
      id: `source-${id}`,
      source_kind: "resources.snapshot",
      source_id: id,
      observed_at: observedAt,
      capability: "supported",
    },
    evidence: [],
    capabilities: [{ source_kind: "resources.snapshot", state: "supported" }],
  };
}
