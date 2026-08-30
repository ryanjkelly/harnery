import { createHash, randomUUID } from "node:crypto";
import type { ResourceProcessGroup, ResourceSnapshot } from "../resources/contract.ts";
import {
  type ObservedHookHealth,
  type ObservedServiceHealth,
  SUPERVISOR_ANOMALY_SCHEMA_VERSION,
  type SupervisorAnomalies,
  type SupervisorAnomalyEvidence,
  type SupervisorAnomalySeverity,
  type SupervisorAnomalyTransition,
  type SupervisorHistory,
  type SupervisorLogFeed,
} from "./contract.ts";
import { recentSupervisorLogs } from "./log-feed.ts";

export const SUPERVISOR_MAX_ANOMALY_TRANSITIONS = 100;
const MAX_ACTIVE_ANOMALIES = 32;
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
  fingerprint: string;
  kind: SupervisorAnomalyTransition["kind"];
  severity: SupervisorAnomalySeverity;
  evidence: SupervisorAnomalyEvidence;
}

export function updateSupervisorAnomalies(input: {
  previous?: SupervisorAnomalies;
  resource: ResourceSnapshot;
  services: readonly ObservedServiceHealth[];
  hooks: readonly ObservedHookHealth[];
  history: SupervisorHistory;
  logFeed: SupervisorLogFeed;
  now?: Date;
}): SupervisorAnomalies {
  const now = input.now ?? new Date();
  const observedAt = now.toISOString();
  const previous = validAnomalies(input.previous)
    ? input.previous
    : {
        schema_version: SUPERVISOR_ANOMALY_SCHEMA_VERSION,
        max_transitions: SUPERVISOR_MAX_ANOMALY_TRANSITIONS,
        active: [],
        transitions: [],
      };
  const candidates = evaluateCandidates(input)
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
    .slice(0, MAX_ACTIVE_ANOMALIES);
  const priorActive = new Map(previous.active.map((entry) => [entry.fingerprint, entry]));
  const current = new Map(candidates.map((entry) => [entry.fingerprint, entry]));
  const active: SupervisorAnomalyTransition[] = [];
  const transitions = [...previous.transitions];

  for (const candidate of candidates) {
    const prior = priorActive.get(candidate.fingerprint);
    const entry: SupervisorAnomalyTransition = {
      id: prior?.id ?? randomUUID(),
      fingerprint: candidate.fingerprint,
      kind: candidate.kind,
      severity: candidate.severity,
      state: "opened",
      opened_at: prior?.opened_at ?? observedAt,
      observed_at: observedAt,
      evidence: candidate.evidence,
    };
    active.push(entry);
    if (!prior) transitions.push(entry);
  }

  for (const prior of priorActive.values()) {
    if (current.has(prior.fingerprint)) continue;
    transitions.push({
      ...prior,
      state: "resolved",
      observed_at: observedAt,
      resolved_at: observedAt,
      evidence: {
        ...prior.evidence,
        summary: `${prior.evidence.summary} Condition returned below its threshold.`,
        recent_logs: recentSupervisorLogs(input.logFeed, 10),
        history: input.history.points.slice(-12),
      },
    });
  }

  return {
    schema_version: SUPERVISOR_ANOMALY_SCHEMA_VERSION,
    max_transitions: SUPERVISOR_MAX_ANOMALY_TRANSITIONS,
    active,
    transitions: transitions.slice(-SUPERVISOR_MAX_ANOMALY_TRANSITIONS),
  };
}

