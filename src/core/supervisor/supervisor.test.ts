import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { ResourceSnapshot } from "../resources/contract.ts";
import {
  SUPERVISOR_LOG_FEED_SCHEMA_VERSION,
  SUPERVISOR_STATUS_SCHEMA_VERSION,
  type SupervisorLogFeed,
  type SupervisorServiceStatusRecord,
} from "./contract.ts";
import { explainSupervisorFinding } from "./explanations.ts";
import { updateSupervisorFindings } from "./findings.ts";
import { updateSupervisorHistory } from "./history.ts";
import { collectHookHealth, exactHookEntrypoint } from "./hooks.ts";
import { runSupervisor } from "./service.ts";
import {
  collectServiceHealth,
  registerSupervisorConsumer,
  unregisterSupervisorConsumer,
} from "./services.ts";
import { buildSupervisorTimeline } from "./timeline.ts";
import { supervisorPaths } from "./storage.ts";

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

  test("opens and resolves bounded deterministic findings", () => {
    const pressured = resourceAt(Date.now());
    pressured.machine.memory_percent = 90;
    const history = updateSupervisorHistory(undefined, pressured).history;
    const first = updateSupervisorFindings({
      resource: pressured,
      services: [],
      hooks: [],
      history,
      logFeed: emptyFeed(),
      now: new Date(pressured.sampled_at),
    });
    const active = first.active.find((entry) => entry.finding_kind === "machine.memory-pressure");
    expect(active).toBeDefined();
    if (!active) throw new Error("expected machine memory finding");
    const rebuilt = updateSupervisorFindings({
      resource: pressured,
      services: [],
      hooks: [],
      history,
      logFeed: emptyFeed(),
      now: new Date(pressured.sampled_at),
    });
    expect(rebuilt.active[0]?.id).toBe(active.id);
    const recovered = resourceAt(Date.parse(pressured.sampled_at) + 10_000);
    recovered.machine.memory_percent = 20;
    const second = updateSupervisorFindings({
      previous: first,
      resource: recovered,
      services: [],
      hooks: [],
      history: updateSupervisorHistory(history, recovered).history,
      logFeed: emptyFeed(),
      now: new Date(recovered.sampled_at),
    });
    expect(second.active.some((entry) => entry.finding_kind === "machine.memory-pressure")).toBe(
      false,
    );
    expect(
      second.transitions.some(
        (entry) => entry.finding_kind === "machine.memory-pressure" && entry.state === "resolved",
      ),
    ).toBe(true);
    const pressuredAgain = resourceAt(Date.parse(recovered.sampled_at) + 10_000);
    pressuredAgain.machine.memory_percent = 91;
    const reopened = updateSupervisorFindings({
      previous: second,
      resource: pressuredAgain,
      services: [],
      hooks: [],
      history: updateSupervisorHistory(history, pressuredAgain).history,
      logFeed: emptyFeed(),
      now: new Date(pressuredAgain.sampled_at),
    });
    const reopenedFinding = reopened.active.find(
      (entry) => entry.finding_kind === "machine.memory-pressure",
    );
    expect(reopenedFinding?.fingerprint).toBe(active.fingerprint);
    expect(reopenedFinding?.id).not.toBe(active.id);
    expect(second.transitions.length).toBeLessThanOrEqual(100);
  });

  test("replays the frozen memory-growth scenario with stable identity", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../tests/fixtures/diagnostics/source-scenarios.json"),
        "utf8",
      ),
    ) as {
      scenarios: Array<{
        id: string;
        resources?: Array<{ observed_at: string; group_id: string; rss_bytes: number }>;
        expected: { finding_kind?: string };
      }>;
    };
    const scenario = fixture.scenarios.find((entry) => entry.id === "cache-rebuild-identity");
    expect(scenario?.resources).toHaveLength(2);
    const [baseline, current] = scenario!.resources!;
    const firstResource = resourceAt(Date.parse(baseline!.observed_at));
    firstResource.groups = [resourceGroup(baseline!.group_id, baseline!.rss_bytes)];
    const firstHistory = updateSupervisorHistory(undefined, firstResource).history;
    const currentResource = resourceAt(Date.parse(current!.observed_at));
    currentResource.groups = [resourceGroup(current!.group_id, current!.rss_bytes)];
    const history = updateSupervisorHistory(firstHistory, currentResource).history;
    const input = {
      resource: currentResource,
      services: [],
      hooks: [],
      history,
      logFeed: emptyFeed(),
      now: new Date(current!.observed_at),
    };
    const first = updateSupervisorFindings(input);
    const rebuilt = updateSupervisorFindings(input);
    const finding = first.active.find((entry) => entry.finding_kind === "resource.memory-growth");
    expect(finding).toBeDefined();
    expect(rebuilt.active.find((entry) => entry.fingerprint === finding!.fingerprint)?.id).toBe(
      finding?.id,
    );
  });

  test("separates observed, related, possible, and degraded-capability evidence", () => {
    const resource = resourceAt(Date.parse("2026-08-30T12:05:00.000Z"));
    resource.machine.memory_percent = 90;
    const finding = updateSupervisorFindings({
      resource,
      services: [],
      hooks: [],
      history: updateSupervisorHistory(undefined, resource).history,
      logFeed: emptyFeed(),
      now: new Date(resource.sampled_at),
    }).active.find((entry) => entry.finding_kind === "machine.memory-pressure");
    expect(finding).toBeDefined();
    if (!finding) throw new Error("expected memory finding");
    const degraded = {
      source_kind: "resource.process-io",
      state: "unsupported" as const,
      reason_code: "platform-sampler-unavailable",
    };
    const withCapability = { ...finding, capabilities: [...finding.capabilities, degraded] };
    const relatedSource = {
      id: "v3:evt_17",
      source_kind: "coordination.v3",
      source_id: "event-warning-17",
      record_id: "evt_17",
      observed_at: resource.sampled_at,
      capability: "supported" as const,
    };
    const timeline = buildSupervisorTimeline(withCapability, [relatedSource]);
    expect(timeline.entries.some((entry) => entry.relation === "observed")).toBe(true);
    expect(timeline.entries.some((entry) => entry.relation === "related")).toBe(true);
    expect(timeline.entries.some((entry) => entry.relation === "capability")).toBe(true);
    expect(JSON.stringify(timeline)).not.toContain("payload");
    const explanation = explainSupervisorFinding(withCapability);
    expect(explanation.observed.length).toBeGreaterThan(0);
    expect(explanation.possible.length).toBeGreaterThan(0);
    expect(explanation.missing_capabilities).toContainEqual(degraded);
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
    const coordination = JSON.parse(
      readFileSync(supervisorPaths(root).coordination_health, "utf8"),
    ) as { capability?: { source_kind?: string }; recent_events?: unknown[] };
    expect(coordination.capability?.source_kind).toBe("coordination.v3");
    expect(Array.isArray(coordination.recent_events)).toBe(true);
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

function resourceGroup(id: string, rssBytes: number): ResourceSnapshot["groups"][number] {
  return {
    kind: "agent",
    id,
    process_count: 1,
    cpu_percent: 1,
    rss_bytes: rssBytes,
    root_pids: [42],
  };
}
