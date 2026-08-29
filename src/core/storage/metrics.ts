import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface HarneryLogMetricsDelta {
  accepted?: number;
  encoded?: number;
  appended?: number;
  synced?: number;
  dropped?: number;
  coalesced?: number;
  sampled?: number;
  bytes_accepted?: number;
  bytes_appended?: number;
  bytes_dropped?: number;
  rotations?: number;
  failures?: Record<string, number>;
  append_latency_ms?: number;
  flush_latency_ms?: number;
  queue?: {
    bytes: number;
    capacity_bytes: number;
    peak_bytes: number;
    snapshot_at: string;
  };
}

export interface HarneryLogMetricsV1 {
  schema: "harnery.log-metrics/v1";
  generation: string;
  window_started_at: string;
  last_merge_at: string;
  last_successful_sink_at?: string;
  counters: {
    accepted: number;
    encoded: number;
    appended: number;
    synced: number;
    dropped: number;
    coalesced: number;
    sampled: number;
    bytes_accepted: number;
    bytes_appended: number;
    bytes_dropped: number;
    rotations: number;
  };
  failures: Record<string, number>;
  append_latency_histogram: readonly number[];
  flush_latency_histogram: readonly number[];
  queue?: HarneryLogMetricsDelta["queue"];
}

const HISTOGRAM_BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000];

export class LogMetricsAccumulator {
  #delta: HarneryLogMetricsDelta = {};
  #peakQueueBytes = 0;

  increment<K extends keyof HarneryLogMetricsDelta>(key: K, amount = 1): void {
    if (key === "failures" || key === "queue") return;
    const current = this.#delta[key];
    if (typeof current === "number") this.#delta[key] = (current + amount) as never;
    else this.#delta[key] = amount as never;
  }

  failure(reason: string, amount = 1): void {
    if (!this.#delta.failures) this.#delta.failures = {};
    const failures = this.#delta.failures;
    failures[reason] = (failures[reason] ?? 0) + amount;
  }

  observeQueue(bytes: number, capacityBytes: number, now: Date): void {
    this.#peakQueueBytes = Math.max(this.#peakQueueBytes, bytes);
    this.#delta.queue = {
      bytes,
      capacity_bytes: capacityBytes,
      peak_bytes: this.#peakQueueBytes,
      snapshot_at: now.toISOString(),
    };
  }

  observeLatency(kind: "append_latency_ms" | "flush_latency_ms", milliseconds: number): void {
    this.#delta[kind] = Math.max(0, milliseconds);
  }

  take(): HarneryLogMetricsDelta {
    const delta = this.#delta;
    this.#delta = {};
    this.#peakQueueBytes = 0;
    return delta;
  }
}

export function mergeMetricsSidecar(
  path: string,
  delta: HarneryLogMetricsDelta,
  now = new Date(),
): { merged: boolean; generation_reset: boolean } {
  let current: HarneryLogMetricsV1;
  let generationReset = false;
  try {
    current = existsSync(path)
      ? validateMetrics(JSON.parse(readFileSync(path, "utf8")))
      : emptyMetrics(now);
    generationReset = !existsSync(path);
  } catch {
    current = emptyMetrics(now);
    generationReset = true;
  }
  const merged = mergeMetrics(current, delta, now);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(merged)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    return { merged: true, generation_reset: generationReset };
  } catch {
    return { merged: false, generation_reset: generationReset };
  }
}

export function readMetricsSidecar(path: string): HarneryLogMetricsV1 | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return validateMetrics(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function mergeMetrics(
  current: HarneryLogMetricsV1,
  delta: HarneryLogMetricsDelta,
  now: Date,
): HarneryLogMetricsV1 {
  const counters = { ...current.counters };
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) {
    counters[key] += delta[key] ?? 0;
  }
  const failures = { ...current.failures };
  for (const [reason, count] of Object.entries(delta.failures ?? {})) {
    failures[reason] = (failures[reason] ?? 0) + count;
  }
  return {
    ...current,
    last_merge_at: now.toISOString(),
    ...(delta.appended ? { last_successful_sink_at: now.toISOString() } : {}),
    counters,
    failures,
    append_latency_histogram: addHistogram(
      current.append_latency_histogram,
      delta.append_latency_ms,
    ),
    flush_latency_histogram: addHistogram(current.flush_latency_histogram, delta.flush_latency_ms),
    ...(delta.queue ? { queue: delta.queue } : {}),
  };
}

function emptyMetrics(now: Date): HarneryLogMetricsV1 {
  return {
    schema: "harnery.log-metrics/v1",
    generation: randomUUID(),
    window_started_at: now.toISOString(),
    last_merge_at: now.toISOString(),
    counters: {
      accepted: 0,
      encoded: 0,
      appended: 0,
      synced: 0,
      dropped: 0,
      coalesced: 0,
      sampled: 0,
      bytes_accepted: 0,
      bytes_appended: 0,
      bytes_dropped: 0,
      rotations: 0,
    },
    failures: {},
    append_latency_histogram: HISTOGRAM_BUCKETS.map(() => 0),
    flush_latency_histogram: HISTOGRAM_BUCKETS.map(() => 0),
  };
}

function addHistogram(current: readonly number[], value: number | undefined): number[] {
  const next = [...current];
  if (value === undefined) return next;
  const index = HISTOGRAM_BUCKETS.findIndex((bucket) => value <= bucket);
  next[index < 0 ? next.length - 1 : index] += 1;
  return next;
}

function validateMetrics(value: unknown): HarneryLogMetricsV1 {
  if (
    !value ||
    typeof value !== "object" ||
    (value as HarneryLogMetricsV1).schema !== "harnery.log-metrics/v1"
  ) {
    throw new Error("invalid metrics sidecar");
  }
  return value as HarneryLogMetricsV1;
}
