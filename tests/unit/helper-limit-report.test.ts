import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHelperLimitReport, helperLimitSummary } from "../../src/core/helper-limit-report.ts";
import type { HelperPluginStatus } from "../../src/core/helper-plugin.ts";
import { appendHelperUsage } from "../../src/core/helper-usage.ts";
import { writeHelperLimit } from "../../src/core/preferences.ts";
import { removeDir } from "../helpers/remove-dir.ts";

const NOW = new Date("2026-11-11T18:00:00.000Z");

let dir: string;
let prefs: string;
let usage: string;
let project: string;

function status(active: boolean, reason: string | null = null): () => HelperPluginStatus {
  return () => ({
    installed: active,
    active,
    reason,
    plugin_dir: path.join(dir, "plugin"),
    settings_files: [],
    claude_version: "2.1.310",
    plugin_version: null,
  });
}

function projectConfig(config: Record<string, unknown>): string {
  mkdirSync(path.join(project, ".harnery"), { recursive: true });
  writeFileSync(path.join(project, ".harnery", "config.jsonc"), JSON.stringify(config));
  return project;
}

function build(extra: Parameters<typeof buildHelperLimitReport>[0] = {}) {
  return buildHelperLimitReport({
    coordRoot: null,
    preferencesPath: prefs,
    usageDir: usage,
    now: NOW,
    pluginStatus: status(true),
    ...extra,
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "helper-report-"));
  prefs = path.join(dir, "preferences.json");
  usage = path.join(dir, "usage");
  project = path.join(dir, "project");
  mkdirSync(project, { recursive: true });
});
afterEach(() => removeDir(dir));

