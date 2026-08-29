import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parsePerformanceWindow,
  readWebPerformanceReport,
  WEB_PERFORMANCE_LOG,
} from "./web-performance.ts";

describe("web performance reports", () => {
  let root: string;
  const nowMs = Date.parse("2026-08-24T20:00:00.000Z");

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "harnery-web-performance-"));
    mkdirSync(path.join(root, ".harnery", "logs"), { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("parses minute, hour, and day windows", () => {
    expect(parsePerformanceWindow("30m")).toBe(1_800_000);
    expect(parsePerformanceWindow("1.5h")).toBe(5_400_000);
    expect(parsePerformanceWindow("2d")).toBe(172_800_000);
    expect(parsePerformanceWindow("soon")).toBeNull();
  });

  test("ranks routes and event-loop delays across rotated logs", () => {
    const older = [
      {
        event: "request_complete",
        ts: "2026-08-24T19:30:00.000Z",
        method: "GET",
        route: "/agents",
        duration_ms: 120,
        slow: false,
        stream: false,
        outcome: "finished",
        max_event_loop_delay_ms: 0,
        max_concurrent_requests: 1,
      },
      {
        event: "request_complete",
        ts: "2026-08-24T17:00:00.000Z",
        method: "GET",
        route: "/expired",
        duration_ms: 9_000,
        slow: true,
        stream: false,
        outcome: "finished",
        max_event_loop_delay_ms: 0,
        max_concurrent_requests: 1,
      },
    ];
    const current = [
      {
        event: "request_complete",
        ts: "2026-08-24T19:40:00.000Z",
        method: "GET",
        route: "/agents",
        duration_ms: 2_400,
        slow: true,
        stream: false,
        outcome: "finished",
        max_event_loop_delay_ms: 700,
        max_concurrent_requests: 3,
      },
      {
        event: "request_complete",
        ts: "2026-08-24T19:45:00.000Z",
        method: "GET",
        route: "/api/stream",
        duration_ms: 30_000,
        slow: false,
        stream: true,
        outcome: "finished",
        max_event_loop_delay_ms: 0,
        max_concurrent_requests: 2,
      },
      {
        event: "event_loop_delay",
        ts: "2026-08-24T19:40:01.000Z",
        delay_ms: 680,
        active_request_count: 1,
        active_requests: [{ request_id: "1", method: "GET", route: "/agents", age_ms: 800 }],
        active_requests_truncated: 0,
      },
      {
        event: "memory_sample",
        ts: "2026-08-24T19:42:00.000Z",
        reason: "interval",
        rss_bytes: 900_000_000,
        heap_used_bytes: 700_000_000,
        heap_total_bytes: 800_000_000,
        heap_limit_bytes: 2_000_000_000,
        heap_used_percent: 35,
        external_bytes: 10_000,
        array_buffers_bytes: 5_000,
        native_contexts: 3,
        detached_contexts: 0,
        active_request_count: 1,
        gc_count: 12,
        gc_duration_ms: 84,
        max_gc_pause_ms: 40,
        gc_by_kind: { minor: { count: 12, duration_ms: 84 } },
      },
      {
        event: "gc_pause",
        ts: "2026-08-24T19:41:59.000Z",
        kind: "major",
        duration_ms: 320,
        rss_bytes: 900_000_000,
        heap_used_bytes: 700_000_000,
        heap_total_bytes: 800_000_000,
        heap_limit_bytes: 2_000_000_000,
        heap_used_percent: 35,
        active_request_count: 1,
      },
    ];
    writeFileSync(
      path.join(root, ".harnery", "logs", `${WEB_PERFORMANCE_LOG}.1`),
      `${older.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    mkdirSync(path.join(root, ".harnery", "logs", "web-performance"), { recursive: true });
    writeFileSync(
      path.join(root, ".harnery", "logs", "web-performance", "active.jsonl"),
      `${[older[0], ...current].map((event) => JSON.stringify(event)).join("\n")}\nnot-json\n`,
    );

    const report = readWebPerformanceReport({ root, since: "1h", limit: 5, nowMs });

    expect(report.state).toBe("ok");
    expect(report.files_read).toBe(2);
    expect(report.requests_observed).toBe(2);
    expect(report.streams_observed).toBe(1);
    expect(report.slow_requests).toBe(1);
    expect(report.event_loop_delays).toBe(1);
    expect(report.memory).toMatchObject({
      samples: 1,
      peak_rss_bytes: 900_000_000,
      peak_heap_used_bytes: 700_000_000,
      max_heap_used_percent: 35,
    });
    expect(report.garbage_collection).toEqual({
      observed_collections: 12,
      observed_duration_ms: 84,
      recorded_pauses: 1,
      max_pause_ms: 320,
    });
    expect(report.invalid_lines).toBe(1);
    expect(report.routes).toEqual([
      {
        method: "GET",
        route: "/agents",
        requests: 2,
        slow_requests: 1,
        aborted_requests: 0,
        p50_ms: 120,
        p95_ms: 2_400,
        max_ms: 2_400,
        max_event_loop_delay_ms: 700,
        max_concurrent_requests: 3,
      },
    ]);
    expect(report.slowest_requests[0]?.duration_ms).toBe(2_400);
    expect(report.largest_event_loop_delays[0]?.delay_ms).toBe(680);
    expect(report.largest_gc_pauses[0]?.duration_ms).toBe(320);
  });

  test("reports how to activate diagnostics when no log exists", () => {
    const report = readWebPerformanceReport({ root, since: "1h", limit: 5, nowMs });
    expect(report.state).toBe("unavailable");
    expect(report.hint).toContain("Start or restart `harn web`");
  });
});
