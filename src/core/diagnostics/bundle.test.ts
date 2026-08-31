import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ARTIFACT_MANIFEST } from "../artifacts/index.ts";
import { RESOURCE_SNAPSHOT_SCHEMA_VERSION } from "../resources/contract.ts";
import {
  SUPERVISOR_ACTIVITY_SCHEMA_VERSION,
  SUPERVISOR_FINDING_SCHEMA_VERSION,
  SUPERVISOR_HISTORY_SCHEMA_VERSION,
  SUPERVISOR_LOG_FEED_SCHEMA_VERSION,
  SUPERVISOR_SNAPSHOT_SCHEMA_VERSION,
} from "../supervisor/contract.ts";
import {
  captureDiagnosticBundle,
  readFrozenDiagnosticBundle,
  replayDiagnosticBundle,
  validateDiagnosticBundle,
} from "./bundle.ts";
import { pseudonymousMachineId } from "./identity.ts";
import { sha256 } from "./replay.ts";
import { sanitizeDiagnosticValue } from "./sanitize.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("diagnostic bundles", () => {
  test("captures sanitized fixed files and replays without live sources", () => {
    const root = repo();
    const fixture = JSON.parse(
      readFileSync(
        resolve(import.meta.dir, "../../../tests/fixtures/diagnostics/credential-shaped.json"),
        "utf8",
      ),
    );
    const scenarios = JSON.parse(
      readFileSync(
        resolve(import.meta.dir, "../../../tests/fixtures/diagnostics/source-scenarios.json"),
        "utf8",
      ),
    );
    writeReplaySources(root, "2026-08-30T12:10:00.000Z");
    writeSource(root, "supervisor/timelines/credential-shaped.json", fixture);
    writeSource(root, "supervisor/explanations/source-scenarios.json", scenarios);
    writeSource(root, "supervisor/findings.json", {
      schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
      active: [],
      transitions: [],
    });

    const captured = captureDiagnosticBundle(root, {
      startAt: "2026-08-30T12:00:00.000Z",
      endAt: "2026-08-30T12:10:00.000Z",
      now: new Date("2026-08-30T12:10:00.000Z"),
      machineLabel: "diagnostic-test-machine",
      engineVersion: "test-build-v1",
    });

    expect(captured.summary.machine_id_kind).toBe("pseudonymous");
    expect(
      captured.manifest.sources.find((source) => source.source_kind === "supervisor.activity"),
    ).toMatchObject({ capability: "supported", entry_count: 1 });
    expect(captured.summary.sanitized_value_count).toBeGreaterThanOrEqual(9);
    expect(captured.manifest.files.map((file) => file.path).sort()).toEqual([
      "expected.json",
      "inputs/observations.json",
      "inputs/thresholds.json",
      "summary.json",
    ]);
    const emittedFiles = [
      ARTIFACT_MANIFEST,
      "diagnostic-manifest.json",
      "inputs/observations.json",
      "inputs/thresholds.json",
      "expected.json",
      "summary.json",
    ];
    const raw = emittedFiles
      .map((path) => readFileSync(join(captured.path, path), "utf8"))
      .join("\n");
    for (const sentinel of credentialSentinels(fixture)) expect(raw).not.toContain(sentinel);

    rmSync(join(root, ".harnery", "supervisor"), { recursive: true, force: true });
    rmSync(join(root, ".harnery", "resources"), { recursive: true, force: true });
    const replay = replayDiagnosticBundle(
      root,
      captured.manifest.artifact_id,
      new Date("2026-08-30T12:11:00.000Z"),
    );
    expect(replay.matched).toBeTrue();
    expect(replay.expected_digest).toBe(replay.actual_digest);
  });

  test("keeps unsupported replay sources explicit without reading live state", () => {
    const root = repo();
    const captured = captureDiagnosticBundle(root, {
      now: new Date("2026-08-30T12:10:00.000Z"),
      machineLabel: "machine-a",
      engineVersion: "test-build-v1",
    });
    expect(
      captured.manifest.sources.find((source) => source.source_kind === "resources.snapshot"),
    ).toMatchObject({ capability: "unsupported", omitted_count: 1 });
    const replay = replayDiagnosticBundle(root, captured.manifest.artifact_id);
    expect(replay.matched).toBeFalse();
    expect(replay.finding_count).toBe(1);
  });

  test("selects one finding and reproduces it deterministically", () => {
    const root = repo();
    const finding = diagnosticFinding("find_memory_growth");
    writeSource(root, "supervisor/findings.json", {
      schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
      active: [finding],
      transitions: [],
    });
    const captured = captureDiagnosticBundle(root, {
      findingId: finding.id,
      now: new Date("2026-08-30T12:06:00.000Z"),
      machineLabel: "machine-a",
      engineVersion: "test-build-v1",
    });
    const validated = validateDiagnosticBundle(root, captured.manifest.artifact_id);
    expect(validated.expected.findings.map((item) => item.id)).toEqual([finding.id]);
    expect(validated.observations.selection).toEqual({
      finding_id: finding.id,
      start_at: finding.opened_at,
      end_at: finding.observed_at,
    });
  });

  test("rejects digest mismatch, extra files, symlinks, and path-shaped frozen refs", () => {
    const root = repo();
    const captured = captureDiagnosticBundle(root, {
      now: new Date("2026-08-30T12:06:00.000Z"),
      machineLabel: "machine-a",
      engineVersion: "test-build-v1",
    });
    writeFileSync(join(captured.path, "expected.json"), "{}\n", { mode: 0o600 });
    expect(() => validateDiagnosticBundle(root, captured.manifest.artifact_id)).toThrow(
      "byte length mismatch",
    );

    const extra = captureDiagnosticBundle(root, {
      now: new Date("2026-08-30T12:07:00.000Z"),
      machineLabel: "machine-a",
      engineVersion: "test-build-v1",
    });
    writeFileSync(join(extra.path, "extra.json"), "{}\n");
    expect(() => validateDiagnosticBundle(root, extra.manifest.artifact_id)).toThrow(
      "file set is not exact",
    );

    const linked = captureDiagnosticBundle(root, {
      now: new Date("2026-08-30T12:08:00.000Z"),
      machineLabel: "machine-a",
      engineVersion: "test-build-v1",
    });
    const summary = join(linked.path, "summary.json");
    rmSync(summary);
    symlinkSync(join(linked.path, "expected.json"), summary);
    expect(() => validateDiagnosticBundle(root, linked.manifest.artifact_id)).toThrow(
      "not a regular file",
    );
    expect(() => readFrozenDiagnosticBundle(root, linked.path)).toThrow("opaque artifact id");
  });

  test("rejects unknown manifest keys, invalid expected schemas, and external trees", () => {
    const root = repo();
    const unknown = captureDiagnosticBundle(root, {
      now: new Date("2026-08-30T12:09:00.000Z"),
      machineLabel: "machine-a",
      engineVersion: "test-build-v1",
    });
    const manifestPath = join(unknown.path, "diagnostic-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.unexpected = true;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    expect(() => validateDiagnosticBundle(root, unknown.manifest.artifact_id)).toThrow(
      "keys are invalid",
    );

    const invalidExpected = captureDiagnosticBundle(root, {
      now: new Date("2026-08-30T12:10:00.000Z"),
      machineLabel: "machine-a",
      engineVersion: "test-build-v1",
    });
    const expectedPath = join(invalidExpected.path, "expected.json");
    const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
    expected.schema_version = 99;
    const body = `${JSON.stringify(expected)}\n`;
    writeFileSync(expectedPath, body, { mode: 0o600 });
    const validManifestPath = join(invalidExpected.path, "diagnostic-manifest.json");
    const validManifest = JSON.parse(readFileSync(validManifestPath, "utf8"));
    const descriptor = validManifest.files.find(
      (file: { path: string }) => file.path === "expected.json",
    );
    descriptor.bytes = Buffer.byteLength(body);
    descriptor.sha256 = sha256(body);
    writeFileSync(validManifestPath, `${JSON.stringify(validManifest)}\n`, { mode: 0o600 });
    expect(() => validateDiagnosticBundle(root, invalidExpected.manifest.artifact_id)).toThrow(
      "expected schema",
    );

    const external = mkdtempSync(join(tmpdir(), "forged-diagnostic-"));
    roots.push(external);
    cpSync(invalidExpected.path, join(external, "bundle"), { recursive: true });
    expect(() => validateDiagnosticBundle(root, join(external, "bundle"))).toThrow("was not found");
  });
});

