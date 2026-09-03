import { createHash } from "node:crypto";
import type { CoordinationHealthSnapshot } from "../agents/health.ts";
import type {
  ResourceProcessGroup,
  ResourceProcessSample,
  ResourceSnapshot,
} from "../resources/contract.ts";
import {
  type ObservedHookHealth,
  type ObservedServiceHealth,
  SUPERVISOR_DIAGNOSTIC_LIMITS,
  SUPERVISOR_FINDING_POLICY,
  SUPERVISOR_FINDING_SCHEMA_VERSION,
  type SupervisorActivitySnapshot,
  type SupervisorCapability,
  type SupervisorFinding,
  type SupervisorFindingAttribution,
  type SupervisorFindingEvidence,
  type SupervisorFindingSeverity,
  type SupervisorFindings,
  type SupervisorFindingWorkloadContext,
  type SupervisorHistory,
  type SupervisorLogFeed,
  type SupervisorSourceReference,
} from "./contract.ts";
import type { SupervisorHookHealth } from "./hook-health.ts";
import { evaluateHookHealthAlerts } from "./hook-health-alerts.ts";

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
  attribution?: SupervisorFindingAttribution;
  workload_context?: SupervisorFindingWorkloadContext;
}

export interface SupervisorFindingEvaluationInput {
  previous?: SupervisorFindings;
  resource: ResourceSnapshot;
  services: readonly ObservedServiceHealth[];
  hooks: readonly ObservedHookHealth[];
  history: SupervisorHistory;
  logFeed: SupervisorLogFeed;
  hookHealth?: SupervisorHookHealth;
  coordination?: CoordinationHealthSnapshot;
  activity?: SupervisorActivitySnapshot;
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
  const transitions = new Map(previous.transitions.map((entry) => [entry.id, entry]));

