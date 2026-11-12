import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  compareClaudeVersions,
  ensureHelperPlugin,
  HELPER_PLUGIN_MIN_CLAUDE_VERSION,
  type HelperPluginOptions,
  helperPluginDir,
  helperPluginStatus,
  removeHelperPlugin,
} from "./helper-plugin.ts";

let root: string;
let savedCache: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "helper-plugin-"));
  savedCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(root, "cache");
});

afterEach(() => {
  if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedCache;
  rmSync(root, { recursive: true, force: true });
});

function options(files: string[], version: string | null = "2.1.310"): HelperPluginOptions {
  return { configHome: join(root, "config"), settingsFiles: files, claudeVersion: () => version };
}

function settingsFile(name: string, text?: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.json");
  if (text !== undefined) writeFileSync(file, text);
  return file;
}

function read(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8"));
}

describe("helperPluginDir", () => {
  test("lives under the config base", () => {
    expect(helperPluginDir({ configHome: "/c" })).toBe(join("/c", "harnery", "claude-code-plugin"));
  });
});

describe("ensureHelperPlugin", () => {
  test("copies the plugin, adds the settings entry, keeps every other key", () => {
    const original = `{\n    "model": "sonnet",\n    "env": { "FOO": "1" },\n    "hooks": { "Stop": [] }\n}\n`;
    const file = settingsFile("claude", original);
    const opts = options([file]);
    const result = ensureHelperPlugin(opts);
    const dir = helperPluginDir(opts);

    expect(result.changed).toBe(true);
    expect(existsSync(join(dir, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(dir, "hooks", "register.js"))).toBe(true);
    expect(existsSync(join(dir, "hooks", "generated", "harnery.js"))).toBe(true);
    expect(existsSync(join(root, "cache", "harnery", "helpers"))).toBe(true);
    const after = read(file);
    expect(after.model).toBe("sonnet");
    expect(after.hooks).toEqual({ Stop: [] });
    expect(after.env).toEqual({ FOO: "1", CLAUDE_CODE_PLUGIN_DIRS: dir });
    // Keeps the file's own indentation.
    expect(readFileSync(file, "utf8")).toContain('\n    "model"');
    expect(result.status.active).toBe(true);
    expect(result.status.reason).toBeNull();
    expect(result.status.settings_files).toEqual([file]);
  });

  test("is idempotent", () => {
    const file = settingsFile("claude", "{}\n");
    const opts = options([file]);
    ensureHelperPlugin(opts);
    const first = readFileSync(file, "utf8");
    const second = ensureHelperPlugin(opts);
    expect(second.changed).toBe(false);
    expect(second.notes).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(first);
  });

  test("never registers a temp-folder plugin in a settings file outside the temp folder", () => {
    const scratch = join(root, "scratch");
    const real = join(root, "real-home", ".claude");
    mkdirSync(real, { recursive: true });
    const file = join(real, "settings.json");
    const before = `${JSON.stringify({ model: "opus" }, null, 2)}\n`;
    writeFileSync(file, before);
    const result = ensureHelperPlugin({
      configHome: join(scratch, "config"),
      settingsFiles: [file],
      claudeVersion: () => "2.1.310",
      tempDir: scratch,
    });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(result.status.settings_files).toEqual([]);
    expect(result.notes.some((note) => note.includes("temporary"))).toBe(true);
  });

  test("keeps other path-list entries and adds its own once", () => {
    const other = join(root, "other-plugin");
    const file = settingsFile(
      "claude",
      JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: other } }),
    );
    const opts = options([file]);
    ensureHelperPlugin(opts);
    ensureHelperPlugin(opts);
    const env = read(file).env as Record<string, string>;
    expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBe([other, helperPluginDir(opts)].join(delimiter));
  });

  test("leaves a settings file that does not parse alone and says so", () => {
    const broken = '{ "model": "sonnet", // comment\n}';
    const file = settingsFile("claude", broken);
    const result = ensureHelperPlugin(options([file]));
    expect(readFileSync(file, "utf8")).toBe(broken);
    expect(result.notes.some((n) => n.includes(file) && n.includes("not a valid JSON"))).toBe(true);
    expect(result.status.active).toBe(false);
  });

  test("creates a missing settings file only when its folder exists", () => {
    const present = settingsFile("present");
    const absent = join(root, "absent", "settings.json");
    const opts = options([present, absent]);
    ensureHelperPlugin(opts);
    expect(read(present).env).toEqual({ CLAUDE_CODE_PLUGIN_DIRS: helperPluginDir(opts) });
    expect(existsSync(absent)).toBe(false);
  });

  test("keeps the file's mode", () => {
    const file = settingsFile("claude", "{}\n");
    chmodSync(file, 0o600);
    ensureHelperPlugin(options([file]));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("refreshes a copy whose stamp differs", () => {
    const file = settingsFile("claude", "{}\n");
    const opts = options([file]);
    ensureHelperPlugin(opts);
    const dir = helperPluginDir(opts);
    writeFileSync(join(dir, ".harnery-stamp"), "0.0.1+old\n");
    expect(helperPluginStatus(opts).reason).toContain("out of date");
    const result = ensureHelperPlugin(opts);
    expect(result.changed).toBe(true);
    expect(result.notes[0]).toContain("Updated");
    expect(result.status.active).toBe(true);
  });
});

