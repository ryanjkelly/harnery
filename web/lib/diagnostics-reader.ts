import { statSync } from "node:fs";
import path from "node:path";

import {
  compareValidatedDiagnosticBundles,
  type DiagnosticBundleComparison,
  type DiagnosticBundleManifest,
  readFrozenDiagnosticBundle,
} from "../../src/core/diagnostics/index";
import type {
  SupervisorCapability,
  SupervisorFinding,
  SupervisorFindingExplanation,
  SupervisorTimeline,
} from "../../src/core/supervisor/contract";
import {
  buildSupervisorTimeline,
  explainSupervisorFinding,
  readSupervisorExplanation,
  readSupervisorFindings,
  readSupervisorTimeline,
} from "../../src/core/supervisor/index";

export interface DiagnosticsViewModel {
  mode: "live" | "frozen";
  findings: readonly SupervisorFinding[];
  selectedFinding?: SupervisorFinding;
  timeline?: SupervisorTimeline;
  explanation?: SupervisorFindingExplanation;
  capabilities: readonly SupervisorCapability[];
  capturedAt?: string;
  bundle?: DiagnosticBundleManifest;
  notice?: string;
}

export interface DiagnosticsQuery {
  finding?: string;
  state?: "opened" | "resolved";
  severity?: "info" | "warning" | "critical";
  source?: string;
}

export type RawDiagnosticsQuery = Record<
  "finding" | "state" | "severity" | "source",
  string | string[] | undefined
>;

export function normalizeDiagnosticsQuery(input: Partial<RawDiagnosticsQuery>): DiagnosticsQuery {
  const finding = boundedOpaqueQueryValue(input.finding, 240, true);
  const state = enumQueryValue(input.state, ["opened", "resolved"] as const);
  const severity = enumQueryValue(input.severity, ["info", "warning", "critical"] as const);
  const source = boundedOpaqueQueryValue(input.source, 160, false);
  return {
    ...(finding ? { finding } : {}),
    ...(state ? { state } : {}),
    ...(severity ? { severity } : {}),
    ...(source ? { source } : {}),
  };
}

export function readLiveDiagnostics(
  repoRoot: string,
  query: DiagnosticsQuery = {},
): DiagnosticsViewModel {
  const report = readSupervisorFindings(repoRoot);
  const findings = mergeFindings(report?.active ?? [], report?.transitions ?? []);
  const selectedFinding = selectFinding(findings, query);
  const timeline = selectedFinding
    ? (readSupervisorTimeline(repoRoot, selectedFinding.id) ??
      buildSupervisorTimeline(selectedFinding))
    : undefined;
  const explanation = selectedFinding
    ? (readSupervisorExplanation(repoRoot, selectedFinding.id) ??
      explainSupervisorFinding(selectedFinding))
    : undefined;

  return {
    mode: "live",
    findings,
    selectedFinding,
    timeline,
    explanation,
    capabilities: collectCapabilities(selectedFinding, timeline, explanation),
    capturedAt: newestObservedAt(findings),
    ...(!report
      ? { notice: "No diagnostic projection is available yet. The local supervisor may be idle." }
      : {}),
  };
}

export function readFrozenDiagnostics(
  repoRoot: string,
  bundleRef: string,
  query: DiagnosticsQuery = {},
): DiagnosticsViewModel {
  // The frozen reader accepts only an opaque managed-artifact id and rejects
  // path escapes, links, unknown schemas, and digest mismatches. Never turn the
  // route segment into a filesystem path or borrow current live data.
  const validated = readFrozenDiagnosticBundle(repoRoot, bundleRef);
  const expected = validated.expected;
  const findings = mergeFindings(expected.findings, []);
  const selectedFinding = selectFinding(findings, {
    ...query,
    finding: query.finding ?? validated.manifest.finding_id,
  });
  const timeline = selectedFinding
    ? expected.timelines.find((entry) => entry.finding_id === selectedFinding.id)
    : undefined;
  const explanation = selectedFinding
    ? expected.explanations.find((entry) => entry.finding_id === selectedFinding.id)
    : undefined;

  return {
    mode: "frozen",
    findings,
    selectedFinding,
    timeline,
    explanation,
    capabilities: collectCapabilities(
      selectedFinding,
      timeline,
      explanation,
      validated.manifest.capabilities,
    ),
    capturedAt: validated.manifest.captured_at,
    bundle: validated.manifest,
  };
}

