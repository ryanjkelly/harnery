import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { createHarneryProgram, type EmitContext } from "../commander.ts";
import { harneryStorageFamilies } from "../core/storage/builtins.ts";
import type { HarneryStorageFamily } from "../core/storage/contract.ts";
import { registerLogsCommand } from "./logs.ts";

describe("logs command", () => {
  test("lists registered log families without creating dormant roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-logs-command-"));
    const payloads: unknown[] = [];
    const emit: EmitContext = {
      config() {},
      data: (payload) => {
        payloads.push(payload);
      },
      rows() {},
      text() {},
      file() {},
      error: (error) => {
        throw error;
      },
      log() {},
      setExitCode() {},
    };
    try {
      const program = new Command();
      registerLogsCommand(program, emit, { repoRoot: root, resolveCoordRoot: () => root });
      await program.parseAsync(["node", "harn", "logs", "list", "--json"]);
      const report = payloads[0] as {
        schema: string;
        diagnostics: unknown[];
        dormant_families: string[];
        families: Array<{
          family_id: string;
          effective_policy: {
            state: string;
            max_bytes: number;
            max_age_ms: number;
            provenance: { max_bytes: { source: string } };
          };
          usage: { managed_bytes: number; unmanaged_bytes: number };
          pressure: { state: string; reason_codes: string[] };
          retention: { state: string; enforcement: string; reason_codes: string[] };
        }>;
      };
      expect(report.schema).toBe("harnery.logs-list/v2");
      const family = report.families.find(
        (candidate) => candidate.family_id === "agent-hook-debug-log",
      );
      expect(family).toMatchObject({
        effective_policy: {
          state: "valid",
          max_bytes: 64 * 1024 * 1024,
          max_age_ms: 7 * 24 * 60 * 60 * 1_000,
          provenance: { max_bytes: { source: "built-in" } },
        },
        usage: { managed_bytes: 0, unmanaged_bytes: 0 },
        pressure: { state: "within_budget", reason_codes: ["root_dormant"] },
        retention: { state: "active", enforcement: "manual", reason_codes: ["root_dormant"] },
      });
      expect(
        report.families.find((candidate) => candidate.family_id === "tunnel-process-log"),
      ).toMatchObject({
        directory: null,
        retention: {
          state: "unmanaged",
          enforcement: "none",
          reason_codes: ["unsupported_log_family"],
        },
      });
      expect(report.diagnostics).toEqual([]);
      expect(report.dormant_families).toEqual([]);
      expect(existsSync(join(root, ".harnery", "logs"))).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports invalid storage configuration without silently enabling retention", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-logs-command-invalid-"));
    const payloads: unknown[] = [];
    const errors: unknown[] = [];
    const emit: EmitContext = {
      config() {},
      data: (payload) => payloads.push(payload),
      rows() {},
      text() {},
      file() {},
      error: (error) => errors.push(error),
      log() {},
      setExitCode() {},
    };
    try {
      mkdirSync(join(root, ".harnery"), { recursive: true });
      writeFileSync(
        join(root, ".harnery", "config.jsonc"),
        '{ "logs": { "storage": { "classes": { "debug-log": { "max_bytes": 1 } } } } }\n',
      );
      const program = new Command();
      registerLogsCommand(program, emit, { repoRoot: root, resolveCoordRoot: () => root });
      await program.parseAsync(["node", "harn", "logs", "list", "--json"]);
      const report = payloads[0] as {
        diagnostics: Array<{ code: string }>;
        families: Array<{
          family_id: string;
          effective_policy: { state: string };
          retention: { state: string; enforcement: string; reason_codes: string[] };
        }>;
      };
      expect(report.diagnostics.some(({ code }) => code === "value_out_of_range")).toBeTrue();
      expect(
        report.families.find(({ family_id }) => family_id === "agent-hook-debug-log"),
      ).toMatchObject({
        effective_policy: { state: "invalid" },
        retention: {
          state: "blocked",
          enforcement: "none",
          reason_codes: ["effective_policy_invalid"],
        },
      });
      expect(errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports delegated host logs as unmanaged instead of assuming shared segments", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-logs-command-host-"));
    const payloads: unknown[] = [];
    const emit: EmitContext = {
      config() {},
      data: (payload) => payloads.push(payload),
      rows() {},
      text() {},
      file() {},
      error: (error) => {
        throw error;
      },
      log() {},
      setExitCode() {},
    };
    const source = harneryStorageFamilies().find(({ id }) => id === "agent-operational-log")!;
    const hostLog: HarneryStorageFamily = {
      ...source,
      id: "host-text-log",
      owner: "fixture host",
      format: "text",
      roots: (context) => [
        {
          path: join(context.coord_root, ".host", "application.log"),
          kind: "file",
          match: "exact",
          ownership: "host",
        },
      ],
      provider: {
        provider_id: "host-text-log-provider",
        kind: "delegated",
        inventory: "delegated",
        maintenance: "delegated",
        lifecycle_authority: "fixture host",
      },
    };
    try {
      const program = new Command();
      registerLogsCommand(program, emit, {
        repoRoot: root,
        resolveCoordRoot: () => root,
        storage: { families: [hostLog] },
      });
      await program.parseAsync(["node", "harn", "logs", "list", "--json"]);
      const report = payloads[0] as {
        families: Array<{
          family_id: string;
          directory: string | null;
          registered_roots: Array<{ path: string; match: string }>;
          effective_policy: unknown;
          retention: { state: string; enforcement: string; reason_codes: string[] };
        }>;
      };
      expect(report.families.find(({ family_id }) => family_id === "host-text-log")).toMatchObject({
        directory: null,
        registered_roots: [{ path: join(root, ".host", "application.log"), match: "exact" }],
        effective_policy: null,
        retention: {
          state: "unmanaged",
          enforcement: "none",
          reason_codes: ["unsupported_log_family"],
        },
      });
      expect(existsSync(join(root, ".host"))).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("standalone command resolves project configuration and log roots from cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-logs-command-standalone-"));
    const payloads: unknown[] = [];
    const previousCwd = process.cwd();
    const savedEnvironment = {
      HARNERY_COORD_ROOT: process.env.HARNERY_COORD_ROOT,
      HARNERY_COORD_ROOT_OVERRIDE: process.env.HARNERY_COORD_ROOT_OVERRIDE,
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
    };
    const emit: EmitContext = {
      config() {},
      data: (payload) => payloads.push(payload),
      rows() {},
      text() {},
      file() {},
      error: (error) => {
        throw error;
      },
      log() {},
      setExitCode() {},
    };
    try {
      mkdirSync(join(root, ".harnery"), { recursive: true });
      writeFileSync(
        join(root, ".harnery", "config.jsonc"),
        '{ "logs": { "storage": { "classes": { "debug-log": { "max_bytes": 20971520, "max_age_days": 2 } } } } }\n',
      );
      process.chdir(root);
      delete process.env.HARNERY_COORD_ROOT;
      delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
      delete process.env.CLAUDE_PROJECT_DIR;
      const program = createHarneryProgram({ emit });
      await program.parseAsync(["logs", "list", "--json"], { from: "user" });
      const report = payloads[0] as {
        families: Array<{
          family_id: string;
          directory: string | null;
          effective_policy: { max_bytes: number; max_age_days: number };
        }>;
      };
      expect(
        report.families.find(({ family_id }) => family_id === "agent-hook-debug-log"),
      ).toMatchObject({
        directory: join(root, ".harnery", "logs", "agent-hook-debug"),
        effective_policy: { max_bytes: 20 * 1024 * 1024, max_age_days: 2 },
      });
    } finally {
      process.chdir(previousCwd);
      restoreEnvironment("HARNERY_COORD_ROOT", savedEnvironment.HARNERY_COORD_ROOT);
      restoreEnvironment(
        "HARNERY_COORD_ROOT_OVERRIDE",
        savedEnvironment.HARNERY_COORD_ROOT_OVERRIDE,
      );
      restoreEnvironment("CLAUDE_PROJECT_DIR", savedEnvironment.CLAUDE_PROJECT_DIR);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
