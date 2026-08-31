import { createHash } from "node:crypto";
import type { CoordinationHealthSnapshot } from "../agents/health.ts";
import type { ResourceProcessGroup, ResourceSnapshot } from "../resources/contract.ts";
import {
  type ObservedHookHealth,
  type ObservedServiceHealth,
  SUPERVISOR_DIAGNOSTIC_LIMITS,
  SUPERVISOR_FINDING_SCHEMA_VERSION,
  type SupervisorCapability,
  type SupervisorFinding,
  type SupervisorFindingEvidence,
  type SupervisorFindingSeverity,
  type SupervisorFindings,
  type SupervisorHistory,
  type SupervisorLogFeed,
  type SupervisorSourceReference,
} from "./contract.ts";

const GIB = 1_024 * 1_024 * 1_024;
const MIB = 1_024 * 1_024;
const MACHINE_CPU_THRESHOLD = 90;
const MACHINE_MEMORY_THRESHOLD = 85;
const MACHINE_SWAP_THRESHOLD = 75;
const COLLECTOR_CPU_THRESHOLD_MS = 50;
const PROCESS_MEMORY_THRESHOLD = GIB;
const GROUP_MEMORY_THRESHOLD = 2 * GIB;
const OWNER_PROCESS_THRESHOLD = 50;
const MEMORY_GROWTH_MIN_BYTES = 256 * MIB;
const MEMORY_GROWTH_RATIO = 1.3;
const MEMORY_GROWTH_WINDOW_MS = 5 * 60_000;

interface Candidate {
  source_kind: string;
  finding_kind: string;
  severity: SupervisorFindingSeverity;
  scope_kind: string;
  scope_id: string;
  summary: string;
  primary_source: SupervisorSourceReference;
  evidence: SupervisorFindingEvidence[];
  capabilities: SupervisorCapability[];
}

export interface SupervisorFindingEvaluationInput {
  previous?: SupervisorFindings;
  resource: ResourceSnapshot;
  services: readonly ObservedServiceHealth[];
  hooks: readonly ObservedHookHealth[];
  history: SupervisorHistory;
  logFeed: SupervisorLogFeed;
  coordination?: CoordinationHealthSnapshot;
  now?: Date;
}

/** Pure deterministic evaluator used by the live supervisor and replay. */
export function evaluateSupervisorFindings(
  input: Omit<SupervisorFindingEvaluationInput, "previous">,
): readonly SupervisorFinding[] {
  return updateSupervisorFindings(input).active;
}

export function updateSupervisorFindings(
  input: SupervisorFindingEvaluationInput,
): SupervisorFindings {
  const observedAt = (input.now ?? new Date(input.resource.sampled_at)).toISOString();
  const previous = validFindings(input.previous)
    ? input.previous
    : {
        schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
        max_findings: SUPERVISOR_DIAGNOSTIC_LIMITS.max_findings,
        active: [],
        transitions: [],
      };
  const candidates = evaluateCandidates(input)
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
    .slice(0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_active_findings);
  const priorActive = new Map(previous.active.map((entry) => [entry.fingerprint, entry]));
  const current = new Set<string>();
  const active: SupervisorFinding[] = [];
  const transitions = [...previous.transitions];

  for (const candidate of candidates) {
    const fingerprint = findingFingerprint(candidate);
    current.add(fingerprint);
    const prior = priorActive.get(fingerprint);
    const openedAt = prior?.opened_at ?? candidate.primary_source.observed_at;
    const finding: SupervisorFinding = {
      schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
      id: deterministicId("find", `${fingerprint}\u0000${openedAt}`),
      fingerprint,
      source_kind: candidate.source_kind,
      finding_kind: candidate.finding_kind,
      severity: candidate.severity,
      state: "opened",
      scope_kind: candidate.scope_kind,
      scope_id: candidate.scope_id,
      summary: candidate.summary,
      opened_at: openedAt,
      observed_at: observedAt,
      primary_source: candidate.primary_source,
      evidence: candidate.evidence.slice(0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_evidence_per_finding),
      capabilities: boundCapabilities(candidate.capabilities),
    };
    active.push(finding);
    if (!prior) transitions.push(finding);
  }

  for (const prior of priorActive.values()) {
    if (current.has(prior.fingerprint)) continue;
    transitions.push({
      ...prior,
      state: "resolved",
      observed_at: observedAt,
      resolved_at: observedAt,
    });
  }

  return {
    schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
    max_findings: SUPERVISOR_DIAGNOSTIC_LIMITS.max_findings,
    active,
    transitions: transitions.slice(-SUPERVISOR_DIAGNOSTIC_LIMITS.max_findings),
  };
}

