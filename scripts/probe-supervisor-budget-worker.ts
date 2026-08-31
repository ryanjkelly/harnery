import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const startedAt = performance.now();
const [{ runSupervisor }, contract, { supervisorPaths }] = await Promise.all([
  import("../src/core/supervisor/service.ts"),
  import("../src/core/supervisor/contract.ts"),
  import("../src/core/supervisor/storage.ts"),
]);
const SUPERVISOR_RESOURCE_BUDGET =
  "SUPERVISOR_RESOURCE_BUDGET" in contract
    ? contract.SUPERVISOR_RESOURCE_BUDGET
    : {
        max_rss_bytes: 128 * 1_024 * 1_024,
        max_cycle_duration_ms: 50,
        max_startup_duration_ms: 2_000,
        max_cache_bytes: 8 * 1_024 * 1_024,
        max_regression_ratio: 1.2,
      };
const importDurationMs = performance.now() - startedAt;
const coordRoot = mkdtempSync(join(tmpdir(), "harn-supervisor-budget-"));

try {
  const cycleDurations: number[] = [];
  const resourceDurations: number[] = [];
  const rssSamples: number[] = [];
  let firstCycleDurationMs = 0;

  for (let iteration = 0; iteration < 31; iteration += 1) {
    const cycleStartedAt = performance.now();
    await runSupervisor({
      coordRoot,
      keepAlive: true,
      maxCycles: 1,
      intervalMs: 500,
      wait: async () => {},
    });
    const elapsedMs = performance.now() - cycleStartedAt;
    if (iteration === 0) firstCycleDurationMs = elapsedMs;
    else cycleDurations.push(elapsedMs);

    const snapshot = JSON.parse(await Bun.file(supervisorPaths(coordRoot).snapshot).text()) as {
      collector_duration_ms?: number;
      resource_sample_duration_ms?: number;
    };
    if (iteration > 0) {
      resourceDurations.push(snapshot.resource_sample_duration_ms ?? 0);
      rssSamples.push(process.memoryUsage().rss);
    }
  }

  const result = {
    schema: "harnery.supervisor-budget-probe/v1",
    ref: process.env.HARNERY_PROBE_REF ?? "unknown",
    samples: cycleDurations.length,
    startup_duration_ms: round(importDurationMs + firstCycleDurationMs),
    cycle_duration_ms: {
      median: percentile(cycleDurations, 0.5),
      p95: percentile(cycleDurations, 0.95),
    },
    collectors: {
      resource: {
        median_ms: percentile(resourceDurations, 0.5),
        p95_ms: percentile(resourceDurations, 0.95),
      },
    },
    rss_bytes: {
      after_warmup: rssSamples[0] ?? process.memoryUsage().rss,
      max: Math.max(...rssSamples, process.memoryUsage().rss),
    },
    cache_bytes: directoryBytes(join(coordRoot, ".harnery")),
    ceilings: SUPERVISOR_RESOURCE_BUDGET,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  rmSync(coordRoot, { recursive: true, force: true });
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return round(sorted[index] ?? 0);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function directoryBytes(root: string): number {
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += directoryBytes(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}
