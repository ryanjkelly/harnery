import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { captureDiagnosticBundle } from "../core/diagnostics/index.ts";
import { SUPERVISOR_FINDING_SCHEMA_VERSION } from "../core/supervisor/contract.ts";
import { supervisorPaths } from "../core/supervisor/storage.ts";
import { registerDiagnosticsCommand } from "./diagnostics.ts";

describe("diagnostics command", () => {
  test("registers the stable bundle lifecycle", () => {
    const program = new Command();
    registerDiagnosticsCommand(program, quietEmit());
    const command = program.commands.find((candidate) => candidate.name() === "diagnostics");
    expect(command?.commands.map((candidate) => candidate.name())).toEqual([
      "list",
      "show",
      "explain",
      "capture",
      "replay",
      "compare",
    ]);
  });

  test("compares two validated bundles in JSON and readable modes", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-diagnostics-command-"));
    try {
      const before = captureDiagnosticBundle(root, {
        now: new Date("2026-09-01T09:00:00.000Z"),
        machineLabel: "command-test-machine",
        engineVersion: "test-build-v1",
      });
      const after = captureDiagnosticBundle(root, {
        now: new Date("2026-09-01T09:05:00.000Z"),
        machineLabel: "command-test-machine",
        engineVersion: "test-build-v1",
      });

      const json = capturedEmit();
      const jsonProgram = new Command();
      registerDiagnosticsCommand(jsonProgram, json.emit, { repoRoot: root });
      await jsonProgram.parseAsync([
        "node",
        "harn",
        "diagnostics",
        "compare",
        before.manifest.artifact_id,
        after.manifest.artifact_id,
        "--json",
      ]);
      expect(json.formats).toEqual(["json"]);
      expect(json.payloads[0]).toMatchObject({
        kind: "diagnostic_bundle_comparison",
        comparison: {
          observer_only: true,
          before: { artifact_id: before.manifest.artifact_id },
          after: { artifact_id: after.manifest.artifact_id },
        },
      });

      const readable = capturedEmit();
      const readableProgram = new Command();
      registerDiagnosticsCommand(readableProgram, readable.emit, { repoRoot: root });
      await readableProgram.parseAsync([
        "node",
        "harn",
        "diagnostics",
        "compare",
        before.manifest.artifact_id,
        after.manifest.artifact_id,
      ]);
      expect(readable.texts.join("\n")).toContain("diagnostic comparison:");
      expect(readable.texts.join("\n")).toContain("observer only:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports explicit unknown advice from live and frozen missing sources", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-diagnostics-command-"));
    try {
      const live = capturedEmit();
      const liveProgram = new Command();
      registerDiagnosticsCommand(liveProgram, live.emit, { repoRoot: root });
      await liveProgram.parseAsync(["node", "harn", "diagnostics", "explain", "--json"]);
      expect(live.formats).toEqual(["json"]);
      expect(live.payloads[0]).toMatchObject({
        kind: "diagnostic_advice",
        source: { mode: "live" },
        advice: {
          pressure: "unknown",
          fan_out_recommendation: "unknown",
          observer_only: true,
        },
      });

      const captured = captureDiagnosticBundle(root, {
        now: new Date("2026-08-31T09:00:00.000Z"),
        machineLabel: "command-test-machine",
        engineVersion: "test-build-v1",
      });
      const frozen = capturedEmit();
      const frozenProgram = new Command();
      registerDiagnosticsCommand(frozenProgram, frozen.emit, { repoRoot: root });
      await frozenProgram.parseAsync([
        "node",
        "harn",
        "diagnostics",
        "explain",
        "--bundle",
        captured.manifest.artifact_id,
        "--json",
      ]);
      expect(frozen.payloads[0]).toMatchObject({
        kind: "diagnostic_advice",
        source: {
          mode: "frozen",
          artifact_id: captured.manifest.artifact_id,
          captured_at: "2026-08-31T09:00:00.000Z",
        },
        advice: { pressure: "unknown", observer_only: true },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("marks a lingering findings file expired when the supervisor is not running", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-diagnostics-command-"));
    try {
      const paths = supervisorPaths(root);
      mkdirSync(paths.root, { recursive: true });
      writeFileSync(
        paths.findings,
        `${JSON.stringify({
          schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
          active: [],
          transitions: [],
        })}\n`,
      );
      const captured = capturedEmit();
      const program = new Command();
      registerDiagnosticsCommand(program, captured.emit, { repoRoot: root });

      await program.parseAsync(["node", "harn", "diagnostics", "explain", "--json"]);

      expect(captured.payloads[0]).toMatchObject({
        kind: "diagnostic_advice",
        advice: {
          pressure: "unknown",
          active_finding_count: 0,
          source_capability: {
            state: "expired",
            reason_code: "supervisor_status_missing",
          },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function capturedEmit(): {
  emit: EmitContext;
  payloads: unknown[];
  formats: string[];
  texts: string[];
} {
  const payloads: unknown[] = [];
  const formats: string[] = [];
  const texts: string[] = [];
  return {
    payloads,
    formats,
    texts,
    emit: {
      config: (opts) => {
        if (opts.format) formats.push(opts.format);
      },
      data: (payload) => payloads.push(payload),
      rows() {},
      text: (value) => texts.push(value),
      file() {},
      error: (error) => {
        throw error;
      },
      log() {},
      setExitCode() {},
    },
  };
}

function quietEmit(): EmitContext {
  return {
    config() {},
    data() {},
    rows() {},
    text() {},
    file() {},
    error() {},
    log() {},
    setExitCode() {},
  };
}