function evaluateCandidates(input: {
  resource: ResourceSnapshot;
  services: readonly ObservedServiceHealth[];
  hooks: readonly ObservedHookHealth[];
  history: SupervisorHistory;
  logFeed: SupervisorLogFeed;
  coordination?: CoordinationHealthSnapshot;
}): Candidate[] {
  const out: Candidate[] = [];
  const resourceCapability: SupervisorCapability = {
    source_kind: "resource.snapshot",
    state: input.resource.support.state,
    ...(input.resource.support.reason
      ? { reason_code: "sampler-degraded", detail: input.resource.support.reason }
      : {}),
  };
  const source = resourceSource(input.resource, resourceCapability.state);
  const addMachine = (
    findingKind: string,
    severity: SupervisorFindingSeverity,
    summary: string,
    value: number,
    unit: SupervisorFindingEvidence["unit"],
  ) =>
    out.push(
      candidate(findingKind, severity, "machine", "local", summary, source, value, unit, [
        resourceCapability,
      ]),
    );

  const machine = input.resource.machine;
  if (resourceCapability.state !== "supported") {
    out.push(capabilityCandidate(resourceCapability, source));
  }
  if ((machine.cpu_percent ?? 0) >= MACHINE_CPU_THRESHOLD)
    addMachine(
      "machine.cpu-pressure",
      "warning",
      `Machine CPU is ${machine.cpu_percent}%.`,
      machine.cpu_percent!,
      "percent",
    );
  if ((machine.memory_percent ?? 0) >= MACHINE_MEMORY_THRESHOLD)
    addMachine(
      "machine.memory-pressure",
      "critical",
      `Machine memory is ${machine.memory_percent}%.`,
      machine.memory_percent!,
      "percent",
    );
  const swapPercent =
    machine.swap_total_bytes && machine.swap_used_bytes !== null
      ? round1((machine.swap_used_bytes / machine.swap_total_bytes) * 100)
      : null;
  if ((swapPercent ?? 0) >= MACHINE_SWAP_THRESHOLD)
    addMachine(
      "machine.swap-pressure",
      "warning",
      `Machine swap is ${swapPercent}% used.`,
      swapPercent!,
      "percent",
    );
  if (input.resource.collector_cpu_ms >= COLLECTOR_CPU_THRESHOLD_MS)
    out.push(
      candidate(
        "supervisor.collector-overhead",
        "warning",
        "service",
        "supervisor",
        `Supervisor resource collection used ${input.resource.collector_cpu_ms} ms of CPU.`,
        source,
        input.resource.collector_cpu_ms,
        "milliseconds",
        [resourceCapability],
      ),
    );

  for (const service of input.services.filter((entry) => entry.state === "stale").slice(0, 5)) {
    const serviceSource = stableSource(
      "service.health",
      service.id,
      service.heartbeat_at ?? input.resource.sampled_at,
      "supported",
    );
    out.push(
      candidate(
        "service.stale",
        "warning",
        "service",
        service.id,
        `${service.id} has stale liveness evidence.`,
        serviceSource,
        undefined,
        undefined,
        [{ source_kind: "service.health", state: "supported" }],
      ),
    );
  }
  for (const hook of input.hooks.filter((entry) => entry.long_running).slice(0, 5)) {
    const hookSource = stableSource(
      "hook.process",
      `${hook.owner_id}:${hook.pid}`,
      input.resource.sampled_at,
      "supported",
    );
    out.push(
      candidate(
        "hook.long-running",
        "warning",
        "hook",
        `${hook.owner_id}:${hook.pid}`,
        `Hook process ${hook.pid} has run for ${hook.age_seconds} seconds.`,
        hookSource,
        hook.age_seconds,
        "seconds",
        [{ source_kind: "hook.process", state: "supported" }],
      ),
    );
  }
  for (const process of input.resource.processes
    .filter((entry) => entry.rss_bytes >= PROCESS_MEMORY_THRESHOLD)
    .slice(0, 5))
    out.push(
      candidate(
        "process.memory-pressure",
        "critical",
        "process",
        process.start_id,
        `Process ${process.pid} uses ${process.rss_bytes} resident bytes.`,
        source,
        process.rss_bytes,
        "bytes",
        [resourceCapability],
      ),
    );
  for (const group of input.resource.groups
    .filter((entry) => entry.rss_bytes >= GROUP_MEMORY_THRESHOLD)
    .slice(0, 5))
    out.push(
      candidate(
        "group.memory-pressure",
        "critical",
        group.kind,
        groupKey(group),
        `${groupLabel(group)} uses ${group.rss_bytes} resident bytes.`,
        source,
        group.rss_bytes,
        "bytes",
        [resourceCapability],
      ),
    );
  for (const group of input.resource.groups
    .filter((entry) => entry.process_count >= OWNER_PROCESS_THRESHOLD)
    .slice(0, 5))
    out.push(
      candidate(
        "group.process-pressure",
        "warning",
        group.kind,
        groupKey(group),
        `${groupLabel(group)} owns ${group.process_count} visible processes.`,
        source,
        group.process_count,
        "processes",
        [resourceCapability],
      ),
    );
  out.push(...memoryGrowthCandidates(input.resource, input.history, resourceCapability));

  if (input.logFeed.unavailable_families > 0) {
    const logCapability: SupervisorCapability = {
      source_kind: "log.feed",
      state: "partial",
      reason_code: "families-unavailable",
      detail: `${input.logFeed.unavailable_families} log families were unavailable.`,
    };
    out.push(
      capabilityCandidate(
        logCapability,
        stableSource(
          "log.feed",
          "supervisor-log-feed",
          input.logFeed.captured_at,
          logCapability.state,
          undefined,
          input.logFeed.schema_version,
        ),
      ),
    );
  }

  if (input.coordination) {
    const coordination = input.coordination;
    if (coordination.capability.state !== "supported") {
      out.push(
        capabilityCandidate(
          coordination.capability,
          stableSource(
            coordination.capability.source_kind,
            coordination.capability.reason_code ?? coordination.capability.state,
            coordination.observed_at,
            coordination.capability.state,
          ),
        ),
      );
    }
    for (const diagnostic of coordination.diagnostics.slice(0, 5)) {
      const diagnosticSource = stableSource(
        "coordination.v3",
        diagnostic.event_id ?? `${diagnostic.segment_ordinal}:${diagnostic.byte_offset}`,
        coordination.observed_at,
        coordination.capability.state,
        diagnostic.event_id,
      );
      out.push(
        candidate(
          "coordination.ledger-diagnostic",
          "warning",
          "ledger",
          diagnostic.code,
          `Event ledger reported ${diagnostic.code}.`,
          diagnosticSource,
          1,
          "count",
          [coordination.capability],
        ),
      );
    }
  }
  return out;
}

