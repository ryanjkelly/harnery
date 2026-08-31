import type {
  SupervisorCapability,
  SupervisorFinding,
  SupervisorFindingExplanation,
  SupervisorTimeline,
} from "../supervisor/contract.ts";

export const DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 3 as const;
export const DIAGNOSTIC_COMMAND_SCHEMA_VERSION = 1 as const;
export const DIAGNOSTIC_INPUT_SCHEMA_VERSION = 2 as const;
export const DIAGNOSTIC_EXPECTED_SCHEMA_VERSION = 3 as const;
export const DIAGNOSTIC_SUMMARY_SCHEMA_VERSION = 1 as const;
export const DIAGNOSTIC_ADVICE_SCHEMA_VERSION = 1 as const;

export const DIAGNOSTIC_ADVICE_LIMITS = {
  max_contributing_findings: 8,
  max_reasons: 4,
} as const;

export type DiagnosticPressure = "normal" | "elevated" | "critical" | "unknown";
export type DiagnosticFanOutRecommendation =
  | "proceed"
  | "use-caution"
  | "avoid-new-fan-out"
  | "unknown";

export interface DiagnosticAdviceFinding {
  finding_id: string;
  finding_kind: string;
  severity: "warning" | "critical";
  summary: string;
  scope_kind: string;
  scope_id: string;
  occurrence_count: number;
  owner_kind?: "agent" | "service";
  owner_id?: string;
  workload_relationship?: "active-work" | "unexpected-idle-growth" | "unknown";
}

export interface DiagnosticAdviceReason {
  code:
    | "critical_findings_active"
    | "warning_findings_active"
    | "findings_source_unavailable"
    | "no_active_pressure_findings";
  summary: string;
  finding_ids: readonly string[];
}

export interface DiagnosticAdvice {
  schema_version: typeof DIAGNOSTIC_ADVICE_SCHEMA_VERSION;
  evaluated_at: string;
  pressure: DiagnosticPressure;
  fan_out_recommendation: DiagnosticFanOutRecommendation;
  observer_only: true;
  summary: string;
  source_capability: SupervisorCapability;
  active_finding_count: number;
  contributing_finding_count: number;
  omitted_contributing_finding_count: number;
  contributing_findings: readonly DiagnosticAdviceFinding[];
  reasons: readonly DiagnosticAdviceReason[];
}

export const DIAGNOSTIC_BUNDLE_FILES = [
  "diagnostic-manifest.json",
  "inputs/observations.json",
  "inputs/thresholds.json",
  "expected.json",
  "summary.json",
] as const;

export type DiagnosticBundleFilePath = (typeof DIAGNOSTIC_BUNDLE_FILES)[number];

export interface DiagnosticBundleFile {
  path: Exclude<DiagnosticBundleFilePath, "diagnostic-manifest.json">;
  media_type: "application/json";
  bytes: number;
  sha256: string;
}

export interface DiagnosticBundleSource {
  source_kind: string;
  schema_version?: number;
  capability: SupervisorCapability["state"];
  entry_count: number;
  omitted_count: number;
  file: "inputs/observations.json";
}

export interface DiagnosticBundleManifest {
  schema_version: typeof DIAGNOSTIC_BUNDLE_SCHEMA_VERSION;
  artifact_id: string;
  captured_at: string;
  machine_id: string;
  finding_id?: string;
  time_range: { start_at: string; end_at: string };
  engine_version: string;
  threshold_digest: string;
  sources: readonly DiagnosticBundleSource[];
  capabilities: readonly SupervisorCapability[];
  files: readonly DiagnosticBundleFile[];
  replay: {
    input_file: "inputs/observations.json";
    thresholds_file: "inputs/thresholds.json";
    expected_file: "expected.json";
  };
}

export interface DiagnosticSelection {
  finding_id?: string;
  start_at: string;
  end_at: string;
}

export interface DiagnosticCapturedSource {
  source_kind: string;
  capability: SupervisorCapability["state"];
  schema_version?: number;
  observed_at?: string;
  value?: unknown;
  reason_code?: string;
}

export interface DiagnosticObservations {
  schema_version: typeof DIAGNOSTIC_INPUT_SCHEMA_VERSION;
  captured_at: string;
  selection: DiagnosticSelection;
  sources: readonly DiagnosticCapturedSource[];
}

export interface DiagnosticThresholds {
  schema_version: typeof DIAGNOSTIC_INPUT_SCHEMA_VERSION;
  values: Readonly<Record<string, unknown>>;
}

export interface DiagnosticExpected {
  schema_version: typeof DIAGNOSTIC_EXPECTED_SCHEMA_VERSION;
  threshold_digest: string;
  selection: DiagnosticSelection;
  findings: readonly SupervisorFinding[];
  timelines: readonly SupervisorTimeline[];
  explanations: readonly SupervisorFindingExplanation[];
  advice: DiagnosticAdvice;
}

export interface DiagnosticSummary {
  schema_version: typeof DIAGNOSTIC_SUMMARY_SCHEMA_VERSION;
  artifact_id: string;
  captured_at: string;
  machine_id: string;
  machine_id_kind: "pseudonymous";
  selection: DiagnosticSelection;
  source_count: number;
  supported_source_count: number;
  sanitized_value_count: number;
  omitted_value_count: number;
  total_bytes: number;
}

export interface ValidatedDiagnosticBundle {
  path: string;
  manifest: DiagnosticBundleManifest;
  observations: DiagnosticObservations;
  thresholds: DiagnosticThresholds;
  expected: DiagnosticExpected;
  summary: DiagnosticSummary;
}

export interface DiagnosticReplayResult {
  schema_version: typeof DIAGNOSTIC_COMMAND_SCHEMA_VERSION;
  artifact_id: string;
  replayed_at: string;
  matched: boolean;
  threshold_digest: string;
  expected_digest: string;
  actual_digest: string;
  finding_count: number;
}
