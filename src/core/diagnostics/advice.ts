import type { SupervisorCapability, SupervisorFinding } from "../supervisor/contract.ts";
import {
  DIAGNOSTIC_ADVICE_LIMITS,
  DIAGNOSTIC_ADVICE_SCHEMA_VERSION,
  type DiagnosticAdvice,
  type DiagnosticAdviceFinding,
  type DiagnosticAdviceReason,
} from "./contract.ts";

export interface BuildDiagnosticAdviceInput {
  findings: readonly SupervisorFinding[];
  sourceCapability: SupervisorCapability;
  evaluatedAt: string;
}

const SEVERITY_RANK: Readonly<Record<SupervisorFinding["severity"], number>> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function buildDiagnosticAdvice(input: BuildDiagnosticAdviceInput): DiagnosticAdvice {
  const active = input.findings
    .filter((finding) => finding.state === "opened")
    .sort(compareFindings);
  const pressureFindings = active.filter(
    (finding): finding is SupervisorFinding & { severity: "warning" | "critical" } =>
      finding.severity === "warning" || finding.severity === "critical",
  );
  const critical = pressureFindings.filter((finding) => finding.severity === "critical");
  const warning = pressureFindings.filter((finding) => finding.severity === "warning");
  const sourceAvailable = input.sourceCapability.state === "supported";
  const pressure = critical.length
    ? "critical"
    : warning.length
      ? "elevated"
      : sourceAvailable
        ? "normal"
        : "unknown";
  const fanOutRecommendation =
    pressure === "critical"
      ? "avoid-new-fan-out"
      : pressure === "elevated"
        ? "use-caution"
        : pressure === "normal"
          ? "proceed"
          : "unknown";
  const contributing = pressureFindings.slice(
    0,
    DIAGNOSTIC_ADVICE_LIMITS.max_contributing_findings,
  );
  return {
    schema_version: DIAGNOSTIC_ADVICE_SCHEMA_VERSION,
    evaluated_at: input.evaluatedAt,
    pressure,
    fan_out_recommendation: fanOutRecommendation,
    observer_only: true,
    summary: summaryFor(pressure),
    source_capability: input.sourceCapability,
    active_finding_count: active.length,
    contributing_finding_count: pressureFindings.length,
    omitted_contributing_finding_count: Math.max(0, pressureFindings.length - contributing.length),
    contributing_findings: contributing.map(adviceFinding),
    reasons: reasonsFor(critical, warning, input.sourceCapability),
  };
}

function adviceFinding(
  finding: SupervisorFinding & { severity: "warning" | "critical" },
): DiagnosticAdviceFinding {
  return {
    finding_id: finding.id,
    finding_kind: finding.finding_kind,
    severity: finding.severity,
    summary: finding.summary,
    scope_kind: finding.scope_kind,
    scope_id: finding.scope_id,
    occurrence_count: finding.occurrence_count,
    owner_kind: finding.attribution?.owner_kind,
    owner_id: finding.attribution?.owner_id,
    workload_relationship: finding.workload_context?.relationship,
  };
}

function reasonsFor(
  critical: readonly SupervisorFinding[],
  warning: readonly SupervisorFinding[],
  capability: SupervisorCapability,
): DiagnosticAdviceReason[] {
  const reasons: DiagnosticAdviceReason[] = [];
  if (critical.length) {
    reasons.push({
      code: "critical_findings_active",
      summary: `${critical.length} active critical finding${critical.length === 1 ? "" : "s"} ${critical.length === 1 ? "requires" : "require"} attention.`,
      finding_ids: boundedIds(critical),
    });
  }
  if (warning.length) {
    reasons.push({
      code: "warning_findings_active",
      summary: `${warning.length} active warning finding${warning.length === 1 ? "" : "s"} ${warning.length === 1 ? "indicates" : "indicate"} elevated pressure.`,
      finding_ids: boundedIds(warning),
    });
  }
  if (capability.state !== "supported") {
    reasons.push({
      code: "findings_source_unavailable",
      summary: `The findings source is ${capability.state}${capability.reason_code ? ` (${capability.reason_code})` : ""}.`,
      finding_ids: [],
    });
  }
  if (!critical.length && !warning.length && capability.state === "supported") {
    reasons.push({
      code: "no_active_pressure_findings",
      summary: "No active warning or critical findings were observed.",
      finding_ids: [],
    });
  }
  return reasons.slice(0, DIAGNOSTIC_ADVICE_LIMITS.max_reasons);
}

function boundedIds(findings: readonly SupervisorFinding[]): string[] {
  return findings
    .slice(0, DIAGNOSTIC_ADVICE_LIMITS.max_contributing_findings)
    .map((finding) => finding.id);
}

function summaryFor(pressure: DiagnosticAdvice["pressure"]): string {
  switch (pressure) {
    case "critical":
      return "Critical local pressure is active. Avoid starting additional agent work until the findings change.";
    case "elevated":
      return "Elevated local pressure is active. Limit new fan-out and inspect the contributing findings.";
    case "normal":
      return "No active warning or critical findings were observed. Diagnostics do not restrict new fan-out.";
    case "unknown":
      return "Local pressure cannot be determined because the findings source is unavailable.";
  }
}

function compareFindings(left: SupervisorFinding, right: SupervisorFinding): number {
  return (
    SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
    right.observed_at.localeCompare(left.observed_at) ||
    left.id.localeCompare(right.id)
  );
}