describe("removeHelperPlugin", () => {
  test("restores an untouched settings file byte for byte", () => {
    const original = '{\n\t"model": "sonnet"\n}';
    const file = settingsFile("claude", original);
    const opts = options([file]);
    ensureHelperPlugin(opts);
    const result = removeHelperPlugin(opts);
    expect(result.changed).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(existsSync(helperPluginDir(opts))).toBe(false);
    expect(result.status.installed).toBe(false);
  });

  test("deletes a settings file it created", () => {
    const file = settingsFile("claude");
    const opts = options([file]);
    ensureHelperPlugin(opts);
    expect(existsSync(file)).toBe(true);
    removeHelperPlugin(opts);
    expect(existsSync(file)).toBe(false);
  });

  test("removes only its own entry when the file changed since install", () => {
    const other = join(root, "other-plugin");
    const file = settingsFile(
      "claude",
      JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: other } }),
    );
    const opts = options([file]);
    ensureHelperPlugin(opts);
    const changed = read(file);
    changed.theme = "dark";
    writeFileSync(file, JSON.stringify(changed, null, 2));
    removeHelperPlugin(opts);
    expect(read(file)).toEqual({ env: { CLAUDE_CODE_PLUGIN_DIRS: other }, theme: "dark" });
  });

  test("drops the variable and an env block it emptied", () => {
    const file = settingsFile("claude", "{}\n");
    const opts = options([file]);
    ensureHelperPlugin(opts);
    const changed = read(file);
    changed.theme = "dark";
    writeFileSync(file, JSON.stringify(changed, null, 2));
    removeHelperPlugin(opts);
    expect(read(file)).toEqual({ theme: "dark" });
  });

  test("is idempotent", () => {
    const file = settingsFile("claude", "{}\n");
    const opts = options([file]);
    ensureHelperPlugin(opts);
    removeHelperPlugin(opts);
    const again = removeHelperPlugin(opts);
    expect(again.changed).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("{}\n");
  });
});

describe("helperPluginStatus", () => {
  test("not installed", () => {
    const status = helperPluginStatus(options([settingsFile("claude", "{}")]));
    expect(status).toMatchObject({
      installed: false,
      active: false,
      reason: "the Harnery plugin for Claude Code is not installed",
      plugin_version: null,
      settings_files: [],
    });
  });

  test("folder present but no settings file loads it", () => {
    const file = settingsFile("claude", "{}\n");
    const opts = options([file]);
    ensureHelperPlugin(opts);
    writeFileSync(file, "{}\n");
    const status = helperPluginStatus(opts);
    expect(status.installed).toBe(false);
    expect(status.reason).toBe("no Claude Code settings file loads the Harnery plugin");
  });

  test("Claude Code too old", () => {
    const file = settingsFile("claude", "{}\n");
    ensureHelperPlugin(options([file]));
    const status = helperPluginStatus(options([file], "2.1.300"));
    expect(status.installed).toBe(true);
    expect(status.active).toBe(false);
    expect(status.reason).toBe(
      `Claude Code 2.1.300 is older than ${HELPER_PLUGIN_MIN_CLAUDE_VERSION}`,
    );
  });

  test("Claude Code version unreadable", () => {
    const file = settingsFile("claude", "{}\n");
    ensureHelperPlugin(options([file]));
    expect(helperPluginStatus(options([file], null)).reason).toBe(
      "the Claude Code version could not be read",
    );
  });

  test("reports the installed package version", () => {
    const file = settingsFile("claude", "{}\n");
    const status = ensureHelperPlugin(options([file])).status;
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"));
    expect(status.plugin_version).toBe(pkg.version);
  });

  test("never throws", () => {
    expect(() =>
      helperPluginStatus({ configHome: "\0bad", settingsFiles: ["\0bad"] }),
    ).not.toThrow();
  });
});

describe("compareClaudeVersions", () => {
  test("orders releases and ignores suffixes", () => {
    expect(compareClaudeVersions("2.1.310 (Claude Code)", "2.1.309")).toBe(1);
    expect(compareClaudeVersions("2.1.309", "2.1.309")).toBe(0);
    expect(compareClaudeVersions("2.1.99", "2.1.309")).toBe(-1);
    expect(compareClaudeVersions("2.10.0", "2.9.9")).toBe(1);
    expect(compareClaudeVersions("2.1.309-dev.20261101", "2.1.309")).toBe(0);
    expect(compareClaudeVersions("unknown", "2.1.309")).toBeNull();
  });
});