  for (const candidate of candidates) {
    const fingerprint = findingFingerprint(candidate);
    current.add(fingerprint);
    const prior = priorActive.get(fingerprint) ?? recentResolved(previous, fingerprint, observedAt);
    const openedAt = prior?.opened_at ?? candidate.primary_source.observed_at;
    const occurrenceCount = prior
      ? prior.state === "resolved"
        ? prior.occurrence_count + 1
        : prior.occurrence_count
      : 1;
    const peak = peakEvidence(prior, candidate.evidence, observedAt);
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
      occurrence_count: occurrenceCount,
      ...peak,
      ...(candidate.attribution ? { attribution: candidate.attribution } : {}),
      ...(candidate.workload_context ? { workload_context: candidate.workload_context } : {}),
      primary_source: candidate.primary_source,
      evidence: candidate.evidence.slice(0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_evidence_per_finding),
      capabilities: boundCapabilities(candidate.capabilities),
    };
    active.push(finding);
    transitions.set(finding.id, finding);
  }

  for (const prior of priorActive.values()) {
    if (current.has(prior.fingerprint)) continue;
    transitions.set(prior.id, {
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
    transitions: [...transitions.values()]
      .sort((left, right) => left.observed_at.localeCompare(right.observed_at))
      .slice(-SUPERVISOR_DIAGNOSTIC_LIMITS.max_findings),
  };
}

function evaluateCandidates(input: {
  resource: ResourceSnapshot;
  services: readonly ObservedServiceHealth[];
  hooks: readonly ObservedHookHealth[];
  history: SupervisorHistory;
  logFeed: SupervisorLogFeed;
  hookHealth?: SupervisorHookHealth;
  coordination?: CoordinationHealthSnapshot;
  activity?: SupervisorActivitySnapshot;
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
  for (const disk of input.resource.disks ?? []) {
    if (disk.state !== "supported" || disk.available_bytes === null || disk.used_percent === null)
      continue;
    if (disk.used_percent < 90 && disk.available_bytes >= 5 * GIB) continue;
    out.push(
      candidate(
        "machine.disk-space",
        disk.used_percent >= 97 || disk.available_bytes < GIB ? "critical" : "warning",
        "filesystem",
        disk.path,
        `Filesystem ${disk.path} has ${round1(disk.available_bytes / GIB)} GiB available (${disk.used_percent}% used).`,
        source,
        disk.used_percent,
        "percent",
        [resourceCapability],
      ),
    );
  }
  const pressure = input.resource.pressure;
  if (pressure?.state === "supported" || pressure?.state === "partial") {
    for (const [kind, full] of [
      ["memory", pressure.memory_full],
      ["io", pressure.io_full],
    ] as const) {
      if (!full || (full.avg10 < 50 && !(full.avg10 >= 20 && full.avg10 > full.avg60))) continue;
      const direction =
        full.avg10 > full.avg60 ? "rising" : full.avg10 < full.avg60 ? "falling" : "steady";
      addMachine(
        `machine.${kind}-full-stall`,
        full.avg10 >= 50 ? "critical" : "warning",
        `All non-idle tasks stalled on ${kind} for ${full.avg10}% of the recent 10-second window (${direction}; 60s ${full.avg60}%, 300s ${full.avg300}%).`,
        full.avg10,
        "percent",
      );
    }
    for (const [kind, value, threshold] of [
      ["cpu", pressure.cpu, 20],
      ["memory", pressure.memory, 5],
      ["io", pressure.io, 10],
    ] as const) {
      if (!value || value.avg60 < threshold) continue;
      addMachine(
        `machine.${kind}-stall`,
        value.avg60 >= threshold * 2 ? "critical" : "warning",
        `At least one task stalled on ${kind} for ${value.avg60}% of the last minute.`,
        value.avg60,
        "percent",
      );
    }
  }
  const oom = input.resource.oom;
  if (
    oom?.state === "supported" &&
    oom.last_kill_age_ms !== null &&
    oom.last_kill_age_ms <= 60_000 &&
    oom.total_kills !== null
  ) {
    addMachine(
      "machine.oom-kill",
      "critical",
      `Kernel OOM kills increased ${Math.round(oom.last_kill_age_ms / 1000)}s ago; ${oom.total_kills} kills reported in total. Work may have been lost.`,
      oom.total_kills,
      "count",
    );
  }
  const host = input.resource.host;
  const hostAge = host
    ? Date.parse(input.resource.sampled_at) +
      input.resource.sample_duration_ms -
      Date.parse(host.sampled_at)
    : NaN;
  if (
    host?.machine &&
    (host.state === "supported" || host.state === "partial") &&
    hostAge >= 0 &&
    hostAge <= 30_000
  ) {
    const hostSource = stableSource(
      "resource.windows-host",
      "windows-host",
      host.sampled_at,
      host.state,
    );
    for (const [kind, value, threshold, severity] of [
      ["cpu", host.machine.cpu_percent, MACHINE_CPU_THRESHOLD, "warning"],
      ["memory", host.machine.memory_percent, MACHINE_MEMORY_THRESHOLD, "critical"],
    ] as const) {
      if (value === null || value < threshold) continue;
      out.push(
        candidate(
          `machine.host-${kind}-pressure`,
          severity,
          "machine",
          "windows-host",
          `Windows host ${kind} is ${value}%.`,
          hostSource,
          value,
          "percent",
          [{ source_kind: "resource.windows-host", state: host.state }],
        ),
      );
    }
    for (const disk of host.disks) {
      if (
        disk.state !== "supported" ||
        disk.available_bytes === null ||
        disk.used_percent === null ||
        (disk.used_percent < 90 && disk.available_bytes >= 5 * GIB)
      )
        continue;
      out.push(
        candidate(
          "machine.host-disk-space",
          disk.used_percent >= 97 || disk.available_bytes < GIB ? "critical" : "warning",
          "filesystem",
          `windows-host:${disk.path}`,
          `Windows filesystem ${disk.path} has ${round1(disk.available_bytes / GIB)} GiB available (${disk.used_percent}% used).`,
          hostSource,
          disk.used_percent,
          "percent",
          [{ source_kind: "resource.windows-host", state: host.state }],
        ),
      );
    }
  }
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
        serviceStaleSummary(service),
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
        resourceSource(input.resource, resourceCapability.state, process.start_id),
        process.rss_bytes,
        "bytes",
        [resourceCapability],
        processAttribution(process),
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
        group.id,
        `${groupLabel(group)} uses ${group.rss_bytes} resident bytes.`,
        source,
        group.rss_bytes,
        "bytes",
        [resourceCapability],
        groupAttribution(group),
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
        group.id,
        `${groupLabel(group)} owns ${group.process_count} visible processes.`,
        source,
        group.process_count,
        "processes",
        [resourceCapability],
        groupAttribution(group),
      ),
    );
  out.push(
    ...memoryGrowthCandidates(input.resource, input.history, resourceCapability, input.activity),
  );

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

  if (input.hookHealth) {
    const hookCapability: SupervisorCapability = {
      source_kind: input.hookHealth.capability.source_kind,
      state:
        input.hookHealth.capability.state === "unavailable"
          ? "error"
          : input.hookHealth.capability.state,
      ...(input.hookHealth.capability.reason
        ? {
            reason_code: input.hookHealth.capability.reason,
            detail: input.hookHealth.capability.reason,
          }
        : {}),
    };
    for (const alert of evaluateHookHealthAlerts(input.hookHealth)) {
      const alertSource = stableSource(
        "hook.terminal-log",
        alert.source.id,
        alert.source.observed_at,
        hookCapability.state,
        alert.source.id,
        input.hookHealth.schema_version,
      );
      out.push(
        candidate(
          alert.finding_kind,
          alert.severity,
          "hook",
          alert.scope_id,
          alert.summary,
          alertSource,
          alert.observed_value,
          alert.unit,
          [hookCapability],
          alert.owner_id
            ? {
                state: "attributed",
                owner_kind: "agent",
                owner_id: alert.owner_id,
              }
            : { state: "unattributed", reason_code: "no-validated-process-anchor" },
        ),
      );
    }
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
  activity?: SupervisorActivitySnapshot,
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
        memoryGrowthCandidate(
          group,
          activity,
          "resource.memory-growth",
          `${groupLabel(group)} grew by ${delta} resident bytes since ${baseline.sampled_at}.`,
          resourceSource(resource, capability.state),
          delta,
          capability,
        ),
      ];
    })
    .slice(0, 5);
}

