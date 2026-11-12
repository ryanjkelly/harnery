import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { addPathListEntry } from "./settings-text-edit.ts";

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

  // File modes are a POSIX notion; Windows reports its own fixed bits.
  test.skipIf(process.platform === "win32")("keeps the file's mode", () => {
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
  test("removes every copy of the plugin path, not only the last one", () => {
    const opts = options([]);
    const dir = helperPluginDir(opts);
    const list = [dir, "/opt/other", dir].join(delimiter);
    const file = settingsFile(
      "claude",
      `${JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: list }, model: "sonnet" }, null, 2)}\n`,
    );
    removeHelperPlugin({ ...opts, settingsFiles: [file] });
    const after = read(file) as { env: Record<string, string>; model: string };
    expect(after.env.CLAUDE_CODE_PLUGIN_DIRS).toBe("/opt/other");
    expect(after.model).toBe("sonnet");
  });

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

  test("an unreadable Claude Code version still counts as active", () => {
    const file = settingsFile("claude", "{}\n");
    ensureHelperPlugin(options([file]));
    const status = helperPluginStatus(options([file], null));
    expect(status).toMatchObject({ installed: true, active: true, reason: null });
    expect(status.claude_version).toBeNull();
    const garbled = helperPluginStatus(options([file], "unknown"));
    expect(garbled).toMatchObject({ active: true, reason: null, claude_version: null });
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

describe("text-preserving settings edits", () => {
  const otherPlugin = "/opt/other-plugin";
  const styles: Record<string, string> = {
    "two spaces": '{\n  "model": "sonnet",\n  "hooks": {\n    "Stop": []\n  }\n}\n',
    "four spaces": '{\n    "model": "sonnet",\n    "hooks": { "Stop": [] }\n}\n',
    tabs: '{\n\t"model": "sonnet",\n\t"permissions": {\n\t\t"allow": ["Read"]\n\t}\n}',
    "compact one line": '{"model":"sonnet","hooks":{"Stop":[]}}',
    "spaced one line": '{ "model": "sonnet" }\n',
    crlf: '{\r\n  "model": "sonnet",\r\n  "theme": "dark"\r\n}\r\n',
    "empty object": "{}\n",
    "empty object, no newline": "{}",
  };
  const withEnv: Record<string, string> = {
    "env, two spaces": '{\n  "env": {\n    "FOO": "1"\n  },\n  "model": "sonnet"\n}\n',
    "env, tabs": '{\n\t"env": {\n\t\t"FOO": "1"\n\t}\n}',
    "env, compact": '{"env":{"FOO":"1"},"model":"sonnet"}',
    "env, crlf": '{\r\n    "env": {\r\n        "FOO": "1"\r\n    }\r\n}\r\n',
    "env, empty": '{\n  "env": {},\n  "model": "sonnet"\n}\n',
    "env, other plugin dirs": `{\n  "env": {\n    "CLAUDE_CODE_PLUGIN_DIRS": "${otherPlugin}",\n    "FOO": "1"\n  }\n}\n`,
    "env, other plugin dirs, compact": `{"env":{"CLAUDE_CODE_PLUGIN_DIRS":"${otherPlugin}"}}`,
    "env, empty plugin dirs": '{\n  "env": {\n    "CLAUDE_CODE_PLUGIN_DIRS": ""\n  }\n}\n',
  };

  for (const [name, original] of Object.entries({ ...styles, ...withEnv })) {
    test(`install then remove returns the file byte for byte: ${name}`, () => {
      const file = settingsFile("claude", original);
      const opts = options([file]);
      const before = JSON.parse(original);
      ensureHelperPlugin(opts);
      const installed = readFileSync(file, "utf8");
      const after = JSON.parse(installed);
      // Only the one entry changed.
      const env = { ...(after.env as Record<string, unknown>) };
      const dirs = String(env.CLAUDE_CODE_PLUGIN_DIRS).split(delimiter);
      expect(dirs.at(-1)).toBe(helperPluginDir(opts));
      const priorDirs = before.env?.CLAUDE_CODE_PLUGIN_DIRS;
      if (priorDirs) expect(dirs.slice(0, -1).join(delimiter)).toBe(priorDirs);
      delete env.CLAUDE_CODE_PLUGIN_DIRS;
      const priorEnv = { ...(before.env ?? {}) };
      delete priorEnv.CLAUDE_CODE_PLUGIN_DIRS;
      expect(env).toEqual(priorEnv);
      const { env: _a, ...restAfter } = after;
      const { env: _b, ...restBefore } = before;
      expect(restAfter).toEqual(restBefore);
      // Line endings are kept.
      if (original.includes("\r\n")) expect(installed.replace(/\r\n/g, "")).not.toContain("\n");
      removeHelperPlugin(opts);
      expect(readFileSync(file, "utf8")).toBe(original);
    });
  }

  test("keeps the layout of the members it adds to", () => {
    const file = settingsFile("claude", '{\n\t"model": "sonnet"\n}\n');
    const opts = options([file]);
    ensureHelperPlugin(opts);
    const dir = JSON.stringify(helperPluginDir(opts));
    expect(readFileSync(file, "utf8")).toBe(
      `{\n\t"model": "sonnet",\n\t"env": {\n\t\t"CLAUDE_CODE_PLUGIN_DIRS": ${dir}\n\t}\n}\n`,
    );
  });

  test("a change made after install is kept; only the plugin entry goes", () => {
    const original = '{\n  "env": {\n    "FOO": "1"\n  },\n  "model": "sonnet"\n}\n';
    const file = settingsFile("claude", original);
    const opts = options([file]);
    ensureHelperPlugin(opts);
    const edited = readFileSync(file, "utf8").replace('"model": "sonnet"', '"model": "opus"');
    writeFileSync(file, edited);
    removeHelperPlugin(opts);
    expect(readFileSync(file, "utf8")).toBe(original.replace('"sonnet"', '"opus"'));
  });

  test("a path added after ours keeps its place when ours is removed", () => {
    const file = settingsFile("claude", "{}\n");
    const opts = options([file]);
    ensureHelperPlugin(opts);
    const dir = helperPluginDir(opts);
    const text = readFileSync(file, "utf8").replace(
      JSON.stringify(dir),
      JSON.stringify([dir, otherPlugin].join(delimiter)),
    );
    writeFileSync(file, text);
    removeHelperPlugin(opts);
    expect(read(file)).toEqual({ env: { CLAUDE_CODE_PLUGIN_DIRS: otherPlugin } });
  });

  test("a settings file it created stays when something else was added to it", () => {
    const file = settingsFile("claude");
    const opts = options([file]);
    ensureHelperPlugin(opts);
    const value = read(file);
    value.theme = "dark";
    writeFileSync(file, JSON.stringify(value, null, 2));
    removeHelperPlugin(opts);
    expect(read(file)).toEqual({ theme: "dark" });
  });

  test("refuses an edit the scanner would misplace and leaves the file untouched", () => {
    // Duplicate keys: JSON.parse keeps the last `env`, the scanner edits the first.
    const tricky = '{"env":{"A":"1"},"env":{"B":"2"}}';
    const result = addPathListEntry(tricky, "/x", {
      name: "CLAUDE_CODE_PLUGIN_DIRS",
      delimiter: ":",
    });
    expect(result.ok).toBe(false);

    const file = settingsFile("claude", tricky);
    const opts = options([file]);
    const change = ensureHelperPlugin(opts);
    expect(readFileSync(file, "utf8")).toBe(tricky);
    expect(change.notes.some((n) => n.includes(file) && n.startsWith("Left"))).toBe(true);
    expect(change.status.settings_files).toEqual([]);
  });

  test("refuses duplicate plugin entries and leaves the file untouched", () => {
    const tricky = '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":"/a","CLAUDE_CODE_PLUGIN_DIRS":"/b"}}';
    const file = settingsFile("claude", tricky);
    ensureHelperPlugin(options([file]));
    expect(readFileSync(file, "utf8")).toBe(tricky);
  });

  test("leaves env alone when it is not an object", () => {
    const original = '{"env":"oops"}';
    const file = settingsFile("claude", original);
    const change = ensureHelperPlugin(options([file]));
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(change.notes.some((n) => n.includes("env setting is not an object"))).toBe(true);
  });

  test("the install record holds no settings content and is owner-only", () => {
    const secret = "sk-test-0123456789abcdef-secret";
    const original = `{\n  "env": {\n    "API_TOKEN": "${secret}"\n  },\n  "model": "sonnet"\n}\n`;
    const file = settingsFile("claude", original);
    const created = join(root, "fresh", "settings.json");
    mkdirSync(join(root, "fresh"), { recursive: true });
    const opts = options([file, created]);
    ensureHelperPlugin(opts);
    const recordPath = join(root, "config", "harnery", "claude-code-plugin.install.json");
    const recordText = readFileSync(recordPath, "utf8");
    expect(recordText).not.toContain(secret);
    expect(recordText).not.toContain("sonnet");
    expect(recordText).not.toContain("API_TOKEN");
    expect(JSON.parse(recordText)).toEqual({
      files: {
        [file]: { created_file: false, created_env: false, created_entry: true },
        [created]: { created_file: true, created_env: true, created_entry: true },
      },
    });
    if (process.platform !== "win32") expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    // A settings file the install created is owner-only too.
    if (process.platform !== "win32") expect(statSync(created).mode & 0o777).toBe(0o600);
    // No temp files are left beside either.
    for (const dir of [
      join(root, "config", "harnery"),
      join(root, "claude"),
      join(root, "fresh"),
    ]) {
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    }
    removeHelperPlugin(opts);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(existsSync(created)).toBe(false);
    expect(existsSync(recordPath)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "files it creates stay owner-only, even with a permissive umask",
    () => {
      const file = settingsFile("claude", "{}\n");
      chmodSync(file, 0o644);
      const created = join(root, "fresh", "settings.json");
      mkdirSync(join(root, "fresh"), { recursive: true });
      const umask = process.umask(0);
      try {
        ensureHelperPlugin(options([file, created]));
      } finally {
        process.umask(umask);
      }
      const recordPath = join(root, "config", "harnery", "claude-code-plugin.install.json");
      expect(statSync(recordPath).mode & 0o777).toBe(0o600);
      expect(statSync(created).mode & 0o777).toBe(0o600);
      // An existing settings file keeps its own mode.
      expect(statSync(file).mode & 0o777).toBe(0o644);
      // No temp file is left beside any of them.
      for (const dir of [
        join(root, "claude"),
        join(root, "fresh"),
        join(root, "config", "harnery"),
      ]) {
        expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      }
    },
  );
});
