import { hostname } from "node:os";
import type { ResourceSnapshot } from "../../src/core/resources/contract.ts";
import { resourcePaths, writePrivateJsonAtomic } from "../../src/core/resources/storage.ts";
import { supervisorPaths } from "../../src/core/supervisor/storage.ts";

export function resourceStatusFixture(root: string, nowMs = Date.now()): ResourceSnapshot {
  const snapshot: ResourceSnapshot = {
    schema_version: 1,
    sampled_at: new Date(nowMs).toISOString(),
    interval_ms: 2000,
    sample_duration_ms: 12,
    collector_cpu_ms: 5,
    platform: "linux",
    namespace: "wsl",
    support: { state: "supported", sampler: "procfs" },
    machine: {
      cpu_percent: 30,
      cpu_logical_count: 8,
      cpu_available_parallelism: 8,
      load_average: [1, 2, 3],
      memory_total_bytes: 16 * 1024 ** 3,
      memory_available_bytes: 8 * 1024 ** 3,
      memory_used_bytes: 8 * 1024 ** 3,
      memory_percent: 50,
      swap_total_bytes: 1024 ** 3,
      swap_used_bytes: 0,
      process_count: 30,
    },
    disks: [
      {
        path: root,
        state: "supported",
        total_bytes: 100 * 1024 ** 3,
        available_bytes: 40 * 1024 ** 3,
        used_percent: 60,
      },
    ],
    pressure: {
      state: "supported",
      cpu: { avg10: 1, avg60: 1, avg300: 1 },
      memory: null,
      io: null,
      memory_full: null,
      io_full: null,
    },
    io: { state: "supported", read_bytes_per_second: 1024, write_bytes_per_second: 2048 },
    groups: [],
    processes: [
      {
        pid: 1,
        ppid: 0,
        start_id: "1",
        state: "S",
        name: "worker",
        command: "worker --token should-not-appear",
        cpu_percent: 5,
        rss_bytes: 1024,
        age_seconds: 10,
        owner_kind: "agent",
        owner_id: "test-agent",
        owner_root_pid: 1,
      },
    ],
    visible_process_count: 1,
    omitted_process_count: 29,
    unattributed_process_count: 0,
  };
  writePrivateJsonAtomic(resourcePaths(root).snapshot, snapshot);
  writePrivateJsonAtomic(supervisorPaths(root).service, {
    schema_version: 1,
    pid: process.pid,
    host: hostname(),
    nonce: "fixture",
    state: "running",
    started_at: new Date(nowMs - 60_000).toISOString(),
    heartbeat_at: new Date(nowMs).toISOString(),
    keep_alive: true,
  });
  writePrivateJsonAtomic(supervisorPaths(root).findings, {
    schema_version: 2,
    active: [],
    transitions: [],
    max_findings: 200,
  });
  return snapshot;
}

export function resourceFindingFixture(kind = "machine.cpu-pressure", severity = "warning") {
  return {
    schema_version: 2,
    id: `finding:${kind}`,
    fingerprint: kind,
    source_kind: "resource-snapshot",
    finding_kind: kind,
    severity,
    state: "opened",
    scope_kind: "machine",
    scope_id: "local",
    summary: "Measured resource pressure",
    opened_at: new Date().toISOString(),
    observed_at: new Date().toISOString(),
    occurrence_count: 1,
    evidence: [],
    capabilities: [],
  };
}
