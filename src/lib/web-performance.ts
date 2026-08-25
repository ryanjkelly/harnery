import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const WEB_PERFORMANCE_LOG = "web-performance.jsonl";

interface BaseEvent {
  event: string;
  ts: string;
  pid?: number;
  mode?: string;
}

export interface WebRequestPerformanceEvent extends BaseEvent {
  event: "request_complete";
  request_id: string;
  method: string;
  route: string;
  status: number | null;
  outcome: "finished" | "aborted";
  stream: boolean;
  slow: boolean;
  duration_ms: number;
  process_cpu_ms_during_request: number;
  concurrent_requests_at_start: number;
  max_concurrent_requests: number;
  event_loop_delay_count: number;
  event_loop_delay_total_ms: number;
  max_event_loop_delay_ms: number;
}

export interface WebEventLoopDelayEvent extends BaseEvent {
  event: "event_loop_delay";
  delay_ms: number;
  active_request_count: number;
  active_requests: Array<{
    request_id: string;
    method: string;
    route: string;
    age_ms: number;
  }>;
  active_requests_truncated: number;
}

export interface WebMemoryPerformanceEvent extends BaseEvent {
  event: "memory_sample";
  reason: "started" | "interval";
  rss_bytes: number;
  heap_used_bytes: number;
  heap_total_bytes: number;
  heap_limit_bytes: number;
  heap_used_percent: number;
  external_bytes: number;
  array_buffers_bytes: number;
  native_contexts: number;
  detached_contexts: number;
  active_request_count: number;
  gc_count: number;
  gc_duration_ms: number;
  max_gc_pause_ms: number;
  gc_by_kind: Record<string, { count: number; duration_ms: number }>;
}

export interface WebGcPauseEvent extends BaseEvent {
  event: "gc_pause";
  kind: string;
  duration_ms: number;
  rss_bytes: number;
  heap_used_bytes: number;
  heap_total_bytes: number;
  heap_limit_bytes: number;
  heap_used_percent: number;
  active_request_count: number;
}

type WebPerformanceEvent =
  | WebRequestPerformanceEvent
  | WebEventLoopDelayEvent
  | WebMemoryPerformanceEvent
  | WebGcPauseEvent
  | BaseEvent;

export interface WebRoutePerformanceSummary {
  method: string;
  route: string;
  requests: number;
  slow_requests: number;
  aborted_requests: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  max_event_loop_delay_ms: number;
  max_concurrent_requests: number;
}

export interface WebPerformanceReport {
  state: "ok" | "unavailable";
  log_path: string;
  since: string;
  files_read: number;
  invalid_lines: number;
  requests_observed: number;
  streams_observed: number;
  slow_requests: number;
  event_loop_delays: number;
  memory: {
    samples: number;
    latest: WebMemoryPerformanceEvent;
    peak_rss_bytes: number;
    peak_heap_used_bytes: number;
    max_heap_used_percent: number;
  } | null;
  garbage_collection: {
    observed_collections: number;
    observed_duration_ms: number;
    recorded_pauses: number;
    max_pause_ms: number;
  };
  routes: WebRoutePerformanceSummary[];
  slowest_requests: WebRequestPerformanceEvent[];
  largest_event_loop_delays: WebEventLoopDelayEvent[];
  largest_gc_pauses: WebGcPauseEvent[];
  hint?: string;
}

export function parsePerformanceWindow(input: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(input.trim().toLowerCase());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unitMs = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return Math.floor(amount * unitMs);
}

function performanceLogPaths(root: string): string[] {
  const logsDir = path.join(root, ".harnery", "logs");
  if (!existsSync(logsDir)) return [];
  return readdirSync(logsDir)
    .filter(
      (name) =>
        name === WEB_PERFORMANCE_LOG || new RegExp(`^${WEB_PERFORMANCE_LOG}\\.\\d+$`).test(name),
    )
    .sort((left, right) => {
      if (left === WEB_PERFORMANCE_LOG) return 1;
      if (right === WEB_PERFORMANCE_LOG) return -1;
      return Number(right.split(".").at(-1)) - Number(left.split(".").at(-1));
    })
    .map((name) => path.join(logsDir, name));
}