describe("diagnostic sanitization", () => {
  test("removes every credential-shaped shared fixture sentinel", () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(import.meta.dir, "../../../tests/fixtures/diagnostics/credential-shaped.json"),
        "utf8",
      ),
    );
    const result = sanitizeDiagnosticValue(fixture);
    const raw = JSON.stringify(result.value);
    expect(result.stats.sanitized_value_count).toBeGreaterThanOrEqual(9);
    expect(raw).not.toContain("diagnostic-sentinel-");
    expect(raw).not.toContain("AKIADIAGNOSTICSENTINEL123");
  });

  test("machine identity is stable and explicitly pseudonymous", () => {
    expect(pseudonymousMachineId("machine-a")).toBe(pseudonymousMachineId("machine-a"));
    expect(pseudonymousMachineId("machine-a")).not.toBe(pseudonymousMachineId("machine-b"));
    expect(pseudonymousMachineId("machine-a")).toMatch(/^machine_[0-9a-f]{64}$/);
  });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-diagnostics-"));
  roots.push(root);
  return root;
}

function writeSource(root: string, path: string, value: unknown): void {
  const target = join(root, ".harnery", path);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function writeReplaySources(root: string, sampledAt: string): void {
  writeSource(root, "resources/snapshot.json", {
    schema_version: RESOURCE_SNAPSHOT_SCHEMA_VERSION,
    sampled_at: sampledAt,
    interval_ms: 2_000,
    sample_duration_ms: 1,
    collector_cpu_ms: 1,
    platform: "linux",
    namespace: "unknown",
    support: { state: "supported", sampler: "procfs" },
    machine: {
      cpu_percent: 1,
      cpu_logical_count: 4,
      load_average: [0, 0, 0],
      memory_total_bytes: 1_000,
      memory_available_bytes: 900,
      memory_used_bytes: 100,
      memory_percent: 10,
      swap_total_bytes: 0,
      swap_used_bytes: 0,
      process_count: 0,
    },
    groups: [],
    processes: [],
    visible_process_count: 0,
    omitted_process_count: 0,
    unattributed_process_count: 0,
  });
  writeSource(root, "supervisor/snapshot.json", {
    schema_version: SUPERVISOR_SNAPSHOT_SCHEMA_VERSION,
    sampled_at: sampledAt,
    sequence: 1,
    collector_duration_ms: 2,
    resource_sample_duration_ms: 1,
    services: [],
    hooks: [],
    active_finding_count: 0,
    history_point_count: 0,
    log_record_count: 0,
    live_consumer_count: 0,
    attributed_agent_count: 0,
  });
  writeSource(root, "supervisor/history.json", {
    schema_version: SUPERVISOR_HISTORY_SCHEMA_VERSION,
    interval_ms: 10_000,
    max_points: 90,
    points: [],
  });
  writeSource(root, "supervisor/log-feed.json", {
    schema_version: SUPERVISOR_LOG_FEED_SCHEMA_VERSION,
    captured_at: sampledAt,
    sequence: 1,
    lanes: [],
    total_records: 0,
    unavailable_families: 0,
  });
  writeSource(root, "supervisor/activity.json", {
    schema_version: SUPERVISOR_ACTIVITY_SCHEMA_VERSION,
    observed_at: sampledAt,
    max_entries: 64,
    omitted_entry_count: 0,
    capability: { source_kind: "coordination.activity-projection", state: "supported" },
    entries: [
      {
        scope_kind: "agent",
        scope_id: "agent-a",
        session_id: "session-agent-a",
        declared_activity: "working",
        task_state: "active",
        observed_at: sampledAt,
        source: {
          id: "source-activity-agent-a",
          source_kind: "coordination.activity-projection",
          source_id: "inst_agent-a:gen_test",
          observed_at: sampledAt,
          schema_version: SUPERVISOR_ACTIVITY_SCHEMA_VERSION,
          capability: "supported",
        },
      },
    ],
  });
}

function diagnosticFinding(id: string) {
  const source = {
    id: "source_memory_growth",
    source_kind: "resource.snapshot",
    source_id: "agent-a",
    observed_at: "2026-08-30T12:05:00.000Z",
    occurrence_count: 1,
    schema_version: 1,
    capability: "supported" as const,
  };
  return {
    schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
    id,
    fingerprint: "fingerprint_memory_growth",
    source_kind: "resource.snapshot",
    finding_kind: "resource.memory-growth",
    severity: "warning" as const,
    state: "opened" as const,
    scope_kind: "agent",
    scope_id: "agent-a",
    summary: "Memory use increased within the captured window.",
    opened_at: "2026-08-30T12:00:00.000Z",
    observed_at: "2026-08-30T12:05:00.000Z",
    primary_source: source,
    evidence: [{ id: "evidence_memory_growth", source, summary: "RSS increased." }],
    capabilities: [{ source_kind: "resource.snapshot", state: "supported" as const }],
  };
}

function credentialSentinels(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      if (
        item.includes("DIAGNOSTIC_SENTINEL") ||
        item.includes("diagnostic-sentinel") ||
        item.startsWith("AKIA")
      ) {
        found.add(item);
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) visit(child);
    }
  };
  visit(value);
  return [...found];
}
