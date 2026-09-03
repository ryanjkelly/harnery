import type { SupervisorCapability, SupervisorFinding } from "../supervisor/contract.ts";
import { validateDiagnosticBundle } from "./bundle.ts";
import {
  DIAGNOSTIC_COMPARISON_SCHEMA_VERSION,
  type DiagnosticBundleComparison,
  type DiagnosticBundleComparisonRef,
  type DiagnosticCapabilityComparison,
  type DiagnosticComparisonImpact,
  type DiagnosticComparisonWarning,
  type DiagnosticFindingComparison,
  type DiagnosticFindingFieldChange,
  type DiagnosticHookAggregateSummary,
  type DiagnosticHookHealthSummary,
  type DiagnosticOptionalSourceComparison,
  type DiagnosticPressure,
  type DiagnosticShadowAdmissionSummary,
  type ValidatedDiagnosticBundle,
} from "./contract.ts";
import { canonicalJson, sha256 } from "./replay.ts";

const HOOK_SOURCE = "supervisor.hook-health";
const ADMISSION_SOURCE = "workflow.diagnostic-admission";

export function compareDiagnosticBundles(
  repoRoot: string,
  beforeRef: string,
  afterRef: string,
): DiagnosticBundleComparison {
  return compareValidatedDiagnosticBundles(
    validateDiagnosticBundle(repoRoot, beforeRef),
    validateDiagnosticBundle(repoRoot, afterRef),
  );
}

export function compareValidatedDiagnosticBundles(
  before: ValidatedDiagnosticBundle,
  after: ValidatedDiagnosticBundle,
): DiagnosticBundleComparison {
  const warnings: DiagnosticComparisonWarning[] = [];
  if (before.manifest.threshold_digest !== after.manifest.threshold_digest) {
    warnings.push({
      code: "threshold_digest_changed",
      summary: "Finding thresholds changed between captures.",
    });
  }
  if (before.manifest.engine_version !== after.manifest.engine_version) {
    warnings.push({
      code: "engine_version_changed",
      summary: "The captures were produced by different Harnery builds.",
    });
  }
  if (before.manifest.machine_id !== after.manifest.machine_id) {
    warnings.push({
      code: "machine_changed",
      summary: "The captures came from different pseudonymous machines.",
    });
  }
  if (Date.parse(after.manifest.captured_at) < Date.parse(before.manifest.captured_at)) {
    warnings.push({
      code: "capture_order_reversed",
      summary: "The after capture predates the before capture.",
    });
  }

  const beforeIndex = indexFindings(before.expected.findings);
  const afterIndex = indexFindings(after.expected.findings);
  if (beforeIndex.duplicateCount + afterIndex.duplicateCount > 0) {
    warnings.push({
      code: "duplicate_fingerprint",
      summary: `${beforeIndex.duplicateCount + afterIndex.duplicateCount} older finding episode(s) shared a fingerprint and were omitted.`,
    });
  }

  const capabilities = compareCapabilities(before, after);
  if (capabilities.some((row) => row.change !== "unchanged")) {
    warnings.push({
      code: "source_capability_changed",
      summary: "One or more captured source capabilities changed.",
    });
  }

  const hookHealth = optionalSourceComparison(before, after, HOOK_SOURCE, hookHealthSummary);
  if (!hookHealth.before || !hookHealth.after) {
    warnings.push({
      code: "hook_health_unavailable",
      summary:
        "Completed-hook comparison is partial because one or both bundles lack hook-health evidence.",
    });
  }
  const shadowAdmission = optionalSourceComparison(
    before,
    after,
    ADMISSION_SOURCE,
    shadowAdmissionSummary,
  );
  if (!shadowAdmission.before || !shadowAdmission.after) {
    warnings.push({
      code: "shadow_admission_unavailable",
      summary:
        "Shadow-admission comparison is partial because one or both bundles lack admission evidence.",
    });
  }

  const rows = compareFindings(beforeIndex.rows, afterIndex.rows);
  const base = {
    schema_version: DIAGNOSTIC_COMPARISON_SCHEMA_VERSION,
    observer_only: true as const,
    before: bundleRef(before),
    after: bundleRef(after),
    comparability: warnings.length === 0 ? ("comparable" as const) : ("partial" as const),
    warnings,
    advice: {
      before: before.expected.advice,
      after: after.expected.advice,
      direction: adviceDirection(
        before.expected.advice.assessment.state,
        after.expected.advice.assessment.state,
      ),
    },
    findings: {
      total: rows.length,
      regressions: countImpact(rows, "regression"),
      worsened: countImpact(rows, "worsened"),
      changed: countImpact(rows, "changed"),
      improved: countImpact(rows, "improved"),
      recoveries: countImpact(rows, "recovery"),
      unchanged: countImpact(rows, "unchanged"),
      rows,
    },
    capabilities,
    hook_health: hookHealth,
    shadow_admission: shadowAdmission,
  };
  return {
    ...base,
    comparison_digest: sha256(canonicalJson(base)),
  };
}

