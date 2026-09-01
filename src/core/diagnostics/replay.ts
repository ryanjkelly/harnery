import { createHash } from "node:crypto";
import type { CoordinationHealthSnapshot } from "../agents/health.ts";
import type { ResourceSnapshot } from "../resources/contract.ts";
import { RESOURCE_SNAPSHOT_SCHEMA_VERSION } from "../resources/contract.ts";
import type {
  ObservedHookHealth,
  ObservedServiceHealth,
  SupervisorActivitySnapshot,
  SupervisorFinding,
  SupervisorFindingExplanation,
  SupervisorFindings,
  SupervisorHistory,
  SupervisorLogFeed,
  SupervisorSnapshot,
  SupervisorTimeline,
} from "../supervisor/contract.ts";
import {
  SUPERVISOR_HISTORY_SCHEMA_VERSION,
  SUPERVISOR_LOG_FEED_SCHEMA_VERSION,
  SUPERVISOR_SNAPSHOT_SCHEMA_VERSION,
} from "../supervisor/contract.ts";
import { explainSupervisorFinding } from "../supervisor/explanations.ts";
import { updateSupervisorFindings } from "../supervisor/findings.ts";
import { projectHookHealth } from "../supervisor/hook-health.ts";
import { buildSupervisorTimeline } from "../supervisor/timeline.ts";
import { buildDiagnosticAdvice } from "./advice.ts";
import {
  DIAGNOSTIC_EXPECTED_SCHEMA_VERSION,
  type DiagnosticExpected,
  type DiagnosticObservations,
  type DiagnosticSelection,
  type DiagnosticThresholds,
} from "./contract.ts";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Record the live engine's frozen output. Replay never uses this as an input. */
export function deriveCapturedExpected(
  observations: DiagnosticObservations,
  thresholds: DiagnosticThresholds,
): DiagnosticExpected {
  const selection = observations.selection;
  const findings = filterFindings(
    findingsProjection(sourceValue(observations, "supervisor.findings")),
    selection,
  );
  const coordination = sourceValue(observations, "coordination.health") as
    | CoordinationHealthSnapshot
    | undefined;
  const relatedSources = coordination?.recent_events ?? [];
  return expected(
    thresholds,
    selection,
    findings,
    findings.map((finding) => diagnosticTimeline(finding, relatedSources)),
    findings.map(explainSupervisorFinding),
    observations,
  );
}

/** Re-run the pure finding engine from frozen source inputs only. */
export function replayDiagnosticInputs(
  observations: DiagnosticObservations,
  thresholds: DiagnosticThresholds,
): DiagnosticExpected {
  const resource =
    optionalSource<ResourceSnapshot>(observations, "resources.snapshot") ??
    neutralResource(observations.captured_at);
  const supervisor =
    optionalSource<SupervisorSnapshot>(observations, "supervisor.snapshot") ??
    neutralSupervisor(observations.captured_at);
  const history =
    optionalSource<SupervisorHistory>(observations, "supervisor.history") ?? neutralHistory();
  const logFeed =
    optionalSource<SupervisorLogFeed>(observations, "supervisor.log-feed") ??
    neutralLogFeed(observations.captured_at);
  const hookHealth = projectHookHealth(logFeed, new Date(observations.captured_at));
  const coordination = optionalSource<CoordinationHealthSnapshot>(
    observations,
    "coordination.health",
  );
  const activity = optionalSource<SupervisorActivitySnapshot>(observations, "supervisor.activity");
  const currentProjection = optionalSource<SupervisorFindings>(observations, "supervisor.findings");
  const observedAt =
    currentProjection?.active[0]?.observed_at ??
    currentProjection?.transitions.at(-1)?.observed_at ??
    resource.sampled_at;
  // The frozen projection supplies lifecycle state only. Candidates, severity,
  // attribution, workload context, and evidence are all re-evaluated from the
  // captured source observations. Without this prior state, a replay would
  // mint fresh IDs and discard recurrence and peak history for open episodes.
  const evaluated = updateSupervisorFindings({
    previous: currentProjection,
    resource,
    services: supervisor.services as readonly ObservedServiceHealth[],
    hooks: supervisor.hooks as readonly ObservedHookHealth[],
    history,
    logFeed,
    hookHealth,
    coordination,
    activity,
    now: new Date(observedAt),
  });
  const findings = filterFindings(findingsProjection(evaluated), observations.selection);
  const relatedSources = coordination?.recent_events ?? [];
  return expected(
    thresholds,
    observations.selection,
    findings,
    findings.map((finding) => diagnosticTimeline(finding, relatedSources)),
    findings.map(explainSupervisorFinding),
    observations,
  );
}

function diagnosticTimeline(
  finding: SupervisorFinding,
  relatedSources: readonly CoordinationHealthSnapshot["recent_events"][number][],
): SupervisorTimeline {
  return buildSupervisorTimeline(
    finding,
    relatedSources.filter((source) => {
      const delta = Math.abs(Date.parse(source.observed_at) - Date.parse(finding.observed_at));
      return Number.isFinite(delta) && delta <= 5 * 60_000;
    }),
  );
}

