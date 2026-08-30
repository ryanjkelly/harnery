import type { ResourceSnapshot } from "../resources/contract.ts";
import {
  SUPERVISOR_HISTORY_SCHEMA_VERSION,
  type SupervisorHistory,
  type SupervisorHistoryPoint,
} from "./contract.ts";

export const SUPERVISOR_HISTORY_INTERVAL_MS = 10_000;
export const SUPERVISOR_HISTORY_MAX_POINTS = 90;

export function updateSupervisorHistory(
  previous: SupervisorHistory | undefined,
  resource: ResourceSnapshot,
): { history: SupervisorHistory; changed: boolean } {
  const prior = validHistory(previous) ? previous.points : [];
  const lastAt = prior.length > 0 ? Date.parse(prior[prior.length - 1]!.sampled_at) : Number.NaN;
  const sampledAt = Date.parse(resource.sampled_at);
  if (
    Number.isFinite(lastAt) &&
    Number.isFinite(sampledAt) &&
    sampledAt - lastAt < SUPERVISOR_HISTORY_INTERVAL_MS
  ) {
    return {
      history: {
        schema_version: SUPERVISOR_HISTORY_SCHEMA_VERSION,
        interval_ms: SUPERVISOR_HISTORY_INTERVAL_MS,
        max_points: SUPERVISOR_HISTORY_MAX_POINTS,
        points: prior,
      },
      changed: false,
    };
  }
  const point: SupervisorHistoryPoint = {
    sampled_at: resource.sampled_at,
    machine: {
      cpu_percent: resource.machine.cpu_percent,
      memory_percent: resource.machine.memory_percent,
      memory_used_bytes: resource.machine.memory_used_bytes,
      swap_used_bytes: resource.machine.swap_used_bytes,
      process_count: resource.machine.process_count,
    },
    groups: resource.groups.map((group) => ({ ...group, root_pids: [...group.root_pids] })),
  };
  return {
    history: {
      schema_version: SUPERVISOR_HISTORY_SCHEMA_VERSION,
      interval_ms: SUPERVISOR_HISTORY_INTERVAL_MS,
      max_points: SUPERVISOR_HISTORY_MAX_POINTS,
      points: [...prior, point].slice(-SUPERVISOR_HISTORY_MAX_POINTS),
    },
    changed: true,
  };
}

function validHistory(value: SupervisorHistory | undefined): value is SupervisorHistory {
  return (
    value?.schema_version === SUPERVISOR_HISTORY_SCHEMA_VERSION &&
    Array.isArray(value.points) &&
    value.points.length <= SUPERVISOR_HISTORY_MAX_POINTS
  );
}