export function renderDiagnosticBundleComparison(comparison: DiagnosticBundleComparison): string {
  const lines = [
    `diagnostic comparison: ${comparison.before.artifact_id} -> ${comparison.after.artifact_id}`,
    `comparability: ${comparison.comparability}; pressure: ${comparison.before.pressure} -> ${comparison.after.pressure} (${comparison.advice.direction})`,
    `recommended action: ${comparison.advice.before.assessment.recommended_action} -> ${comparison.advice.after.assessment.recommended_action}; limiting resource: ${comparison.advice.before.assessment.limiting_resource} -> ${comparison.advice.after.assessment.limiting_resource}`,
    `findings: ${comparison.findings.regressions} regression, ${comparison.findings.worsened} worsened, ${comparison.findings.changed} changed, ${comparison.findings.improved} improved, ${comparison.findings.recoveries} recovery, ${comparison.findings.unchanged} unchanged`,
  ];
  if (comparison.warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of comparison.warnings)
      lines.push(`  - ${warning.code}: ${warning.summary}`);
  }
  if (comparison.findings.rows.length > 0) {
    lines.push("signals:");
    for (const row of comparison.findings.rows) {
      const finding = row.after ?? row.before!;
      lines.push(
        `  ${row.impact.padEnd(10)} ${finding.finding_kind} ${finding.scope_kind}:${finding.scope_id} (${row.fingerprint})`,
      );
      for (const change of row.field_changes) {
        lines.push(`    ${change.field}: ${String(change.before)} -> ${String(change.after)}`);
      }
    }
  }
  lines.push(`comparison digest: ${comparison.comparison_digest}`);
  lines.push("observer only: no thresholds, processes, hooks, or workflow dispatch changed");
  return `${lines.join("\n")}\n`;
}

function bundleRef(bundle: ValidatedDiagnosticBundle): DiagnosticBundleComparisonRef {
  return {
    artifact_id: bundle.manifest.artifact_id,
    captured_at: bundle.manifest.captured_at,
    machine_id: bundle.manifest.machine_id,
    engine_version: bundle.manifest.engine_version,
    threshold_digest: bundle.manifest.threshold_digest,
    finding_count: bundle.expected.findings.length,
    pressure: bundle.expected.advice.assessment.state,
  };
}

function indexFindings(findings: readonly SupervisorFinding[]): {
  rows: ReadonlyMap<string, SupervisorFinding>;
  duplicateCount: number;
} {
  const sorted = [...findings].sort(
    (left, right) =>
      Date.parse(right.observed_at) - Date.parse(left.observed_at) ||
      left.id.localeCompare(right.id),
  );
  const rows = new Map<string, SupervisorFinding>();
  let duplicateCount = 0;
  for (const finding of sorted) {
    if (rows.has(finding.fingerprint)) duplicateCount += 1;
    else rows.set(finding.fingerprint, finding);
  }
  return { rows, duplicateCount };
}

