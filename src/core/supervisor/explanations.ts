import { createHash } from "node:crypto";
import {
  SUPERVISOR_DIAGNOSTIC_LIMITS,
  SUPERVISOR_EXPLANATION_SCHEMA_VERSION,
  type SupervisorExplanationStatement,
  type SupervisorFinding,
  type SupervisorFindingExplanation,
  type SupervisorPossibleExplanation,
} from "./contract.ts";

/** Build evidence-linked statements without presenting correlation as causation. */
export function explainSupervisorFinding(finding: SupervisorFinding): SupervisorFindingExplanation {
  const observed = finding.evidence.map((evidence) =>
    statement("observed.source", evidence.summary, [evidence.id]),
  );
  const related = relatedStatements(finding);
  const possible = possibleStatements(finding);
  return {
    schema_version: SUPERVISOR_EXPLANATION_SCHEMA_VERSION,
    finding_id: finding.id,
    generated_at: finding.observed_at,
    observed: observed.slice(0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_explanation_items),
    related: related.slice(0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_explanation_items),
    possible: possible.slice(0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_explanation_items),
    missing_capabilities: finding.capabilities
      .filter((capability) => capability.state !== "supported")
      .slice(0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_capabilities),
  };
}

function relatedStatements(finding: SupervisorFinding): SupervisorExplanationStatement[] {
  const sources = new Set(finding.evidence.map((evidence) => evidence.source.source_kind));
  if (sources.size < 2) return [];
  return [
    statement(
      "related.multi-source",
      `${sources.size} independent source kinds recorded related observations in this finding window.`,
      finding.evidence.map((evidence) => evidence.id),
    ),
  ];
}

function possibleStatements(finding: SupervisorFinding): SupervisorPossibleExplanation[] {
  const evidenceIds = finding.evidence.map((evidence) => evidence.id);
  const possible: SupervisorPossibleExplanation[] = [];
  if (finding.finding_kind.includes("memory")) {
    possible.push({
      ...statement(
        "possible.memory-retention-or-workload",
        "A growing workload, retained objects, or operating-system caching could explain the memory observation; this evidence does not distinguish them.",
        evidenceIds,
      ),
      confidence: "low",
      evidence_against_ids: [],
    });
  } else if (finding.finding_kind.includes("process-pressure")) {
    possible.push({
      ...statement(
        "possible.concurrent-work",
        "Concurrent local work could explain the process count; the finding does not establish which activity caused it.",
        evidenceIds,
      ),
      confidence: "low",
      evidence_against_ids: [],
    });
  } else if (finding.finding_kind === "hook.long-running") {
    possible.push({
      ...statement(
        "possible.hook-stall",
        "The hook may be waiting on I/O or blocked work, but elapsed time alone cannot identify the cause.",
        evidenceIds,
      ),
      confidence: "low",
      evidence_against_ids: [],
    });
  } else if (finding.finding_kind === "coordination.ledger-diagnostic") {
    possible.push({
      ...statement(
        "possible.ledger-write-or-read-boundary",
        "A producer write or reader validation boundary may explain the ledger diagnostic; inspect the referenced V3 record before attributing a cause.",
        evidenceIds,
      ),
      confidence: "low",
      evidence_against_ids: [],
    });
  }
  return possible;
}

function statement(
  code: string,
  summary: string,
  evidenceIds: readonly string[],
): SupervisorExplanationStatement {
  return {
    id: `ex_${createHash("sha256")
      .update(`${code}\u0000${summary}\u0000${evidenceIds.join(",")}`)
      .digest("hex")
      .slice(0, 24)}`,
    code,
    summary: summary.slice(0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_summary_chars),
    evidence_ids: [...evidenceIds].slice(0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_evidence_per_finding),
  };
}