describe("buildHelperLimitReport sources", () => {
  test("nothing set reads as no limit", () => {
    const report = build();
    expect(report.tool).toBe("claude-code");
    expect(report.limit).toBeNull();
    expect(report.source).toBe("none");
    expect(report.user).toBeNull();
    expect(report.project_default).toBeNull();
    expect(report.summary).toBe("Helpers have no limit.");
    expect(report.ladders).toEqual({
      models: ["haiku", "sonnet", "opus", "fable"],
      efforts: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(report.warnings).toEqual([]);
  });

  test("the project default applies when the person chose nothing", () => {
    const root = projectConfig({ helpers: { "claude-code": { max_model: "sonnet" } } });
    const report = build({ coordRoot: root });
    expect(report.source).toBe("project");
    expect(report.limit).toEqual({ max_model: "sonnet" });
    expect(report.project_default).toEqual({ max_model: "sonnet" });
    expect(report.user).toBeNull();
  });

  test("the person's choice beats the project default", () => {
    const root = projectConfig({ helpers: { "claude-code": { max_model: "sonnet" } } });
    writeHelperLimit("claude-code", { max_model: "opus", max_effort: "medium" }, prefs);
    const report = build({ coordRoot: root });
    expect(report.source).toBe("user");
    expect(report.limit).toEqual({ max_model: "opus", max_effort: "medium" });
    expect(report.user).toEqual({ max_model: "opus", max_effort: "medium" });
    expect(report.project_default).toEqual({ max_model: "sonnet" });
  });

  test("an explicit no-limit choice is {} and beats the project default", () => {
    const root = projectConfig({ helpers: { "claude-code": { max_model: "sonnet" } } });
    writeHelperLimit("claude-code", {}, prefs);
    const report = build({ coordRoot: root });
    expect(report.source).toBe("user");
    expect(report.user).toEqual({});
    expect(report.limit).toBeNull();
    expect(report.summary).toBe("Helpers have no limit.");
  });
});

describe("summary wording", () => {
  test("model only, effort only, both, none", () => {
    expect(helperLimitSummary({ max_model: "sonnet" })).toBe("Helpers run on Sonnet or cheaper.");
    expect(helperLimitSummary({ max_effort: "medium" })).toBe(
      "Helpers run at Medium effort or lower.",
    );
    expect(helperLimitSummary({ max_model: "opus", max_effort: "medium" })).toBe(
      "Helpers run on Opus at Medium effort or cheaper.",
    );
    expect(helperLimitSummary(null)).toBe("Helpers have no limit.");
    expect(helperLimitSummary({})).toBe("Helpers have no limit.");
  });

  test("the report carries the summary of the limit in effect", () => {
    writeHelperLimit("claude-code", { max_effort: "high" }, prefs);
    expect(build().summary).toBe("Helpers run at High effort or lower.");
  });
});

describe("active state", () => {
  test("active plugin", () => {
    const report = build();
    expect(report.active).toBe(true);
    expect(report.inactive_reason).toBeNull();
  });

  test("inactive plugin carries its reason", () => {
    const report = build({
      pluginStatus: status(false, "Claude Code 2.1.300 is older than 2.1.309"),
    });
    expect(report.active).toBe(false);
    expect(report.inactive_reason).toBe("Claude Code 2.1.300 is older than 2.1.309");
  });

  test("a status reader that throws reads as inactive", () => {
    const report = build({
      pluginStatus: () => {
        throw new Error("boom");
      },
    });
    expect(report.active).toBe(false);
    expect(report.inactive_reason).toContain("boom");
  });

  test("coverage lists", () => {
    const report = build();
    expect(report.coverage.covered).toEqual([
      "Claude Code helpers, including helpers started by helpers and Workflow agents",
      "run workers on Claude Code",
    ]);
    expect(report.coverage.not_covered).toEqual([
      "forks",
      "agent-team teammates",
      "helpers in Codex, Cursor and OpenCode",
    ]);
  });
});

describe("last 24 hours", () => {
  test("counts this tool's helpers in the window, by family", () => {
    const line = (ts: string, extra: Record<string, unknown>) =>
      appendHelperUsage(
        { ts, tool: "claude-code", kind: "helper", lowered: false, ...extra },
        usage,
      );
    line("2026-11-11T10:00:00.000Z", { answered_model: "claude-opus-5-5", lowered: true });
    line("2026-11-11T11:00:00.000Z", { sent_model: "opus" });
    line("2026-11-10T20:00:00.000Z", { answered_model: "claude-haiku-5-5" });
    // Outside the window, and another tool.
    line("2026-11-10T12:00:00.000Z", { answered_model: "claude-opus-5-5" });
    appendHelperUsage(
      { ts: "2026-11-11T12:00:00.000Z", tool: "codex", kind: "helper", lowered: true },
      usage,
    );
    const report = build();
    expect(report.last_24h.since).toBe("2026-11-10T18:00:00.000Z");
    expect(report.last_24h.helpers).toBe(3);
    expect(report.last_24h.lowered).toBe(1);
    expect(report.last_24h.by_model).toEqual({ opus: 2, haiku: 1 });
  });

  test("an empty usage directory reads as zero", () => {
    expect(build().last_24h).toEqual({
      since: "2026-11-10T18:00:00.000Z",
      helpers: 0,
      lowered: 0,
      by_model: {},
    });
  });
});

describe("full-access floor warning", () => {
  const workerFullAccess = {
    enabled: true,
    floors: { "claude-code": [{ model: "opus", minEffort: "high" }] },
  };

  test("a limit below the floor warns", () => {
    writeHelperLimit("claude-code", { max_model: "sonnet" }, prefs);
    const report = build({ workerFullAccess });
    expect(report.warnings).toEqual([
      "The limit (Sonnet) is below the full-access floor for run workers on Claude Code (Opus at High effort), so those run workers will run sandboxed.",
    ]);
  });

  test("a limit at the floor does not warn", () => {
    writeHelperLimit("claude-code", { max_model: "opus", max_effort: "high" }, prefs);
    expect(build({ workerFullAccess }).warnings).toEqual([]);
  });

  test("no limit does not warn", () => {
    expect(build({ workerFullAccess }).warnings).toEqual([]);
  });

  test("a disabled policy does not warn", () => {
    writeHelperLimit("claude-code", { max_model: "haiku" }, prefs);
    expect(build({ workerFullAccess: { ...workerFullAccess, enabled: false } }).warnings).toEqual(
      [],
    );
  });

  test("the policy is read from the project config", () => {
    const root = projectConfig({ workflow: { workerFullAccess } });
    writeHelperLimit("claude-code", { max_effort: "medium" }, prefs);
    const report = build({ coordRoot: root });
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("Opus at High effort");
  });
});
