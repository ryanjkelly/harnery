import { describe, expect, test } from "bun:test";
import {
  type CompletedHookHealth,
  SUPERVISOR_HIGH_COMPLETED_HOOK_RSS_BYTES,
  SUPERVISOR_SLOW_COMPLETED_HOOK_MS,
  type SupervisorHookHealth,
} from "./hook-health.ts";
import { evaluateHookHealthAlerts } from "./hook-health-alerts.ts";

describe("hook health alerts", () => {
  test("reports degraded, slow, memory-heavy, and retry evidence without taking action", () => {
    const problem = receipt({
      id: "problem",
      hook_name: "stop",
      outcome: "degraded",
      duration_ms: SUPERVISOR_SLOW_COMPLETED_HOOK_MS,
      rss_end_bytes: SUPERVISOR_HIGH_COMPLETED_HOOK_RSS_BYTES,
      error_count: 1,
      error_phases: ["status-box"],
    });
    const retries = [
      receipt({ id: "retry-1", hook_name: "runtime-context-retry", retry_worker: true }),
      receipt({ id: "retry-2", hook_name: "runtime-context-retry", retry_worker: true }),
      receipt({ id: "retry-3", hook_name: "runtime-context-retry", retry_worker: true }),
    ];
    const alerts = evaluateHookHealthAlerts(health([problem, ...retries], 3));
    expect(alerts.map((alert) => alert.finding_kind)).toEqual([
      "hook.execution-degraded",
      "hook.execution-slow",
      "hook.memory-heavy",
      "hook.retry-cluster",
    ]);
    expect(alerts[0]).toMatchObject({
      severity: "warning",
      owner_id: "inst_owner",
      observed_value: 1,
    });
  });

  test("does not infer health findings from an unavailable source", () => {
    const value = health([receipt()], 0);
    value.capability = {
      source_kind: "hook.terminal-log",
      state: "unavailable",
      reason: "missing",
    };
    expect(evaluateHookHealthAlerts(value)).toEqual([]);
  });
});

function receipt(override: Partial<CompletedHookHealth> = {}): CompletedHookHealth {
  return {
    id: "receipt",
    observed_at: "2026-08-31T12:00:00.000Z",
    hook_name: "stop",
    adapter: "codex",
    outcome: "completed",
    duration_ms: 10,
    rss_start_bytes: 50,
    rss_end_bytes: 60,
    rss_delta_bytes: 10,
    retry_worker: false,
    error_count: 0,
    error_phases: [],
    payload_bytes: 20,
    pid: 1,
    owner_id: "inst_owner",
    ...override,
  };
}

function health(recent: CompletedHookHealth[], retryCount: number): SupervisorHookHealth {
  const groups = new Map<string, CompletedHookHealth[]>();
  for (const item of recent) {
    const key = `${item.adapter}:${item.hook_name}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return {
    schema_version: 1,
    captured_at: "2026-08-31T12:00:00.000Z",
    capability: { source_kind: "hook.terminal-log", state: "supported" },
    source_record_count: recent.length,
    malformed_record_count: 0,
    truncated: false,
    summary: {
      invocation_count: recent.length,
      degraded_count: recent.filter((item) => item.outcome === "degraded").length,
      faulted_count: recent.filter((item) => item.outcome === "faulted").length,
      slow_count: recent.filter((item) => item.duration_ms >= SUPERVISOR_SLOW_COMPLETED_HOOK_MS)
        .length,
      high_memory_count: recent.filter(
        (item) => item.rss_end_bytes >= SUPERVISOR_HIGH_COMPLETED_HOOK_RSS_BYTES,
      ).length,
      retry_count: retryCount,
    },
    aggregates: [...groups.entries()].map(([key, items]) => ({
      key,
      hook_name: items[0]!.hook_name,
      adapter: items[0]!.adapter,
      invocation_count: items.length,
      completed_count: items.filter((item) => item.outcome === "completed").length,
      skipped_count: items.filter((item) => item.outcome === "skipped").length,
      degraded_count: items.filter((item) => item.outcome === "degraded").length,
      faulted_count: items.filter((item) => item.outcome === "faulted").length,
      retry_count: items.filter((item) => item.retry_worker).length,
      duration_p50_ms: items[0]!.duration_ms,
      duration_p95_ms: Math.max(...items.map((item) => item.duration_ms)),
      duration_max_ms: Math.max(...items.map((item) => item.duration_ms)),
      rss_end_max_bytes: Math.max(...items.map((item) => item.rss_end_bytes)),
      rss_delta_max_bytes: Math.max(...items.map((item) => item.rss_delta_bytes)),
      latest_observed_at: items[0]!.observed_at,
      owner_ids: ["inst_owner"],
    })),
    recent,
  };
}
