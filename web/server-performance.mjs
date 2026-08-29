/**
 * Process-level performance diagnostics for the standalone dashboard.
 *
 * `harn web` preloads this module through NODE_OPTIONS so it can observe the
 * HTTP server without replacing Next's server or wrapping every route. The
 * log is deliberately local runtime state, bounded by rotation, and excludes
 * query strings, headers, bodies, and response payloads.
 */

import { channel } from "node:diagnostics_channel";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { constants, PerformanceObserver, performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

export const WEB_PERFORMANCE_LOG = "web-performance.jsonl";
export const WEB_PERFORMANCE_SHARED_FILE = "active.jsonl";

const DEFAULT_SLOW_REQUEST_MS = 1_000;
const DEFAULT_EVENT_LOOP_DELAY_MS = 250;
const DEFAULT_MEMORY_SAMPLE_MS = 30_000;
const DEFAULT_GC_PAUSE_MS = 100;
const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_BACKUPS = 3;
const MAX_ACTIVE_REQUESTS_IN_EVENT = 12;
const INSTALL_KEY = Symbol.for("harnery.web-performance-installed");

/** @param {string | undefined} raw @param {number} fallback */
export function positiveNumber(raw, fallback) {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** @param {string | undefined} raw @param {number} fallback */
export function positiveInteger(raw, fallback) {
  return Math.max(1, Math.floor(positiveNumber(raw, fallback)));
}

/** Resolve the shared catalog partition by default and the untouched legacy path on rollback. */
/** @param {string} coordRoot @param {Readonly<Record<string, string | undefined>>} [env] */
export function webPerformanceLogPath(coordRoot, env = process.env) {
  if (env.HARNERY_WEB_PERFORMANCE_LOG_PATH) {
    return path.resolve(env.HARNERY_WEB_PERFORMANCE_LOG_PATH);
  }
  const logs = path.join(path.resolve(coordRoot), ".harnery", "logs");
  return env.HARNERY_SHARED_LOGS === "0"
    ? path.join(logs, WEB_PERFORMANCE_LOG)
    : path.join(logs, "web-performance", WEB_PERFORMANCE_SHARED_FILE);
}

/** Strip query strings and fragments while retaining the actionable route. */
export function requestPath(rawUrl) {
  try {
    return new URL(rawUrl ?? "/", "http://harnery.local").pathname;
  } catch {
    return "/";
  }
}

/** Static framework assets are not useful dashboard-latency evidence. */
export function ignoredRequestPath(route) {
  return (
    route.startsWith("/_next/static/") ||
    route.startsWith("/_next/image") ||
    route.startsWith("/__nextjs_") ||
    route === "/favicon.ico" ||
    route === "/icon.svg"
  );
}

/** @param {number | undefined} kind */
export function gcKindName(kind) {
  switch (kind) {
    case constants.NODE_PERFORMANCE_GC_MAJOR:
      return "major";
    case constants.NODE_PERFORMANCE_GC_MINOR:
      return "minor";
    case constants.NODE_PERFORMANCE_GC_INCREMENTAL:
      return "incremental";
    case constants.NODE_PERFORMANCE_GC_WEAKCB:
      return "weak_callbacks";
    default:
      return "unknown";
  }
}

export function memorySnapshot() {
  const memory = process.memoryUsage();
  const heap = getHeapStatistics();
  return {
    rss_bytes: memory.rss,
    heap_used_bytes: memory.heapUsed,
    heap_total_bytes: memory.heapTotal,
    heap_limit_bytes: heap.heap_size_limit,
    heap_used_percent: Number(((memory.heapUsed / heap.heap_size_limit) * 100).toFixed(1)),
    external_bytes: memory.external,
    array_buffers_bytes: memory.arrayBuffers,
    native_contexts: heap.number_of_native_contexts,
    detached_contexts: heap.number_of_detached_contexts,
  };
}

class BoundedJsonlWriter {
  /** @param {string} filePath @param {number} maxBytes @param {number} backups */
  constructor(filePath, maxBytes, backups) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.backups = backups;
    this.bytes = 0;
    this.initialized = false;
    this.queue = Promise.resolve();
    this.reportedError = false;
  }

  /** @param {Record<string, unknown>} event */
  write(event) {
    const line = `${JSON.stringify(event)}\n`;
    this.queue = this.queue
      .then(async () => {
        await this.initialize();
        if (this.bytes + Buffer.byteLength(line) > this.maxBytes) await this.rotate();
        await appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 });
        this.bytes += Buffer.byteLength(line);
      })
      .catch((error) => {
        if (this.reportedError) return;
        this.reportedError = true;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[harn web performance] log write failed: ${message}\n`);
      });
  }

  async initialize() {
    if (this.initialized) return;
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      this.bytes = (await stat(this.filePath)).size;
    } catch {
      this.bytes = 0;
    }
    this.initialized = true;
  }

  async rotate() {
    await rm(`${this.filePath}.${this.backups}`, { force: true });
    for (let index = this.backups - 1; index >= 1; index--) {
      try {
        await rename(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`);
      } catch {
        // A missing generation is normal on a new installation.
      }
    }
    try {
      await rename(this.filePath, `${this.filePath}.1`);
    } catch {
      // The first rotation can race a file that has not been created yet.
    }
    this.bytes = 0;
  }
}