function memoryGrowthCandidate(
  group: ResourceProcessGroup,
  activity: SupervisorActivitySnapshot | undefined,
  findingKind: string,
  summary: string,
  source: SupervisorSourceReference,
  delta: number,
  resourceCapability: SupervisorCapability,
): Candidate {
  const workload = workloadContext(group, activity, source.observed_at);
  const severity: SupervisorFindingSeverity =
    workload.context.relationship === "unexpected-idle-growth" ? "critical" : "warning";
  const result = candidate(
    findingKind,
    severity,
    group.kind,
    group.id,
    summary,
    source,
    delta,
    "bytes",
    [resourceCapability, workload.capability],
    groupAttribution(group),
    workload.context,
  );
  if (workload.evidence) result.evidence.push(workload.evidence);
  return result;
}

function workloadContext(
  group: ResourceProcessGroup,
  activity: SupervisorActivitySnapshot | undefined,
  observedAt: string,
): {
  context: SupervisorFindingWorkloadContext;
  capability: SupervisorCapability;
  evidence?: SupervisorFindingEvidence;
} {
  const capability = activity?.capability ?? {
    source_kind: "coordination.activity-projection",
    state: "unsupported" as const,
    reason_code: "activity-projection-not-captured",
  };
  const matched =
    group.kind === "agent"
      ? activity?.entries.find((entry) => entry.scope_id === group.id)
      : undefined;
  if (!matched) {
    return {
      context: {
        relationship: "unknown",
        declared_activity: "unknown",
        task_state: "unknown",
        observed_at: activity?.observed_at ?? observedAt,
        source: stableSource(
          "coordination.activity-projection",
          group.kind === "agent" ? group.id : "not-applicable",
          activity?.observed_at ?? observedAt,
          capability.state,
          undefined,
          activity?.schema_version,
        ),
      },
      capability,
    };
  }
  const relationship =
    matched.declared_activity === "working" && matched.task_state === "active"
      ? "active-work"
      : matched.declared_activity === "unknown"
        ? "unknown"
        : "unexpected-idle-growth";
  const summary = `Agent declared ${matched.declared_activity} with task state ${matched.task_state}.`;
  return {
    context: {
      relationship,
      declared_activity: matched.declared_activity,
      task_state: matched.task_state,
      observed_at: matched.observed_at,
      source: matched.source,
    },
    capability,
    evidence: {
      id: deterministicId("ev", `${findingKindKey(group)}\u0000${matched.source.id}`),
      source: matched.source,
      summary,
    },
  };
}