function compareFindings(
  before: ReadonlyMap<string, SupervisorFinding>,
  after: ReadonlyMap<string, SupervisorFinding>,
): DiagnosticFindingComparison[] {
  const fingerprints = [...new Set([...before.keys(), ...after.keys()])].sort();
  return fingerprints
    .map((fingerprint): DiagnosticFindingComparison => {
      const previous = before.get(fingerprint);
      const current = after.get(fingerprint);
      if (!previous && current) {
        return {
          fingerprint,
          change_class: "added",
          impact: current.state === "opened" ? "regression" : "changed",
          after: current,
          field_changes: [],
        };
      }
      if (previous && !current) {
        return {
          fingerprint,
          change_class: "resolved",
          impact: previous.state === "opened" ? "recovery" : "changed",
          before: previous,
          field_changes: [],
        };
      }
      const fieldChanges = compareFindingFields(previous!, current!);
      return {
        fingerprint,
        change_class: "persistent",
        impact: persistentImpact(fieldChanges),
        before: previous,
        after: current,
        field_changes: fieldChanges,
      };
    })
    .sort(compareFindingRows);
}

function compareFindingFields(
  before: SupervisorFinding,
  after: SupervisorFinding,
): DiagnosticFindingFieldChange[] {
  const rows: DiagnosticFindingFieldChange[] = [];
  addRankedChange(rows, "severity", before.severity, after.severity, severityRank);
  addRankedChange(rows, "state", before.state, after.state, stateRank);
  addRankedChange(
    rows,
    "occurrence_count",
    before.occurrence_count,
    after.occurrence_count,
    numberRank,
  );
  if (
    before.peak_unit === after.peak_unit &&
    before.peak_observed_value !== undefined &&
    after.peak_observed_value !== undefined
  ) {
    addRankedChange(
      rows,
      "peak_observed_value",
      before.peak_observed_value,
      after.peak_observed_value,
      numberRank,
    );
  }
  addChangedField(rows, "owner", owner(before), owner(after));
  addChangedField(
    rows,
    "workload_relationship",
    before.workload_context?.relationship ?? null,
    after.workload_context?.relationship ?? null,
  );
  return rows;
}

function addRankedChange<T extends string | number>(
  rows: DiagnosticFindingFieldChange[],
  field: DiagnosticFindingFieldChange["field"],
  before: T,
  after: T,
  rank: (value: T) => number,
): void {
  if (before === after) return;
  rows.push({
    field,
    before,
    after,
    impact: rank(after) > rank(before) ? "worsened" : "improved",
  });
}

function addChangedField(
  rows: DiagnosticFindingFieldChange[],
  field: DiagnosticFindingFieldChange["field"],
  before: string | null,
  after: string | null,
): void {
  if (before === after) return;
  rows.push({ field, before, after, impact: "changed" });
}

function persistentImpact(
  changes: readonly DiagnosticFindingFieldChange[],
): DiagnosticComparisonImpact {
  if (changes.length === 0) return "unchanged";
  const worsened = changes.some((row) => row.impact === "worsened");
  const improved = changes.some((row) => row.impact === "improved");
  const changed = changes.some((row) => row.impact === "changed");
  if (worsened && !improved && !changed) return "worsened";
  if (improved && !worsened && !changed) return "improved";
  return "changed";
}

function compareFindingRows(
  left: DiagnosticFindingComparison,
  right: DiagnosticFindingComparison,
): number {
  const impact = impactRank(left.impact) - impactRank(right.impact);
  if (impact !== 0) return impact;
  const leftFinding = left.after ?? left.before!;
  const rightFinding = right.after ?? right.before!;
  const severity = severityRank(rightFinding.severity) - severityRank(leftFinding.severity);
  return (
    severity ||
    leftFinding.finding_kind.localeCompare(rightFinding.finding_kind) ||
    leftFinding.scope_kind.localeCompare(rightFinding.scope_kind) ||
    leftFinding.scope_id.localeCompare(rightFinding.scope_id) ||
    left.fingerprint.localeCompare(right.fingerprint)
  );
}