function expected(
  thresholds: DiagnosticThresholds,
  selection: DiagnosticSelection,
  findings: readonly SupervisorFinding[],
  timelines: readonly SupervisorTimeline[],
  explanations: readonly SupervisorFindingExplanation[],
  observations: DiagnosticObservations,
): DiagnosticExpected {
  return {
    schema_version: DIAGNOSTIC_EXPECTED_SCHEMA_VERSION,
    threshold_digest: sha256(canonicalJson(thresholds)),
    selection,
    findings,
    timelines: [...timelines].sort((left, right) =>
      left.finding_id.localeCompare(right.finding_id),
    ),
    explanations: [...explanations].sort((left, right) =>
      left.finding_id.localeCompare(right.finding_id),
    ),
    advice: buildDiagnosticAdvice({
      findings,
      sourceCapability: capturedSourceCapability(observations, "supervisor.findings"),
      evaluatedAt: observations.captured_at,
    }),
  };
}

function capturedSourceCapability(
  observations: DiagnosticObservations,
  sourceKind: string,
): import("../supervisor/contract.ts").SupervisorCapability {
  const source = observations.sources.find((candidate) => candidate.source_kind === sourceKind);
  return source
    ? {
        source_kind: sourceKind,
        state: source.capability,
        reason_code: source.reason_code,
      }
    : {
        source_kind: sourceKind,
        state: "unsupported",
        reason_code: "source_missing",
      };
}

function findingsProjection(value: unknown): readonly SupervisorFinding[] {
  const record = object(value);
  return [
    ...collectNamedRecords<SupervisorFinding>(record?.active),
    ...collectNamedRecords<SupervisorFinding>(record?.transitions),
  ];
}

function filterFindings(
  rows: readonly SupervisorFinding[],
  selection: DiagnosticSelection,
): SupervisorFinding[] {
  const deduped = new Map(rows.map((finding) => [finding.id, finding]));
  return [...deduped.values()]
    .filter((finding) => {
      if (selection.finding_id) return finding.id === selection.finding_id;
      const observed = Date.parse(finding.observed_at);
      return observed >= Date.parse(selection.start_at) && observed <= Date.parse(selection.end_at);
    })
    .sort(
      (left, right) =>
        left.observed_at.localeCompare(right.observed_at) || left.id.localeCompare(right.id),
    );
}

function optionalSource<T>(
  observations: DiagnosticObservations,
  sourceKind: string,
): T | undefined {
  const source = observations.sources.find((candidate) => candidate.source_kind === sourceKind);
  return source?.capability === "supported" && source.value !== undefined
    ? (source.value as T)
    : undefined;
}

function neutralResource(sampledAt: string): ResourceSnapshot {
  return {
    schema_version: RESOURCE_SNAPSHOT_SCHEMA_VERSION,
    sampled_at: sampledAt,
    interval_ms: null,
    sample_duration_ms: 0,
    collector_cpu_ms: 0,
    platform: "linux",
    namespace: "unknown",
    support: {
      state: "unsupported",
      sampler: "unsupported",
      reason: "captured-source-unavailable",
    },
    machine: {
      cpu_percent: null,
      cpu_logical_count: 0,
      load_average: null,
      memory_total_bytes: null,
      memory_available_bytes: null,
      memory_used_bytes: null,
      memory_percent: null,
      swap_total_bytes: null,
      swap_used_bytes: null,
      process_count: 0,
    },
    groups: [],
    processes: [],
    visible_process_count: 0,
    omitted_process_count: 0,
    unattributed_process_count: 0,
  };
}

function neutralSupervisor(sampledAt: string): SupervisorSnapshot {
  return {
    schema_version: SUPERVISOR_SNAPSHOT_SCHEMA_VERSION,
    sampled_at: sampledAt,
    sequence: 0,
    collector_duration_ms: 0,
    resource_sample_duration_ms: 0,
    services: [],
    hooks: [],
    active_finding_count: 0,
    history_point_count: 0,
    log_record_count: 0,
    live_consumer_count: 0,
    attributed_agent_count: 0,
  };
}

function neutralHistory(): SupervisorHistory {
  return {
    schema_version: SUPERVISOR_HISTORY_SCHEMA_VERSION,
    interval_ms: 10_000,
    max_points: 90,
    points: [],
  };
}

function neutralLogFeed(capturedAt: string): SupervisorLogFeed {
  return {
    schema_version: SUPERVISOR_LOG_FEED_SCHEMA_VERSION,
    captured_at: capturedAt,
    sequence: 0,
    lanes: [],
    total_records: 0,
    unavailable_families: 0,
  };
}

function sourceValue(observations: DiagnosticObservations, sourceKind: string): unknown {
  return observations.sources.find((source) => source.source_kind === sourceKind)?.value;
}

function collectNamedRecords<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value.filter(isObject) as T[];
  const record = object(value);
  if (!record) return [];
  if (Array.isArray(record.rows)) return record.rows.filter(isObject) as T[];
  return Object.values(record).filter(isObject) as T[];
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}

function object(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
