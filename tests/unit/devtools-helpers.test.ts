import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { EmitContext } from "../../src/commander.ts";
import { registerDevtoolsCommand } from "../../src/commands/devtools.ts";
import type { HelperCommandDeps } from "../../src/commands/devtools-helpers.ts";
import type { HelperPluginChange, HelperPluginStatus } from "../../src/core/helper-plugin.ts";
import { appendHelperUsage } from "../../src/core/helper-usage.ts";
import { removeDir } from "../helpers/remove-dir.ts";

const NOW = new Date("2026-11-11T18:00:00.000Z");

let dir: string;
let prefs: string;
let usage: string;
let calls: string[];
let pluginActive: boolean;

interface Capture {
  emit: EmitContext;
  text: string[];
  data: unknown[];
  errors: { code: string; message: string }[];
  logs: string[];
}

function capture(): Capture {
  const out: Capture = {
    text: [],
    data: [],
    errors: [],
    logs: [],
    emit: {
      config() {},
      data: (value) => out.data.push(value),
      rows() {},
      text: (value) => out.text.push(value),
      file() {},
      error: (err) => out.errors.push(err as { code: string; message: string }),
      log: (msg) => out.logs.push(msg),
      setExitCode() {},
    },
  };
  return out;
}

function status(): HelperPluginStatus {
  return {
    installed: pluginActive,
    active: pluginActive,
    reason: pluginActive ? null : "the Harnery plugin is not installed",
    plugin_dir: path.join(dir, "plugin"),
    settings_files: [],
    claude_version: "2.1.310",
    plugin_version: null,
  };
}

function change(changed: boolean, notes: string[]): HelperPluginChange {
  return { changed, status: status(), notes };
}

function deps(extra: Partial<HelperCommandDeps> = {}): HelperCommandDeps {
  return {
    preferencesPath: prefs,
    usageDir: usage,
    coordRoot: null,
    now: () => NOW,
    pluginStatus: status,
    ensurePlugin: () => {
      calls.push("ensure");
      const was = pluginActive;
      pluginActive = true;
      return change(!was, was ? [] : ["Added the plugin to settings.json."]);
    },
    removePlugin: () => {
      calls.push("remove");
      pluginActive = false;
      return change(true, ["Removed the plugin from settings.json."]);
    },
    ...extra,
  };
}

async function run(args: string[], extra: Partial<HelperCommandDeps> = {}): Promise<Capture> {
  const out = capture();
  const program = new Command("harn");
  program.exitOverride();
  registerDevtoolsCommand(program, out.emit, deps(extra));
  await program.parseAsync(["devtools", "helpers", ...args], { from: "user" });
  return out;
}

function stored(): unknown {
  try {
    return JSON.parse(readFileSync(prefs, "utf8")).helpers?.["claude-code"];
  } catch {
    return undefined;
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "devtools-helpers-"));
  prefs = path.join(dir, "preferences.json");
  usage = path.join(dir, "usage");
  calls = [];
  pluginActive = false;
});
afterEach(() => removeDir(dir));