function compareCapabilities(
  before: ValidatedDiagnosticBundle,
  after: ValidatedDiagnosticBundle,
): DiagnosticCapabilityComparison[] {
  const previous = capabilityMap(before.manifest.capabilities);
  const current = capabilityMap(after.manifest.capabilities);
  const sourceKinds = [...new Set([...previous.keys(), ...current.keys()])].sort();
  return sourceKinds.map((sourceKind) => {
    const left = previous.get(sourceKind);
    const right = current.get(sourceKind);
    return {
      source_kind: sourceKind,
      change: !left
        ? "added"
        : !right
          ? "removed"
          : sameCapability(left, right)
            ? "unchanged"
            : "changed",
      ...(left ? { before: left } : {}),
      ...(right ? { after: right } : {}),
    };
  });
}

function capabilityMap(rows: readonly SupervisorCapability[]): Map<string, SupervisorCapability> {
  return new Map(
    [...rows]
      .sort((a, b) => a.source_kind.localeCompare(b.source_kind))
      .map((row) => [row.source_kind, row]),
  );
}

function sameCapability(left: SupervisorCapability, right: SupervisorCapability): boolean {
  return (
    left.state === right.state &&
    left.reason_code === right.reason_code &&
    left.detail === right.detail
  );
}

function optionalSourceComparison<T>(
  before: ValidatedDiagnosticBundle,
  after: ValidatedDiagnosticBundle,
  sourceKind: string,
  parse: (value: unknown) => T | undefined,
): DiagnosticOptionalSourceComparison<T> {
  const previous = optionalSource(before, sourceKind, parse);
  const current = optionalSource(after, sourceKind, parse);
  return {
    before_capability: previous.capability,
    after_capability: current.capability,
    ...(previous.value ? { before: previous.value } : {}),
    ...(current.value ? { after: current.value } : {}),
  };
}

function optionalSource<T>(
  bundle: ValidatedDiagnosticBundle,
  sourceKind: string,
  parse: (value: unknown) => T | undefined,
): { capability: SupervisorCapability; value?: T } {
  const source = bundle.observations.sources.find(
    (candidate) => candidate.source_kind === sourceKind,
  );
  if (!source) {
    return {
      capability: {
        source_kind: sourceKind,
        state: "unsupported",
        reason_code: "source_not_captured",
      },
    };
  }
  const capability: SupervisorCapability = {
    source_kind: sourceKind,
    state: source.capability,
    ...(source.reason_code ? { reason_code: source.reason_code } : {}),
  };
  if (source.value === undefined) return { capability };
  const value = parse(source.value);
  return value
    ? { capability, value }
    : {
        capability: {
          source_kind: sourceKind,
          state: "malformed",
          reason_code: "source_projection_malformed",
        },
      };
}

function hookHealthSummary(value: unknown): DiagnosticHookHealthSummary | undefined {
  const record = object(value);
  const summary = object(record?.summary);
  const aggregates = Array.isArray(record?.aggregates) ? record.aggregates : undefined;
  if (!record || !summary || !aggregates) return undefined;
  const parsedSummary = integerFields(summary, [
    "invocation_count",
    "degraded_count",
    "faulted_count",
    "slow_count",
    "high_memory_count",
    "retry_count",
  ] as const);
  if (!parsedSummary) return undefined;
  const parsedAggregates: DiagnosticHookAggregateSummary[] = [];
  for (const value of aggregates.slice(0, 40)) {
    const row = object(value);
    if (!row) return undefined;
    const numbers = integerFields(row, [
      "invocation_count",
      "degraded_count",
      "faulted_count",
      "retry_count",
      "duration_p95_ms",
      "rss_end_max_bytes",
    ] as const);
    if (
      !numbers ||
      typeof row.key !== "string" ||
      typeof row.hook_name !== "string" ||
      typeof row.adapter !== "string"
    ) {
      return undefined;
    }
    parsedAggregates.push({
      key: row.key,
      hook_name: row.hook_name,
      adapter: row.adapter,
      ...numbers,
    });
  }
  return {
    ...parsedSummary,
    aggregates: parsedAggregates.sort((left, right) => left.key.localeCompare(right.key)),
  };
}