/** @returns {boolean} whether this process installed the diagnostics hooks */
export function installWebPerformanceDiagnostics() {
  if (globalThis[INSTALL_KEY]) return false;
  globalThis[INSTALL_KEY] = true;

  const coordRoot = process.env.HARNERY_COORD_ROOT;
  if (!coordRoot) return false;

  const slowRequestMs = positiveNumber(
    process.env.HARNERY_WEB_SLOW_REQUEST_MS,
    DEFAULT_SLOW_REQUEST_MS,
  );
  const eventLoopDelayMs = positiveNumber(
    process.env.HARNERY_WEB_EVENT_LOOP_DELAY_MS,
    DEFAULT_EVENT_LOOP_DELAY_MS,
  );
  const memorySampleMs = positiveNumber(
    process.env.HARNERY_WEB_MEMORY_SAMPLE_MS,
    DEFAULT_MEMORY_SAMPLE_MS,
  );
  const gcPauseMs = positiveNumber(process.env.HARNERY_WEB_GC_PAUSE_MS, DEFAULT_GC_PAUSE_MS);
  const maxLogBytes = positiveInteger(
    process.env.HARNERY_WEB_PERFORMANCE_LOG_MAX_BYTES,
    DEFAULT_MAX_LOG_BYTES,
  );
  const logBackups = positiveInteger(
    process.env.HARNERY_WEB_PERFORMANCE_LOG_BACKUPS,
    DEFAULT_LOG_BACKUPS,
  );
  const logPath = webPerformanceLogPath(coordRoot);
  const writer = new BoundedJsonlWriter(logPath, maxLogBytes, logBackups);
  const active = new Map();
  let requestSequence = 0;
  let monitorStarted = false;
  let gcCount = 0;
  let gcDurationMs = 0;
  let maxGcPauseMs = 0;
  let gcByKind = {};

  const write = (event) =>
    writer.write({
      schema_version: 1,
      ts: new Date().toISOString(),
      pid: process.pid,
      mode: process.env.HARNERY_WEB_MODE ?? process.env.NODE_ENV ?? "unknown",
      ...event,
    });

  const isEventStreamResponse = (response) => {
    const contentType = String(response.getHeader?.("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) return true;
    // `writeHead(status, headers)` can serialize headers directly without
    // adding them to getHeader(). `_header` is Node's already-built wire
    // header and is read only as the fallback for that standard API shape.
    return /(?:^|\r\n)content-type:\s*text\/event-stream\b/i.test(String(response._header ?? ""));
  };

  const actionableActiveRequests = () =>
    [...active.entries()]
      .filter(([response]) => !isEventStreamResponse(response))
      .map(([, request]) => request);

  const drainGcSummary = () => {
    const summary = {
      gc_count: gcCount,
      gc_duration_ms: Math.round(gcDurationMs),
      max_gc_pause_ms: Math.round(maxGcPauseMs),
      gc_by_kind: gcByKind,
    };
    gcCount = 0;
    gcDurationMs = 0;
    maxGcPauseMs = 0;
    gcByKind = {};
    return summary;
  };

  const writeMemorySample = (reason) => {
    write({
      event: "memory_sample",
      reason,
      ...memorySnapshot(),
      active_request_count: actionableActiveRequests().length,
      ...drainGcSummary(),
    });
  };

  const startEventLoopMonitor = () => {
    if (monitorStarted) return;
    monitorStarted = true;
    const gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const durationMs = entry.duration;
        const kind = gcKindName(entry.detail?.kind);
        gcCount += 1;
        gcDurationMs += durationMs;
        maxGcPauseMs = Math.max(maxGcPauseMs, durationMs);
        const previous = gcByKind[kind] ?? { count: 0, duration_ms: 0 };
        gcByKind[kind] = {
          count: previous.count + 1,
          duration_ms: Math.round(previous.duration_ms + durationMs),
        };
        if (durationMs >= gcPauseMs) {
          write({
            event: "gc_pause",
            kind,
            duration_ms: Math.round(durationMs),
            ...memorySnapshot(),
            active_request_count: actionableActiveRequests().length,
          });
        }
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });

    writeMemorySample("started");
    const memoryTimer = setInterval(() => writeMemorySample("interval"), memorySampleMs);
    memoryTimer.unref();

    const intervalMs = Math.min(100, Math.max(25, Math.floor(eventLoopDelayMs / 2)));
    let expectedAt = performance.now() + intervalMs;
    const timer = setInterval(() => {
      const now = performance.now();
      const delayMs = Math.max(0, now - expectedAt);
      expectedAt = now + intervalMs;
      if (delayMs < eventLoopDelayMs) return;

      // An open SSE connection is idle coordination infrastructure, not a
      // request doing work. Keep it in the lifecycle map so its eventual close
      // is recorded, but never implicate it in a process-wide delay.
      const activeRequests = actionableActiveRequests();
      for (const request of activeRequests) {
        request.eventLoopDelayCount += 1;
        request.eventLoopDelayTotalMs += delayMs;
        request.maxEventLoopDelayMs = Math.max(request.maxEventLoopDelayMs, delayMs);
      }
      write({
        event: "event_loop_delay",
        delay_ms: Math.round(delayMs),
        active_request_count: activeRequests.length,
        active_requests: activeRequests.slice(0, MAX_ACTIVE_REQUESTS_IN_EVENT).map((request) => ({
          request_id: request.id,
          method: request.method,
          route: request.route,
          age_ms: Math.round(now - request.startedAt),
        })),
        active_requests_truncated: Math.max(
          0,
          activeRequests.length - MAX_ACTIVE_REQUESTS_IN_EVENT,
        ),
        ...memorySnapshot(),
      });
      const routes = activeRequests
        .slice(0, 3)
        .map((request) => `${request.method} ${request.route}`)
        .join(", ");
      process.stderr.write(
        `[harn web performance] event loop delayed ${Math.round(delayMs)}ms` +
          `${routes ? ` while ${routes}` : " with no active request"}\n`,
      );
    }, intervalMs);
    timer.unref();

    write({
      event: "diagnostics_started",
      slow_request_ms: slowRequestMs,
      event_loop_delay_ms: eventLoopDelayMs,
      memory_sample_ms: memorySampleMs,
      gc_pause_ms: gcPauseMs,
      log_path: logPath,
      max_log_bytes: maxLogBytes,
      log_backups: logBackups,
    });
  };

  channel("http.server.request.start").subscribe(({ request, response }) => {
    if (!request || !response) return;
    const route = requestPath(request.url);
    if (ignoredRequestPath(route)) return;

    startEventLoopMonitor();
    const actionableActive = actionableActiveRequests();
    const concurrentRequests = actionableActive.length + 1;
    for (const current of actionableActive) {
      current.maxConcurrentRequests = Math.max(current.maxConcurrentRequests, concurrentRequests);
    }

    const state = {
      id: `${process.pid}-${++requestSequence}`,
      method: request.method ?? "GET",
      route,
      startedAt: performance.now(),
      cpuStart: process.cpuUsage(),
      concurrentRequestsAtStart: concurrentRequests,
      maxConcurrentRequests: concurrentRequests,
      eventLoopDelayCount: 0,
      eventLoopDelayTotalMs: 0,
      maxEventLoopDelayMs: 0,
      completed: false,
      completionScheduled: false,
    };
    active.set(response, state);

    const complete = (outcome, finishedAt, cpu) => {
      if (state.completed) return;
      state.completed = true;
      active.delete(response);
      const durationMs = finishedAt - state.startedAt;
      const stream = isEventStreamResponse(response);
      const slow = !stream && durationMs >= slowRequestMs;
      write({
        event: "request_complete",
        request_id: state.id,
        method: state.method,
        route: state.route,
        status: Number(response.statusCode) || null,
        outcome,
        stream,
        slow,
        duration_ms: Math.round(durationMs),
        process_cpu_ms_during_request: Math.round((cpu.user + cpu.system) / 1_000),
        concurrent_requests_at_start: state.concurrentRequestsAtStart,
        max_concurrent_requests: state.maxConcurrentRequests,
        event_loop_delay_count: state.eventLoopDelayCount,
        event_loop_delay_total_ms: Math.round(state.eventLoopDelayTotalMs),
        max_event_loop_delay_ms: Math.round(state.maxEventLoopDelayMs),
      });
      if (slow) {
        process.stderr.write(
          `[harn web performance] slow ${state.method} ${state.route}: ` +
            `${Math.round(durationMs)}ms, max event-loop delay ` +
            `${Math.round(state.maxEventLoopDelayMs)}ms, max concurrency ` +
            `${state.maxConcurrentRequests}\n`,
        );
      }
    };

    const scheduleComplete = (outcome) => {
      if (state.completionScheduled) return;
      state.completionScheduled = true;
      const finishedAt = performance.now();
      const cpu = process.cpuUsage(state.cpuStart);
      // Keep the request attributable through the next timers phase. A
      // synchronous handler can call response.end() before an overdue event-
      // loop monitor callback gets to run; finalizing immediately would then
      // produce a real delay event with an empty request list.
      setTimeout(() => complete(outcome, finishedAt, cpu), 0);
    };

    response.once("finish", () => scheduleComplete("finished"));
    response.once("close", () =>
      scheduleComplete(response.writableFinished ? "finished" : "aborted"),
    );
  });

  return true;
}

installWebPerformanceDiagnostics();