function evaluateCandidates(input: {
  resource: ResourceSnapshot;
  services: readonly ObservedServiceHealth[];
  hooks: readonly ObservedHookHealth[];
  history: SupervisorHistory;
  logFeed: SupervisorLogFeed;
}): Candidate[] {
  const candidates: Candidate[] = [];
  const common = commonEvidence(input);
  const machine = input.resource.machine;
  if ((machine.cpu_percent ?? 0) >= MACHINE_CPU_THRESHOLD) {
    candidates.push(
      candidate("machine-cpu", "machine", "warning", {
        ...common,
        summary: `Machine CPU is ${machine.cpu_percent}%.`,
        observed_value: machine.cpu_percent ?? undefined,
        threshold: MACHINE_CPU_THRESHOLD,
        unit: "percent",
      }),
    );
  }
  if ((machine.memory_percent ?? 0) >= MACHINE_MEMORY_THRESHOLD) {
    candidates.push(
      candidate("machine-memory", "machine", "critical", {
        ...common,
        summary: `Machine memory is ${machine.memory_percent}%.`,
        observed_value: machine.memory_percent ?? undefined,
        threshold: MACHINE_MEMORY_THRESHOLD,
        unit: "percent",
      }),
    );
  }
  const swapPercent =
    machine.swap_total_bytes && machine.swap_used_bytes !== null
      ? round1((machine.swap_used_bytes / machine.swap_total_bytes) * 100)
      : null;
  if ((swapPercent ?? 0) >= MACHINE_SWAP_THRESHOLD) {
    candidates.push(
      candidate("machine-swap", "machine", "warning", {
        ...common,
        summary: `Machine swap is ${swapPercent}% used.`,
        observed_value: swapPercent ?? undefined,
        threshold: MACHINE_SWAP_THRESHOLD,
        unit: "percent",
      }),
    );
  }
  if (input.resource.collector_cpu_ms >= COLLECTOR_CPU_THRESHOLD_MS) {
    candidates.push(
      candidate("collector-overhead", "supervisor", "warning", {
        ...common,
        summary: `Supervisor resource collection used ${input.resource.collector_cpu_ms} ms of CPU.`,
        observed_value: input.resource.collector_cpu_ms,
        threshold: COLLECTOR_CPU_THRESHOLD_MS,
        unit: "milliseconds",
      }),
    );
  }
  for (const service of input.services.filter((entry) => entry.state === "stale").slice(0, 5)) {
    candidates.push(
      candidate("service-stale", service.id, "warning", {
        ...common,
        summary: `${service.id} has stale liveness evidence.`,
        services: [service],
      }),
    );
  }
  for (const hook of input.hooks.filter((entry) => entry.long_running).slice(0, 5)) {
    candidates.push(
      candidate("hook-long-running", `${hook.owner_id}:${hook.pid}`, "warning", {
        ...common,
        summary: `Hook process ${hook.pid} has run for ${hook.age_seconds} seconds.`,
        observed_value: hook.age_seconds,
        threshold: 120,
        unit: "seconds",
        hooks: [hook],
      }),
    );
  }
  for (const process of input.resource.processes
    .filter((entry) => entry.rss_bytes >= PROCESS_MEMORY_THRESHOLD)
    .slice(0, 5)) {
    candidates.push(
      candidate("process-memory", String(process.start_id), "critical", {
        ...common,
        summary: `Process ${process.pid} uses ${process.rss_bytes} resident bytes.`,
        observed_value: process.rss_bytes,
        threshold: PROCESS_MEMORY_THRESHOLD,
        unit: "bytes",
      }),
    );
  }
  for (const group of input.resource.groups
    .filter((entry) => entry.rss_bytes >= GROUP_MEMORY_THRESHOLD)
    .slice(0, 5)) {
    candidates.push(
      candidate("group-memory", groupKey(group), "critical", {
        ...common,
        summary: `${groupLabel(group)} uses ${group.rss_bytes} resident bytes.`,
        observed_value: group.rss_bytes,
        threshold: GROUP_MEMORY_THRESHOLD,
        unit: "bytes",
      }),
    );
  }
  for (const group of input.resource.groups
    .filter((entry) => entry.process_count >= OWNER_PROCESS_THRESHOLD)
    .slice(0, 5)) {
    candidates.push(
      candidate("owner-process-count", groupKey(group), "warning", {
        ...common,
        summary: `${groupLabel(group)} owns ${group.process_count} visible processes.`,
        observed_value: group.process_count,
        threshold: OWNER_PROCESS_THRESHOLD,
        unit: "processes",
      }),
    );
  }
  candidates.push(...memoryGrowthCandidates(input, common));
  return candidates;
}

function memoryGrowthCandidates(
  input: { resource: ResourceSnapshot; history: SupervisorHistory },
  common: SupervisorAnomalyEvidence,
): Candidate[] {
  const newestAt = Date.parse(input.resource.sampled_at);
  const baseline = input.history.points.find(
    (point) => newestAt - Date.parse(point.sampled_at) <= MEMORY_GROWTH_WINDOW_MS,
  );
  if (!baseline || newestAt - Date.parse(baseline.sampled_at) < 60_000) return [];
  const byKey = new Map(baseline.groups.map((group) => [groupKey(group), group]));
  return input.resource.groups
    .flatMap((group): Candidate[] => {
      const prior = byKey.get(groupKey(group));
      if (!prior || prior.rss_bytes <= 0) return [];
      const delta = group.rss_bytes - prior.rss_bytes;
      if (
        delta < MEMORY_GROWTH_MIN_BYTES ||
        group.rss_bytes / prior.rss_bytes < MEMORY_GROWTH_RATIO
      ) {
        return [];
      }
      return [
        candidate("memory-growth", groupKey(group), "warning", {
          ...common,
          summary: `${groupLabel(group)} grew by ${delta} resident bytes since ${baseline.sampled_at}.`,
          observed_value: delta,
          threshold: MEMORY_GROWTH_MIN_BYTES,
          unit: "bytes",
        }),
      ];
    })
    .slice(0, 5);
}

function commonEvidence(input: {
  resource: ResourceSnapshot;
  services: readonly ObservedServiceHealth[];
  hooks: readonly ObservedHookHealth[];
  history: SupervisorHistory;
  logFeed: SupervisorLogFeed;
}): SupervisorAnomalyEvidence {
  return {
    summary: "Local diagnostic threshold crossed.",
    resource: {
      sampled_at: input.resource.sampled_at,
      machine: input.resource.machine,
      groups: input.resource.groups.slice(0, 20),
      collector_cpu_ms: input.resource.collector_cpu_ms,
      sample_duration_ms: input.resource.sample_duration_ms,
    },
    services: input.services,
    hooks: input.hooks.slice(0, 10),
    history: input.history.points.slice(-12),
    recent_logs: recentSupervisorLogs(input.logFeed, 10),
  };
}

function candidate(
  kind: SupervisorAnomalyTransition["kind"],
  subject: string,
  severity: SupervisorAnomalySeverity,
  evidence: SupervisorAnomalyEvidence,
): Candidate {
  return {
    fingerprint: createHash("sha256").update(`${kind}:${subject}`).digest("hex").slice(0, 24),
    kind,
    severity,
    evidence,
  };
}

function groupKey(group: ResourceProcessGroup): string {
  return `${group.kind}:${group.id}`;
}

function groupLabel(group: ResourceProcessGroup): string {
  if (group.kind === "unattributed") return "Unattributed processes";
  return `${group.kind} group ${group.id}`;
}

function validAnomalies(value: SupervisorAnomalies | undefined): value is SupervisorAnomalies {
  return (
    value?.schema_version === SUPERVISOR_ANOMALY_SCHEMA_VERSION &&
    Array.isArray(value.active) &&
    Array.isArray(value.transitions)
  );
}

function severityRank(value: SupervisorAnomalySeverity): number {
  return value === "critical" ? 3 : value === "warning" ? 2 : 1;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
