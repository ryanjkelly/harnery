import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureDiagnosticBundle } from "../../src/core/diagnostics/index";
import {
  SUPERVISOR_FINDING_SCHEMA_VERSION,
  type SupervisorFinding,
  type SupervisorFindings,
} from "../../src/core/supervisor/contract";
import {
  diagnosticsVersion,
  normalizeDiagnosticsQuery,
  readDiagnosticComparison,
  readFrozenDiagnostics,
  readLiveDiagnostics,
} from "./diagnostics-reader";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("diagnostics reader", () => {
  test("reads a live finding and derives bounded detail when caches are absent", () => {
    const root = fixtureRoot();
    const finding = fixtureFinding();
    const report: SupervisorFindings = {
      schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
      max_findings: 100,
      active: [finding],
      transitions: [finding],
    };
    writeJson(path.join(root, ".harnery", "supervisor", "findings.json"), report);

    const view = readLiveDiagnostics(root, { finding: finding.id });

    expect(view.mode).toBe("live");
    expect(view.findings).toHaveLength(1);
    expect(view.selectedFinding?.id).toBe(finding.id);
    expect(view.timeline?.finding_id).toBe(finding.id);
    expect(view.explanation?.finding_id).toBe(finding.id);
  });

  test("frozen routes reject path-like refs and never borrow live findings", () => {
    const root = fixtureRoot();
    writeJson(path.join(root, ".harnery", "supervisor", "findings.json"), {
      schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
      max_findings: 100,
      active: [fixtureFinding()],
      transitions: [],
    });

    expect(() => readFrozenDiagnostics(root, "../supervisor/findings.json")).toThrow(
      "opaque artifact id",
    );
  });

  test("compares two opaque frozen bundle ids without reading live state", () => {
    const root = fixtureRoot();
    const before = captureDiagnosticBundle(root, {
      now: new Date("2026-09-01T09:00:00.000Z"),
      machineLabel: "web-test-machine",
      engineVersion: "test-build",
    });
    const after = captureDiagnosticBundle(root, {
      now: new Date("2026-09-01T09:05:00.000Z"),
      machineLabel: "web-test-machine",
      engineVersion: "test-build",
    });

    const comparison = readDiagnosticComparison(
      root,
      before.manifest.artifact_id,
      after.manifest.artifact_id,
    );

    expect(comparison.before.artifact_id).toBe(before.manifest.artifact_id);
    expect(comparison.after.artifact_id).toBe(after.manifest.artifact_id);
    expect(comparison.observer_only).toBe(true);
    expect(() =>
      readDiagnosticComparison(root, "../supervisor/findings.json", after.manifest.artifact_id),
    ).toThrow("opaque artifact id");
  });

  test("version changes when a disposable projection changes", async () => {
    const root = fixtureRoot();
    const file = path.join(root, ".harnery", "supervisor", "findings.json");
    writeJson(file, { first: true });
    const first = diagnosticsVersion(root);
    await Bun.sleep(10);
    writeJson(file, { second: true });
    expect(Number(diagnosticsVersion(root))).toBeGreaterThan(Number(first));
  });

  test("canonicalizes allowed filters and makes malformed selections unavailable", () => {
    expect(normalizeDiagnosticsQuery({ state: "OPENED", severity: "warning" })).toEqual({
      state: "opened",
      severity: "warning",
    });
    expect(normalizeDiagnosticsQuery({ state: "invented", source: ["a", "b"] })).toEqual({});
    expect(normalizeDiagnosticsQuery({ finding: ["find_a", "find_b"] })).toEqual({
      finding: "__invalid_selection__",
    });
    expect(normalizeDiagnosticsQuery({ finding: "../../secret" })).toEqual({
      finding: "__invalid_selection__",
    });
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "harnery-diagnostics-web-"));
  roots.push(root);
  mkdirSync(path.join(root, ".harnery", "artifacts"), { recursive: true });
  return root;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function fixtureFinding(): SupervisorFinding {
  return {
    schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
    id: "find_memory",
    fingerprint: "memory",
    source_kind: "resource.snapshot",
    finding_kind: "machine.memory-pressure",
    finding_class: "contention",
    severity: "critical",
    state: "opened",
    scope_kind: "machine",
    scope_id: "local",
    summary: "Machine memory is under pressure.",
    opened_at: "2026-08-30T20:00:00.000Z",
    observed_at: "2026-08-30T20:01:00.000Z",
    occurrence_count: 1,
    primary_source: {
      id: "src_memory",
      source_kind: "resource.snapshot",
      source_id: "linux:local",
      observed_at: "2026-08-30T20:01:00.000Z",
      capability: "supported",
    },
    evidence: [
      {
        id: "ev_memory",
        source: {
          id: "src_memory",
          source_kind: "resource.snapshot",
          source_id: "linux:local",
          observed_at: "2026-08-30T20:01:00.000Z",
          capability: "supported",
        },
        summary: "Memory reached 91 percent.",
        observed_value: 91,
        unit: "percent",
      },
    ],
    capabilities: [{ source_kind: "resource.snapshot", state: "supported" }],
  };
}
