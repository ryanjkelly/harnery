import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { ResourceSnapshot } from "../resources/contract.ts";
import { updateSupervisorAnomalies } from "./anomalies.ts";
import {
  SUPERVISOR_LOG_FEED_SCHEMA_VERSION,
  SUPERVISOR_STATUS_SCHEMA_VERSION,
  type SupervisorLogFeed,
  type SupervisorServiceStatusRecord,
} from "./contract.ts";
import { updateSupervisorHistory } from "./history.ts";
import { collectHookHealth, exactHookEntrypoint } from "./hooks.ts";
import { runSupervisor } from "./service.ts";
import {
  collectServiceHealth,
  registerSupervisorConsumer,
  unregisterSupervisorConsumer,
} from "./services.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local supervisor collectors", () => {
  test("bounds 15-minute history at 90 ten-second points", () => {
    let history = updateSupervisorHistory(undefined, resourceAt(0)).history;
    expect(history.points).toHaveLength(1);
    expect(updateSupervisorHistory(history, resourceAt(5_000)).changed).toBe(false);
    for (let index = 1; index <= 100; index += 1) {
      history = updateSupervisorHistory(history, resourceAt(index * 10_000)).history;
    }
    expect(history.points).toHaveLength(90);
    expect(history.points[0]?.sampled_at).toBe(new Date(110_000).toISOString());
  });

  test("labels hooks only after agent ownership and an exact entrypoint agree", () => {
    const resource = resourceAt(Date.now());
    resource.processes = [
      {
        pid: 10,
        ppid: 1,
        start_id: "10:1",
        state: "S",
        name: "agent-hook",
        command: "/package/bin/agent-hook session-start",
        cpu_percent: 0,
        rss_bytes: 1_024,
        age_seconds: 121,
        owner_kind: "agent",
        owner_id: "agent-a",
        owner_root_pid: 10,
      },
      {
        pid: 11,
        ppid: 1,
        start_id: "11:1",
        state: "S",
        name: "agent-hook",
        command: "/package/bin/agent-hook session-start",
        cpu_percent: 0,
        rss_bytes: 1_024,
        age_seconds: 121,
        owner_kind: "unattributed",
        owner_id: null,
        owner_root_pid: null,
      },
    ];
    expect(exactHookEntrypoint("bun", "bun /package/bin/agent-hook stop")).toBe(true);
    expect(exactHookEntrypoint("bun", "bun hook-worker.ts")).toBe(false);
    expect(collectHookHealth(resource)).toMatchObject([
      { pid: 10, owner_id: "agent-a", long_running: true },
    ]);
  });

  test("opens and resolves bounded anomaly transitions", () => {
    const pressured = resourceAt(Date.now());
    pressured.machine.memory_percent = 90;
    const history = updateSupervisorHistory(undefined, pressured).history;
    const first = updateSupervisorAnomalies({
      resource: pressured,
      services: [],
      hooks: [],
      history,
      logFeed: emptyFeed(),
      now: new Date(pressured.sampled_at),
    });
    expect(first.active.some((entry) => entry.kind === "machine-memory")).toBe(true);
    const recovered = resourceAt(Date.parse(pressured.sampled_at) + 10_000);
    recovered.machine.memory_percent = 20;
    const second = updateSupervisorAnomalies({
      previous: first,
      resource: recovered,
      services: [],
      hooks: [],
      history: updateSupervisorHistory(history, recovered).history,
      logFeed: emptyFeed(),
      now: new Date(recovered.sampled_at),
    });
    expect(second.active.some((entry) => entry.kind === "machine-memory")).toBe(false);
    expect(
      second.transitions.some(
        (entry) => entry.kind === "machine-memory" && entry.state === "resolved",
      ),
    ).toBe(true);
    expect(second.transitions.length).toBeLessThanOrEqual(100);
  });

  test("keeps only process-start-validated dashboard consumers", () => {
    const root = mkdtempSync(join(tmpdir(), "harn-supervisor-consumer-"));
    roots.push(root);
    registerSupervisorConsumer(root, { id: "dashboard", pid: process.pid });
    const health = collectServiceHealth(root, statusRecord());
    expect(health.consumers).toHaveLength(1);
    expect(health.services.find((entry) => entry.id === "dashboard")?.state).toBe("running");
    unregisterSupervisorConsumer(root, "dashboard");
    expect(collectServiceHealth(root, statusRecord()).consumers).toHaveLength(0);
  });

  test("exits after the configured idle grace without live consumers or agents", async () => {
    const root = mkdtempSync(join(tmpdir(), "harn-supervisor-idle-"));
    roots.push(root);
    let nowMs = Date.parse("2026-08-30T12:00:00.000Z");
    const result = await runSupervisor({
      coordRoot: root,
      intervalMs: 500,
      idleExitMs: 5_000,
      now: () => new Date(nowMs),
      wait: async (milliseconds) => {
        nowMs += milliseconds;
      },
    });
    expect(result.state).toBe("stopped");
    expect(result.cycle_count).toBeGreaterThan(1);
    expect(Date.parse(result.stopped_at ?? "")).toBeGreaterThanOrEqual(
      Date.parse(result.started_at) + 5_000,
    );
  });
});

function statusRecord(): SupervisorServiceStatusRecord {
  const now = new Date().toISOString();
  return {
    schema_version: SUPERVISOR_STATUS_SCHEMA_VERSION,
    pid: process.pid,
    host: hostname(),
    nonce: "test",
    state: "running",
    started_at: now,
    heartbeat_at: now,
    interval_ms: 2_000,
    keep_alive: false,
    idle_exit_ms: 120_000,
    cycle_count: 1,
  };
}

function resourceAt(nowMs: number): ResourceSnapshot {
  return {
    schema_version: 1,
    sampled_at: new Date(nowMs).toISOString(),
    interval_ms: 2_000,
    sample_duration_ms: 4,
    collector_cpu_ms: 4,
    platform: "linux",
    namespace: "host",
    support: { state: "supported", sampler: "procfs" },
    machine: {
      cpu_percent: 10,
      cpu_logical_count: 8,
      load_average: [0.1, 0.1, 0.1],
      memory_total_bytes: 16 * 1_024 ** 3,
      memory_available_bytes: 12 * 1_024 ** 3,
      memory_used_bytes: 4 * 1_024 ** 3,
      memory_percent: 25,
      swap_total_bytes: 8 * 1_024 ** 3,
      swap_used_bytes: 0,
      process_count: 20,
    },
    groups: [],
    processes: [],
    visible_process_count: 0,
    omitted_process_count: 20,
    unattributed_process_count: 0,
  };
}

function emptyFeed(): SupervisorLogFeed {
  return {
    schema_version: SUPERVISOR_LOG_FEED_SCHEMA_VERSION,
    captured_at: new Date().toISOString(),
    sequence: 1,
    lanes: [],
    total_records: 0,
    unavailable_families: 0,
  };
}