function findingKindKey(group: ResourceProcessGroup): string {
  return `resource.memory-growth\u0000${group.kind}\u0000${group.id}`;
}

function processAttribution(process: ResourceProcessSample): SupervisorFindingAttribution {
  if (
    (process.owner_kind === "agent" || process.owner_kind === "service") &&
    process.owner_id &&
    process.owner_root_pid !== null
  ) {
    return {
      state: "attributed",
      owner_kind: process.owner_kind,
      owner_id: process.owner_id,
      owner_root_pid: process.owner_root_pid,
    };
  }
  return { state: "unattributed", reason_code: "no-validated-process-anchor" };
}

function groupAttribution(group: ResourceProcessGroup): SupervisorFindingAttribution {
  if (group.kind === "agent" || group.kind === "service") {
    return {
      state: "attributed",
      owner_kind: group.kind,
      owner_id: group.id,
      ...(group.root_pids[0] !== undefined ? { owner_root_pid: group.root_pids[0] } : {}),
    };
  }
  return { state: "unattributed", reason_code: "no-validated-process-anchor" };
}

function serviceStaleSummary(service: ObservedServiceHealth): string {
  if (service.reason === "recorded-running-process-missing")
    return `${service.id} was recorded running, but its process is no longer present.`;
  if (service.reason === "remote-heartbeat-expired")
    return `${service.id} has an expired remote heartbeat.`;
  if (service.reason === "supervisor-reported-error") return `${service.id} reported an error.`;
  return `${service.id} has stale liveness evidence.`;
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
  attribution?: SupervisorFindingAttribution,
  workloadContext?: SupervisorFindingWorkloadContext,
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
    ...(attribution ? { attribution } : {}),
    ...(workloadContext ? { workload_context: workloadContext } : {}),
  };
}

function resourceSource(
  resource: ResourceSnapshot,
  capability: SupervisorSourceReference["capability"],
  recordId?: string,
): SupervisorSourceReference {
  return stableSource(
    "resource.snapshot",
    `${resource.platform}:${resource.namespace}`,
    resource.sampled_at,
    capability,
    recordId,
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

function recentResolved(
  findings: SupervisorFindings,
  fingerprint: string,
  observedAt: string,
): SupervisorFinding | undefined {
  const observedMs = Date.parse(observedAt);
  return findings.transitions
    .filter(
      (entry) =>
        entry.fingerprint === fingerprint &&
        entry.state === "resolved" &&
        entry.resolved_at !== undefined &&
        observedMs - Date.parse(entry.resolved_at) >= 0 &&
        observedMs - Date.parse(entry.resolved_at) <= SUPERVISOR_FINDING_POLICY.episode_gap_ms,
    )
    .sort((left, right) => (right.resolved_at ?? "").localeCompare(left.resolved_at ?? ""))[0];
}

function peakEvidence(
  prior: SupervisorFinding | undefined,
  evidence: readonly SupervisorFindingEvidence[],
  observedAt: string,
): Pick<SupervisorFinding, "peak_observed_value" | "peak_observed_at" | "peak_unit"> {
  const current = evidence
    .filter(
      (entry): entry is SupervisorFindingEvidence & { observed_value: number } =>
        entry.observed_value !== undefined,
    )
    .sort((left, right) => right.observed_value - left.observed_value)[0];
  if (
    prior?.peak_observed_value !== undefined &&
    (!current || prior.peak_observed_value >= current.observed_value)
  ) {
    return {
      peak_observed_value: prior.peak_observed_value,
      ...(prior.peak_observed_at ? { peak_observed_at: prior.peak_observed_at } : {}),
      ...(prior.peak_unit ? { peak_unit: prior.peak_unit } : {}),
    };
  }
  return current
    ? {
        peak_observed_value: current.observed_value,
        peak_observed_at: current.source.observed_at || observedAt,
        ...(current.unit ? { peak_unit: current.unit } : {}),
      }
    : {};
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