function numberField(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRequestEvent(event: WebPerformanceEvent): event is WebRequestPerformanceEvent {
  return (
    event.event === "request_complete" &&
    typeof (event as WebRequestPerformanceEvent).method === "string" &&
    typeof (event as WebRequestPerformanceEvent).route === "string" &&
    numberField((event as WebRequestPerformanceEvent).duration_ms)
  );
}

function isDelayEvent(event: WebPerformanceEvent): event is WebEventLoopDelayEvent {
  return (
    event.event === "event_loop_delay" && numberField((event as WebEventLoopDelayEvent).delay_ms)
  );
}

function isMemoryEvent(event: WebPerformanceEvent): event is WebMemoryPerformanceEvent {
  return (
    event.event === "memory_sample" &&
    numberField((event as WebMemoryPerformanceEvent).rss_bytes) &&
    numberField((event as WebMemoryPerformanceEvent).heap_used_bytes) &&
    numberField((event as WebMemoryPerformanceEvent).heap_limit_bytes)
  );
}

function isGcPauseEvent(event: WebPerformanceEvent): event is WebGcPauseEvent {
  return event.event === "gc_pause" && numberField((event as WebGcPauseEvent).duration_ms);
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

export function readWebPerformanceReport(options: {
  root: string;
  since: string;
  limit: number;
  nowMs?: number;
}): WebPerformanceReport {
  const root = path.resolve(options.root);
  const logPath = path.join(root, ".harnery", "logs", WEB_PERFORMANCE_LOG);
  const windowMs = parsePerformanceWindow(options.since);
  if (windowMs === null) throw new Error(`invalid performance window: ${options.since}`);
  const cutoffMs = (options.nowMs ?? Date.now()) - windowMs;
  const paths = performanceLogPaths(root);
  if (paths.length === 0) {
    return {
      state: "unavailable",
      log_path: logPath,
      since: options.since,
      files_read: 0,
      invalid_lines: 0,
      requests_observed: 0,
      streams_observed: 0,
      slow_requests: 0,
      event_loop_delays: 0,
      memory: null,
      garbage_collection: {
        observed_collections: 0,
        observed_duration_ms: 0,
        recorded_pauses: 0,
        max_pause_ms: 0,
      },
      routes: [],
      slowest_requests: [],
      largest_event_loop_delays: [],
      largest_gc_pauses: [],
      hint: "Start or restart `harn web`; performance diagnostics begin when the server receives its first request.",
    };
  }

  const events: WebPerformanceEvent[] = [];
  let invalidLines = 0;
  for (const file of paths) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as WebPerformanceEvent;
        const timestamp = Date.parse(event.ts);
        if (!Number.isFinite(timestamp)) {
          invalidLines++;
          continue;
        }
        if (timestamp >= cutoffMs) events.push(event);
      } catch {
        invalidLines++;
      }
    }
  }

  const allRequests = events.filter(isRequestEvent);
  const requests = allRequests.filter((event) => !event.stream);
  const delays = events.filter(isDelayEvent);
  const memorySamples = events.filter(isMemoryEvent);
  const gcPauses = events.filter(isGcPauseEvent);
  const groups = new Map<string, WebRequestPerformanceEvent[]>();
  for (const request of requests) {
    const key = `${request.method}\0${request.route}`;
    const group = groups.get(key) ?? [];
    group.push(request);
    groups.set(key, group);
  }

  const routes = [...groups.values()]
    .map((group): WebRoutePerformanceSummary => {
      const durations = group.map((event) => event.duration_ms).sort((a, b) => a - b);
      return {
        method: group[0]?.method ?? "GET",
        route: group[0]?.route ?? "/",
        requests: group.length,
        slow_requests: group.filter((event) => event.slow).length,
        aborted_requests: group.filter((event) => event.outcome === "aborted").length,
        p50_ms: percentile(durations, 0.5),
        p95_ms: percentile(durations, 0.95),
        max_ms: durations.at(-1) ?? 0,
        max_event_loop_delay_ms: Math.max(...group.map((event) => event.max_event_loop_delay_ms)),
        max_concurrent_requests: Math.max(...group.map((event) => event.max_concurrent_requests)),
      };
    })
    .sort((left, right) => right.max_ms - left.max_ms || right.p95_ms - left.p95_ms);

  return {
    state: "ok",
    log_path: logPath,
    since: options.since,
    files_read: paths.length,
    invalid_lines: invalidLines,
    requests_observed: requests.length,
    streams_observed: allRequests.length - requests.length,
    slow_requests: requests.filter((event) => event.slow).length,
    event_loop_delays: delays.length,
    memory:
      memorySamples.length > 0
        ? {
            samples: memorySamples.length,
            latest: memorySamples.at(-1)!,
            peak_rss_bytes: Math.max(...memorySamples.map((event) => event.rss_bytes)),
            peak_heap_used_bytes: Math.max(...memorySamples.map((event) => event.heap_used_bytes)),
            max_heap_used_percent: Math.max(
              ...memorySamples.map((event) => event.heap_used_percent),
            ),
          }
        : null,
    garbage_collection: {
      observed_collections: memorySamples.reduce((sum, event) => sum + event.gc_count, 0),
      observed_duration_ms: Math.round(
        memorySamples.reduce((sum, event) => sum + event.gc_duration_ms, 0),
      ),
      recorded_pauses: gcPauses.length,
      max_pause_ms: Math.max(0, ...gcPauses.map((event) => event.duration_ms)),
    },
    routes,
    slowest_requests: requests
      .slice()
      .sort((left, right) => right.duration_ms - left.duration_ms)
      .slice(0, options.limit),
    largest_event_loop_delays: delays
      .slice()
      .sort((left, right) => right.delay_ms - left.delay_ms)
      .slice(0, options.limit),
    largest_gc_pauses: gcPauses
      .slice()
      .sort((left, right) => right.duration_ms - left.duration_ms)
      .slice(0, options.limit),
  };
}