describe("devtools helpers", () => {
  test("show with nothing set", async () => {
    const out = await run([]);
    expect(out.errors).toEqual([]);
    expect(calls).toEqual([]);
    expect(out.text.join("\n")).toBe(
      [
        "Helpers have no limit.",
        "No limit is set. Set one with `harn devtools helpers <model> <effort>`, for example `harn devtools helpers opus medium`.",
        "Not active: the Harnery plugin is not installed.",
        "Covered: Claude Code helpers, including helpers started by helpers and Workflow agents; run workers on Claude Code.",
        "Not covered: forks; agent-team teammates; helpers in Codex, Cursor and OpenCode.",
        "No helpers in the last 24 hours.",
      ].join("\n"),
    );
  });

  test("set model and effort, in either order", async () => {
    for (const words of [
      ["opus", "medium"],
      ["medium", "opus"],
    ]) {
      pluginActive = false;
      const out = await run(words);
      expect(out.errors).toEqual([]);
      expect(stored()).toEqual({ max_model: "opus", max_effort: "medium" });
      const text = out.text.join("\n");
      expect(
        text.startsWith(
          "Helpers now run on Opus at Medium effort or cheaper, in all your projects.",
        ),
      ).toBe(true);
      expect(text).toContain("Added the plugin to settings.json.");
      expect(text).toContain("need a restart to pick up the plugin");
      expect(text).toContain("This is your own choice, for all your projects.");
      expect(text).toContain("Active in Claude Code 2.1.310.");
    }
    expect(calls).toEqual(["ensure", "ensure"]);
  });

  test("model only replaces the whole pair", async () => {
    await run(["opus", "high"]);
    const out = await run(["sonnet"]);
    expect(stored()).toEqual({ max_model: "sonnet" });
    expect(out.text.join("\n")).toContain("Helpers now run on Sonnet or cheaper");
    expect(out.text.join("\n")).not.toContain("need a restart");
  });

  test("effort only", async () => {
    const out = await run(["medium"]);
    expect(stored()).toEqual({ max_effort: "medium" });
    expect(out.text.join("\n")).toContain("Helpers now run at Medium effort or lower");
  });

  test("none stores {} and installs nothing", async () => {
    const out = await run(["none"]);
    expect(stored()).toEqual({});
    expect(calls).toEqual([]);
    expect(out.text.join("\n")).toContain("You chose no limit, for all your projects.");
  });

  test("--clear removes the choice and installs nothing", async () => {
    await run(["opus"]);
    calls = [];
    const out = await run(["--clear"]);
    expect(stored()).toBeUndefined();
    expect(calls).toEqual([]);
    expect(out.text.join("\n")).toContain("Your own helper limit is removed");
    expect(out.text.join("\n")).toContain("Helpers have no limit.");
  });

  test("an unknown word is an error and saves nothing", async () => {
    const out = await run(["gpt"]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]?.code).toBe("bad_helper_limit");
    expect(out.errors[0]?.message).toContain('"gpt" is not a model or an effort');
    expect(stored()).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("words with a flag, or two flags, is a usage error", async () => {
    for (const args of [
      ["opus", "--clear"],
      ["sonnet", "--install"],
      ["--install", "--uninstall"],
    ]) {
      const out = await run(args);
      expect(out.errors[0]?.code).toBe("usage");
      expect(out.text).toEqual([]);
    }
    expect(stored()).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("--install and --uninstall", async () => {
    let out = await run(["--install"]);
    expect(calls).toEqual(["ensure"]);
    expect(out.text.join("\n")).toContain("Added the plugin to settings.json.");
    expect(out.text.join("\n")).toContain("Active in Claude Code 2.1.310.");
    out = await run(["--uninstall"]);
    expect(calls).toEqual(["ensure", "remove"]);
    expect(out.text.join("\n")).toContain("Removed the plugin from settings.json.");
    expect(out.text.join("\n")).toContain("Not active:");
    expect(stored()).toBeUndefined();
  });

  test("--format json prints the report object", async () => {
    appendHelperUsage(
      {
        ts: "2026-11-11T12:00:00.000Z",
        tool: "claude-code",
        kind: "helper",
        answered_model: "claude-opus-5-5",
        lowered: true,
      },
      usage,
    );
    const out = await run(["opus", "medium", "--format", "json"]);
    expect(out.text).toEqual([]);
    expect(out.data).toHaveLength(1);
    const report = out.data[0] as Record<string, unknown>;
    expect(Object.keys(report).sort()).toEqual(
      [
        "active",
        "coverage",
        "inactive_reason",
        "last_24h",
        "ladders",
        "limit",
        "project_default",
        "source",
        "summary",
        "tool",
        "user",
        "warnings",
      ].sort(),
    );
    expect(report.limit).toEqual({ max_model: "opus", max_effort: "medium" });
    expect(report.source).toBe("user");
    expect(report.active).toBe(true);
    expect(report.last_24h).toEqual({
      since: "2026-11-10T18:00:00.000Z",
      helpers: 1,
      lowered: 1,
      by_model: { opus: 1 },
    });
  });

  test("a plugin failure after a save keeps the limit and reports an error", async () => {
    const out = await run(["sonnet", "low"], {
      ensurePlugin: () => {
        throw new Error("not implemented yet");
      },
    });
    expect(stored()).toEqual({ max_model: "sonnet", max_effort: "low" });
    expect(out.errors).toEqual([
      {
        code: "helper_plugin_failed",
        message:
          "The limit is saved, but Harnery could not install its Claude Code plugin: not implemented yet",
      },
    ]);
    expect(out.text.join("\n")).toContain("Helpers now run on Sonnet at Low effort or cheaper");
  });

  test("a project default and the floor warning show", async () => {
    const root = path.join(dir, "project");
    mkdirSync(path.join(root, ".harnery"), { recursive: true });
    writeFileSync(
      path.join(root, ".harnery", "config.jsonc"),
      JSON.stringify({
        helpers: { "claude-code": { max_model: "sonnet" } },
        workflow: {
          workerFullAccess: {
            enabled: true,
            floors: { "claude-code": [{ model: "opus", minEffort: "high" }] },
          },
        },
      }),
    );
    const out = await run([], { coordRoot: root });
    const text = out.text.join("\n");
    expect(text).toContain("Helpers run on Sonnet or cheaper.");
    expect(text).toContain("This is the project's default from .harnery/config.jsonc.");
    expect(text).toContain("Warning: The limit (Sonnet) is below the full-access floor");
  });
});