export function readDiagnosticComparison(
  repoRoot: string,
  beforeArtifactId: string,
  afterArtifactId: string,
): DiagnosticBundleComparison {
  // Both inputs use the opaque frozen reader. Never pass web query values to
  // the CLI-oriented validator, which also accepts local managed paths.
  return compareValidatedDiagnosticBundles(
    readFrozenDiagnosticBundle(repoRoot, beforeArtifactId),
    readFrozenDiagnosticBundle(repoRoot, afterArtifactId),
  );
}

export function diagnosticsVersion(repoRoot: string): string {
  const base = path.join(repoRoot, ".harnery", "supervisor");
  const candidates = [
    path.join(base, "findings.json"),
    path.join(base, "snapshot.json"),
    path.join(base, "timelines"),
    path.join(base, "explanations"),
  ];
  let latest = 0;
  for (const candidate of candidates) {
    try {
      latest = Math.max(latest, statSync(candidate).mtimeMs);
    } catch {
      // Missing disposable projections are a valid idle state.
    }
  }
  return String(Math.trunc(latest));
}

function mergeFindings(
  active: readonly SupervisorFinding[],
  transitions: readonly SupervisorFinding[],
): SupervisorFinding[] {
  const byId = new Map<string, SupervisorFinding>();
  for (const finding of transitions) byId.set(finding.id, finding);
  for (const finding of active) byId.set(finding.id, finding);
  return [...byId.values()].sort((left, right) => {
    const severity = severityRank(right.severity) - severityRank(left.severity);
    if (severity !== 0) return severity;
    return Date.parse(right.observed_at) - Date.parse(left.observed_at);
  });
}

function selectFinding(
  findings: readonly SupervisorFinding[],
  query: DiagnosticsQuery,
): SupervisorFinding | undefined {
  const filtered = findings.filter((finding) => findingMatchesQuery(finding, query));
  if (query.finding !== undefined) {
    return filtered.find((finding) => finding.id === query.finding);
  }
  return filtered[0];
}

export function findingMatchesQuery(finding: SupervisorFinding, query: DiagnosticsQuery): boolean {
  if (query.state && finding.state !== query.state) return false;
  if (query.severity && finding.severity !== query.severity) return false;
  if (query.source && finding.source_kind !== query.source) return false;
  return true;
}

function collectCapabilities(
  finding?: SupervisorFinding,
  timeline?: SupervisorTimeline,
  explanation?: SupervisorFindingExplanation,
  extra: readonly SupervisorCapability[] = [],
): SupervisorCapability[] {
  const bySource = new Map<string, SupervisorCapability>();
  for (const capability of [
    ...extra,
    ...(finding?.capabilities ?? []),
    ...(timeline?.capabilities ?? []),
    ...(explanation?.missing_capabilities ?? []),
  ]) {
    bySource.set(capability.source_kind, capability);
  }
  return [...bySource.values()].sort((left, right) =>
    left.source_kind.localeCompare(right.source_kind),
  );
}

function newestObservedAt(findings: readonly SupervisorFinding[]): string | undefined {
  return findings.reduce<string | undefined>((newest, finding) => {
    if (!newest || Date.parse(finding.observed_at) > Date.parse(newest)) return finding.observed_at;
    return newest;
  }, undefined);
}

function severityRank(severity: SupervisorFinding["severity"]): number {
  if (severity === "critical") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function enumQueryValue<const T extends readonly string[]>(
  value: string | string[] | undefined,
  allowed: T,
): T[number] | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : undefined;
}

function boundedOpaqueQueryValue(
  value: string | string[] | undefined,
  maxLength: number,
  preserveInvalid: boolean,
): string | undefined {
  if (Array.isArray(value)) return preserveInvalid ? "__invalid_selection__" : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (/^[A-Za-z0-9_.:-]+$/.test(normalized) && normalized.length <= maxLength) return normalized;
  return preserveInvalid && normalized ? "__invalid_selection__" : undefined;
}
