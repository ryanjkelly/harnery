import type { ResourceMachineSample } from "../../src/core/resources/contract";
import type { SupervisorHistoryPoint } from "../../src/core/supervisor/contract";

export const RESOURCE_LOOKBACK_MINUTES = [1, 5, 15] as const;
export type ResourceLookback = (typeof RESOURCE_LOOKBACK_MINUTES)[number];
export type ResourceMetric = "cpu_percent" | "memory_percent" | "load_average_1" | "process_count";
export type ResourceMachineHistory = Pick<SupervisorHistoryPoint, "sampled_at" | "machine">;

export function resourceChartData(
  history: readonly ResourceMachineHistory[],
  current: { machine: ResourceMachineSample; sampledAt: string },
  metric: ResourceMetric,
  minutes: ResourceLookback,
  nowMs: number,
) {
  const start = nowMs - minutes * 60_000;
  const byTime = new Map<number, number | null>();
  const add = (at: number, value: number | null | undefined) => {
    if (!Number.isFinite(at) || at < start || at > nowMs) return;
    byTime.set(
      at,
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null,
    );
  };
  for (const point of history) add(Date.parse(point.sampled_at), point.machine[metric]);
  add(
    Date.parse(current.sampledAt),
    metric === "load_average_1" ? current.machine.load_average?.[0] : current.machine[metric],
  );
  const entries = [...byTime].sort(([left], [right]) => left - right);
  const maximum = Math.max(1, ...entries.map(([, value]) => value ?? 0));
  const ceiling = metric.endsWith("percent") ? 100 : niceCeiling(maximum);
  const samples: Array<{ at: number; value: number; x: number; y: number }> = [];
  const paths: string[] = [];
  let path = "";
  let previousAt: number | null = null;
  for (const [at, value] of entries) {
    if (value === null) {
      if (path) paths.push(path);
      path = "";
      previousAt = null;
      continue;
    }
    const x = ((at - start) / (nowMs - start)) * 300;
    const y = 96 - Math.min(value / ceiling, 1) * 92;
    if (previousAt !== null && at - previousAt > 30_000) {
      if (path) paths.push(path);
      path = "";
    }
    path += `${path ? " L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    samples.push({ at, value, x, y });
    previousAt = at;
  }
  if (path) paths.push(path);
  return { samples, paths, ceiling };
}

function niceCeiling(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude / 0.5) * magnitude * 0.5;
}
