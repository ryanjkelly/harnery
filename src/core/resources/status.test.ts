import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pressureAssessmentFixture,
  pressureRecordFixture,
  resourceFindingFixture,
  resourceStatusFixture,
} from "../../../tests/helpers/resource-status.ts";
import { SUPERVISOR_FINDING_SCHEMA_VERSION } from "../supervisor/contract.ts";
import { supervisorPaths } from "../supervisor/storage.ts";
import {
  formatResourceStatus,
  formatResourceSummary,
  RESOURCE_STATUS_MAX_BYTES,
  readResourceStatus,
} from "./status.ts";
import { resourcePaths, writePrivateJsonAtomic } from "./storage.ts";

let root: string;
let nowMs: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harn-resource-read-"));
  nowMs = Date.now();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("cached resource status", () => {
  test("projects fresh totals, scope and age without command strings or unknown fields", () => {
    const snapshot = resourceStatusFixture(root, nowMs - 2000);
    writePrivateJsonAtomic(resourcePaths(root).snapshot, {
      ...snapshot,
      private_secret: "secret",
      machine: { ...snapshot.machine, private_secret: "secret" },
    });
    const status = readResourceStatus(root, { nowMs });
    expect(status).toMatchObject({
      state: "fresh",
      sample_age_ms: 2000,
      namespace: "wsl",
      assessment: { state: "normal", scope: "guest" },
      assessment_capability: { state: "supported" },
      writer: { running: true },
    });
    expect(status.machine?.cpu_percent).toBe(30);
    expect(status.processes).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(JSON.stringify(status)).not.toContain("should-not-appear");
    expect(formatResourceSummary(status).startsWith(status.assessment.summary)).toBe(true);
    expect(formatResourceSummary(status)).toContain("CPU 30%");
    expect(formatResourceSummary(status)).toContain(
      "RAM 8.0 GiB available, disk 40.0 GiB available",
    );
    expect(formatResourceStatus(status, "project")).toContain("Disk I/O: supported");
  });

  test("reports a missing cache without creating any files", () => {
    const status = readResourceStatus(root);
    expect(status).toMatchObject({
      state: "unavailable",
      reason: "snapshot_missing",
      assessment: { state: "unknown", recommended_action: "unknown" },
      assessment_capability: { state: "unsupported", reason_code: "pressure_record_missing" },
      machine: null,
    });
    expect(formatResourceStatus(status, "project")).toContain("project supervisor start");
  });

  test("stale samples do not expose old measurements or a normal assessment", () => {
    resourceStatusFixture(root, nowMs - 16_000);
    expect(readResourceStatus(root, { nowMs })).toMatchObject({
      state: "stale",
      sample_age_ms: 16000,
      assessment: { state: "unknown" },
      machine: null,
      disks: [],
    });
  });

  test("rejects malformed, oversized, wrong-schema and invalid numeric payloads", () => {
    const snapshot = resourceStatusFixture(root, nowMs);
    for (const payload of [
      "{broken",
      "[]",
      JSON.stringify({ ...snapshot, schema_version: 90 }),
      JSON.stringify({ ...snapshot, machine: { ...snapshot.machine, memory_available_bytes: -1 } }),
      JSON.stringify({ ...snapshot, machine: { ...snapshot.machine, cpu_percent: 101 } }),
      JSON.stringify({
        ...snapshot,
        pressure: { ...snapshot.pressure, memory_full: { avg10: 101, avg60: 0, avg300: 0 } },
      }),
      JSON.stringify({
        ...snapshot,
        oom: {
          state: "supported",
          total_kills: 1.5,
          kills_since_last_sample: 0,
          last_kill_age_ms: null,
        },
      }),
      JSON.stringify({
        ...snapshot,
        pressure: {
          state: "supported",
          cpu: { avg10: -1, avg60: 0, avg300: 0 },
          memory: null,
          io: null,
        },
      }),
    ]) {
      writeFileSync(resourcePaths(root).snapshot, payload);
      expect(readResourceStatus(root, { nowMs })).toMatchObject({
        state: "unavailable",
        reason: "snapshot_invalid",
        machine: null,
      });
    }
    writeFileSync(resourcePaths(root).snapshot, " ".repeat(RESOURCE_STATUS_MAX_BYTES + 1));
    expect(readResourceStatus(root).reason).toBe("snapshot_too_large");
  });

  test("exposes full stall windows, direction, and recent OOM evidence in cached output", () => {
    const snapshot = resourceStatusFixture(root, nowMs);
    snapshot.pressure!.memory_full = { avg10: 70, avg60: 30, avg300: 5 };
    snapshot.oom = {
      state: "supported",
      total_kills: 4,
      kills_since_last_sample: 1,
      last_kill_age_ms: 0,
    };
    writePrivateJsonAtomic(resourcePaths(root).snapshot, snapshot);
    const status = readResourceStatus(root, { nowMs });
    expect(status.pressure?.memory_full?.avg10).toBe(70);
    expect(status.oom?.kills_since_last_sample).toBe(1);
    const report = formatResourceStatus(status, "project");
    expect(report).toContain("Full memory stalls: 70% / 30% / 5%");
    expect(report).toContain("rising");
    expect(report).toContain("OOM kills: 4 total; 1 since previous sample");
  });

  test("rejects future and unparseable timestamps, tolerating small clock skew", () => {
    const snapshot = resourceStatusFixture(root, nowMs);
    for (const sampled_at of ["not-a-date", new Date(nowMs + 60_000).toISOString()]) {
      writePrivateJsonAtomic(resourcePaths(root).snapshot, { ...snapshot, sampled_at });
      expect(readResourceStatus(root, { nowMs }).reason).toBe("snapshot_clock_invalid");
    }
    writePrivateJsonAtomic(resourcePaths(root).snapshot, {
      ...snapshot,
      sampled_at: new Date(nowMs + 100).toISOString(),
    });
    expect(readResourceStatus(root, { nowMs }).sample_age_ms).toBe(0);
  });

  test("keeps partial macOS metrics usable and unsupported measurements explicit", () => {
    const snapshot = resourceStatusFixture(root, nowMs);
    writePrivateJsonAtomic(resourcePaths(root).snapshot, {
      ...snapshot,
      platform: "darwin",
      namespace: "host",
      machine: { ...snapshot.machine, process_count: null },
      support: { state: "partial", sampler: "darwin", reason: "process ownership unavailable" },
      pressure: {
        state: "unsupported",
        cpu: null,
        memory: null,
        io: null,
        memory_full: null,
        io_full: null,
      },
    });
    expect(readResourceStatus(root, { nowMs })).toMatchObject({
      state: "fresh",
      platform: "darwin",
      machine: { process_count: null, cpu_percent: 30 },
      support: { state: "partial" },
      pressure: { state: "unsupported" },
    });
    expect(formatResourceSummary(readResourceStatus(root))).toContain("partial");
  });

  test("preserves CPU warmup and sampler error states", () => {
    const snapshot = resourceStatusFixture(root, nowMs);
    writePrivateJsonAtomic(resourcePaths(root).snapshot, {
      ...snapshot,
      machine: { ...snapshot.machine, cpu_percent: null },
    });
    expect(formatResourceSummary(readResourceStatus(root))).toContain("CPU warming up");
    writePrivateJsonAtomic(resourcePaths(root).snapshot, {
      ...snapshot,
      support: { state: "error", sampler: "darwin", reason: "read failed" },
    });
    expect(readResourceStatus(root)).toMatchObject({
      state: "unavailable",
      reason: "sampler_error",
      machine: null,
    });
  });

  test("bounds explicit process output and omits command arguments", () => {
    const snapshot = resourceStatusFixture(root, nowMs);
    const processes = Array.from({ length: 50 }, (_, i) => ({
      ...snapshot.processes[0],
      pid: i + 1,
      rss_bytes: i * 1024,
    }));
    writePrivateJsonAtomic(resourcePaths(root).snapshot, {
      ...snapshot,
      processes,
      omitted_process_count: 2,
    });
    const status = readResourceStatus(root, { includeProcesses: true });
    expect(status.processes).toHaveLength(20);
    expect(status.processes?.[0]?.pid).toBe(50);
    expect(status.processes_omitted).toBe(32);
    expect(JSON.stringify(status)).not.toContain("should-not-appear");
  });

  test("reports the published assessment rather than deriving one from findings", () => {
    resourceStatusFixture(root, nowMs);
    pressureRecordFixture(root, {
      nowMs,
      assessment: {
        state: "critical",
        limiting_resource: "memory",
        trend: "rising",
        recommended_action: "avoid-new-heavy-work",
        summary: "Memory is contended, so do not start new heavy work.",
      },
    });
    const status = readResourceStatus(root, { nowMs });
    expect(status.assessment).toMatchObject({
      state: "critical",
      limiting_resource: "memory",
      recommended_action: "avoid-new-heavy-work",
    });
    expect(formatResourceSummary(status)).toContain(
      "Memory is contended, so do not start new heavy work.",
    );
    expect(formatResourceStatus(status, "project")).toContain(
      "Assessment: critical at guest scope; limiting resource memory; trend rising",
    );
  });

  test("a critical attribution finding no longer changes the reported state", () => {
    resourceStatusFixture(root, nowMs);
    writePrivateJsonAtomic(supervisorPaths(root).findings, {
      schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
      active: [resourceFindingFixture("process.memory-pressure", "critical")],
      transitions: [],
      max_findings: 200,
    });
    expect(readResourceStatus(root, { nowMs }).assessment.state).toBe("normal");
  });

  test("names an owner only when the contributor attribution is exact", () => {
    resourceStatusFixture(root, nowMs);
    pressureRecordFixture(root, {
      nowMs,
      assessment: {
        contributors: [
          {
            finding_id: "finding:a",
            finding_kind: "process.memory-pressure",
            finding_class: "attribution",
            severity: "warning",
            summary: "One process holds 1.2 GiB.",
            scope_kind: "process",
            scope_id: "11",
            occurrence_count: 1,
            attribution_state: "attributed",
            attribution_confidence: "exact",
            owner_kind: "agent",
            owner_id: "agent-Named",
          },
          {
            finding_id: "finding:b",
            finding_kind: "group.memory-pressure",
            finding_class: "attribution",
            severity: "warning",
            summary: "An unowned group holds 2 GiB.",
            scope_kind: "group",
            scope_id: "22",
            occurrence_count: 1,
            attribution_state: "unattributed",
            attribution_confidence: "none",
            owner_kind: "agent",
            owner_id: "agent-Guessed",
          },
        ],
      },
    });
    const report = formatResourceStatus(readResourceStatus(root, { nowMs }), "project");
    expect(report).toContain("agent agent-Named");
    expect(report).not.toContain("agent-Guessed");
    expect(report).toContain("no validated owner");
  });

  test("treats a stale, missing, or malformed pressure record as unknown, never healthy", () => {
    resourceStatusFixture(root, nowMs);
    utimesSync(supervisorPaths(root).pressure, new Date(nowMs - 60_000), new Date(nowMs - 60_000));
    const stale = readResourceStatus(root, { nowMs });
    expect(stale.assessment.state).toBe("unknown");
    expect(stale.assessment_capability).toMatchObject({
      state: "expired",
      reason_code: "pressure_record_stale",
    });
    expect(stale.assessment.summary).toContain("60 seconds old");

    resourceStatusFixture(root, nowMs);
    rmSync(supervisorPaths(root).pressure);
    expect(readResourceStatus(root, { nowMs }).assessment_capability).toMatchObject({
      state: "unsupported",
      reason_code: "pressure_record_missing",
    });

    for (const payload of [
      "{broken",
      "[]",
      JSON.stringify({ schema_version: 90 }),
      JSON.stringify({
        ...pressureRecordFixture(root, { nowMs }),
        assessment: { state: "normal" },
      }),
      JSON.stringify({
        ...pressureRecordFixture(root, { nowMs }),
        assessment: {
          ...pressureAssessmentFixture(),
          state: "definitely-fine",
        },
      }),
      JSON.stringify({
        ...pressureRecordFixture(root, { nowMs }),
        assessment: { ...pressureAssessmentFixture(), observer_only: false },
      }),
    ]) {
      writeFileSync(supervisorPaths(root).pressure, payload);
      utimesSync(supervisorPaths(root).pressure, new Date(nowMs), new Date(nowMs));
      const status = readResourceStatus(root, { nowMs });
      expect(status.assessment.state).toBe("unknown");
      expect(status.assessment_capability.state).toBe("malformed");
    }
  });

  test("does not turn a stopped writer into a healthy assessment", () => {
    resourceStatusFixture(root, nowMs);
    rmSync(supervisorPaths(root).service);
    const status = readResourceStatus(root, { nowMs });
    expect(status).toMatchObject({ state: "fresh", writer: { running: false } });
    expect(formatResourceSummary(status)).toContain("writer stopped");
  });

  test("keeps Windows host scope separate and expires its slower sample after 30 seconds", () => {
    const snapshot = resourceStatusFixture(root, nowMs);
    const host = {
      platform: "win32",
      sampled_at: new Date(nowMs - 20_000).toISOString(),
      state: "supported",
      machine: { ...snapshot.machine, cpu_percent: 85 },
      disks: [],
    };
    writePrivateJsonAtomic(resourcePaths(root).snapshot, { ...snapshot, host });
    expect(readResourceStatus(root, { nowMs })).toMatchObject({
      namespace: "wsl",
      machine: { cpu_percent: 30 },
      host: { state: "supported", machine: { cpu_percent: 85 } },
    });
    writePrivateJsonAtomic(resourcePaths(root).snapshot, {
      ...snapshot,
      host: { ...host, sampled_at: new Date(nowMs - 31_000).toISOString() },
    });
    expect(readResourceStatus(root, { nowMs }).host).toMatchObject({
      state: "error",
      machine: null,
      reason: "host_snapshot_stale",
    });
  });
});