function shadowAdmissionSummary(value: unknown): DiagnosticShadowAdmissionSummary | undefined {
  const record = object(value);
  const rows = Array.isArray(record?.records) ? record.records : undefined;
  if (!record || !rows) return undefined;
  const summary: DiagnosticShadowAdmissionSummary = {
    record_count: rows.length,
    observed_count: 0,
    not_needed_count: 0,
    unavailable_count: 0,
    normal_count: 0,
    elevated_count: 0,
    critical_count: 0,
    unknown_count: 0,
    max_wait_ms: 0,
  };
  for (const value of rows) {
    const row = object(value);
    if (!row || (row.state !== "observed" && row.state !== "not-needed")) return undefined;
    if (row.state === "not-needed") {
      summary.not_needed_count += 1;
      continue;
    }
    summary.observed_count += 1;
    const pressure = row.pressure;
    if (pressure === "normal") summary.normal_count += 1;
    else if (pressure === "elevated") summary.elevated_count += 1;
    else if (pressure === "critical") summary.critical_count += 1;
    else summary.unknown_count += 1;
    if (row.freshness === "unavailable") summary.unavailable_count += 1;
    if (typeof row.wait_ms === "number" && Number.isSafeInteger(row.wait_ms) && row.wait_ms >= 0) {
      summary.max_wait_ms = Math.max(summary.max_wait_ms, row.wait_ms);
    } else return undefined;
  }
  return summary;
}

function integerFields<const Keys extends readonly string[]>(
  record: Record<string, unknown>,
  keys: Keys,
): { [Key in Keys[number]]: number } | undefined {
  const result: Record<string, number> = {};
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
    result[key] = value;
  }
  return result as { [Key in Keys[number]]: number };
}

function adviceDirection(
  before: DiagnosticPressure,
  after: DiagnosticPressure,
): "escalated" | "deescalated" | "unchanged" | "changed" {
  if (before === after) return "unchanged";
  if (before === "unknown" || after === "unknown") return "changed";
  return pressureRank(after) > pressureRank(before) ? "escalated" : "deescalated";
}

function countImpact(
  rows: readonly DiagnosticFindingComparison[],
  impact: DiagnosticComparisonImpact,
): number {
  return rows.filter((row) => row.impact === impact).length;
}

function owner(finding: SupervisorFinding): string | null {
  const attribution = finding.attribution;
  if (!attribution) return null;
  if (attribution.state === "attributed") {
    return `${attribution.owner_kind ?? "unknown"}:${attribution.owner_id ?? "unknown"}`;
  }
  return `unattributed:${attribution.reason_code ?? "unknown"}`;
}

function severityRank(value: SupervisorFinding["severity"]): number {
  return value === "critical" ? 2 : value === "warning" ? 1 : 0;
}

function stateRank(value: SupervisorFinding["state"]): number {
  return value === "opened" ? 1 : 0;
}

function numberRank(value: number): number {
  return value;
}

function pressureRank(value: Exclude<DiagnosticPressure, "unknown">): number {
  return value === "critical" ? 2 : value === "elevated" ? 1 : 0;
}

function impactRank(value: DiagnosticComparisonImpact): number {
  return ["regression", "worsened", "changed", "improved", "recovery", "unchanged"].indexOf(value);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