function capabilityCandidate(
  capability: SupervisorCapability,
  source: SupervisorSourceReference,
): Candidate {
  return candidate(
    "source.capability-degraded",
    "info",
    "source",
    capability.source_kind,
    `${capability.source_kind} capability is ${capability.state}${capability.reason_code ? ` (${capability.reason_code})` : ""}.`,
    source,
    undefined,
    undefined,
    [capability],
  );
}

function memoryGrowthCandidates(
  resource: ResourceSnapshot,
  history: SupervisorHistory,
  capability: SupervisorCapability,
): Candidate[] {
  const newestAt = Date.parse(resource.sampled_at);
  const baseline = history.points.find(
    (point) => newestAt - Date.parse(point.sampled_at) <= MEMORY_GROWTH_WINDOW_MS,
  );
  if (!baseline || newestAt - Date.parse(baseline.sampled_at) < 60_000) return [];
  const priorByKey = new Map(baseline.groups.map((group) => [groupKey(group), group]));
  return resource.groups
    .flatMap((group): Candidate[] => {
      const prior = priorByKey.get(groupKey(group));
      if (!prior || prior.rss_bytes <= 0) return [];
      const delta = group.rss_bytes - prior.rss_bytes;
      if (
        delta < MEMORY_GROWTH_MIN_BYTES ||
        group.rss_bytes / prior.rss_bytes < MEMORY_GROWTH_RATIO
      )
        return [];
      return [
        candidate(
          "resource.memory-growth",
          "warning",
          group.kind,
          groupKey(group),
          `${groupLabel(group)} grew by ${delta} resident bytes since ${baseline.sampled_at}.`,
          resourceSource(resource, capability.state),
          delta,
          "bytes",
          [capability],
        ),
      ];
    })
    .slice(0, 5);
}

