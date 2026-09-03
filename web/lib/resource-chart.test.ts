import { describe, expect, test } from "bun:test";
import type { ResourceMachineSample } from "../../src/core/resources/contract";
import { type ResourceMachineHistory, resourceChartData } from "./resource-chart";

const now = Date.parse("2026-09-03T10:00:00Z");
const machine: ResourceMachineSample = {
  cpu_percent: 42,
  cpu_logical_count: 8,
  memory_percent: 50,
  memory_total_bytes: 16e9,
  memory_available_bytes: 8e9,
  memory_used_bytes: 8e9,
  swap_total_bytes: 1e9,
  swap_used_bytes: 0,
  process_count: 240,
  load_average: [3, 2, 1],
};
const current = { machine, sampledAt: new Date(now).toISOString() };
function point(ageMs: number, cpu: number | null = 20): ResourceMachineHistory {
  return {
    sampled_at: new Date(now - ageMs).toISOString(),
    machine: {
      cpu_percent: cpu,
      memory_percent: 45,
      memory_used_bytes: 7e9,
      swap_used_bytes: 0,
      process_count: 200,
    },
  };
}

describe("resource chart history", () => {
  test("uses the selected time window and current card value, not history array positions", () => {
    const history = [point(120_000), point(30_000), point(0, 10), point(-1_000)];
    const minute = resourceChartData(history, current, "cpu_percent", 1, now);
    expect(minute.samples.map((sample) => sample.value)).toEqual([20, 42]);
    expect(minute.samples.map((sample) => sample.x)).toEqual([150, 300]);
    expect(minute.ceiling).toBe(100);
    expect(resourceChartData(history, current, "cpu_percent", 5, now).samples).toHaveLength(3);
  });

  test("leaves gaps for missing readings and paused collection", () => {
    const history = [point(100_000), point(90_000, null), point(80_000), point(10_000)];
    const chart = resourceChartData(history, current, "cpu_percent", 5, now);
    expect(chart.paths).toHaveLength(3);
    expect(chart.paths[2]).toContain(" L");
  });

  test("does not invent historical load averages and preserves process counts above 100", () => {
    const history = [point(20_000), point(10_000)];
    expect(resourceChartData(history, current, "load_average_1", 15, now).samples).toMatchObject([
      { value: 3 },
    ]);
    const processes = resourceChartData(history, current, "process_count", 15, now);
    expect(processes.ceiling).toBeGreaterThanOrEqual(240);
    expect(processes.samples.at(-1)?.value).toBe(240);
    expect(processes.samples.at(-1)?.y).toBeGreaterThan(0);
  });

  test("keeps stale samples at their actual time and rejects invalid measurements", () => {
    const stale = { ...current, sampledAt: new Date(now - 120_000).toISOString() };
    expect(resourceChartData([], stale, "cpu_percent", 1, now).samples).toHaveLength(0);
    expect(resourceChartData([], stale, "cpu_percent", 5, now).samples[0]?.x).toBe(180);
    const invalid = { ...current, machine: { ...machine, cpu_percent: NaN } };
    expect(resourceChartData([point(10_000, -2)], invalid, "cpu_percent", 1, now).paths).toEqual(
      [],
    );
  });
});