function candidate(
  findingKind: string,
  severity: SupervisorFindingSeverity,
  scopeKind: string,
  scopeId: string,
  summary: string,
  source: SupervisorSourceReference,
  observedValue: number | undefined,
  unit: SupervisorFindingEvidence["unit"] | undefined,
  capabilities: SupervisorCapability[],
): Candidate {
  const evidence: SupervisorFindingEvidence = {
    id: deterministicId("ev", `${findingKind}\u0000${scopeKind}\u0000${scopeId}\u0000${source.id}`),
    source,
    summary: summary.slice(0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_summary_chars),
    ...(observedValue !== undefined ? { observed_value: observedValue } : {}),
    ...(unit ? { unit } : {}),
  };
  return {
    source_kind: source.source_kind,
    finding_kind: findingKind,
    severity,
    scope_kind: scopeKind,
    scope_id: scopeId,
    summary: evidence.summary,
    primary_source: source,
    evidence: [evidence],
    capabilities,
  };
}

function resourceSource(
  resource: ResourceSnapshot,
  capability: SupervisorSourceReference["capability"],
): SupervisorSourceReference {
  return stableSource(
    "resource.snapshot",
    `${resource.platform}:${resource.namespace}`,
    resource.sampled_at,
    capability,
    undefined,
    resource.schema_version,
  );
}

function stableSource(
  sourceKind: string,
  sourceId: string,
  observedAt: string,
  capability: SupervisorSourceReference["capability"],
  recordId?: string,
  schemaVersion?: number,
): SupervisorSourceReference {
  return {
    id: deterministicId(
      "src",
      `${sourceKind}\u0000${sourceId}\u0000${recordId ?? ""}\u0000${observedAt}`,
    ),
    source_kind: sourceKind,
    source_id: sourceId,
    observed_at: observedAt,
    ...(recordId ? { record_id: recordId } : {}),
    ...(schemaVersion !== undefined ? { schema_version: schemaVersion } : {}),
    capability,
  };
}

function findingFingerprint(candidate: Candidate): string {
  return digest(
    [
      candidate.source_kind,
      candidate.finding_kind,
      candidate.scope_kind,
      candidate.scope_id,
      candidate.primary_source.source_id,
    ].join("\u0000"),
  ).slice(0, 32);
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}_${digest(value).slice(0, 24)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validFindings(value: SupervisorFindings | undefined): value is SupervisorFindings {
  return (
    value?.schema_version === SUPERVISOR_FINDING_SCHEMA_VERSION &&
    Array.isArray(value.active) &&
    Array.isArray(value.transitions)
  );
}

function boundCapabilities(capabilities: SupervisorCapability[]): SupervisorCapability[] {
  const unique = new Map(capabilities.map((entry) => [entry.source_kind, entry]));
  return [...unique.values()].slice(0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_capabilities);
}

function groupKey(group: ResourceProcessGroup): string {
  return `${group.kind}:${group.id}`;
}
function groupLabel(group: ResourceProcessGroup): string {
  return group.kind === "unattributed"
    ? "Unattributed processes"
    : `${group.kind} group ${group.id}`;
}
function severityRank(value: SupervisorFindingSeverity): number {
  return value === "critical" ? 3 : value === "warning" ? 2 : 1;
}
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
