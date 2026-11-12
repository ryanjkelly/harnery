/**
 * Install state of the Claude Code plugin that applies the helper limit to
 * each helper's model request.
 *
 * The plugin is a personal, machine-wide thing, like the limit itself: it is
 * copied to one stable folder under the user config directory and loaded by
 * Claude Code through `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of each
 * Claude Code user settings file. Project settings cannot load a plugin this
 * way, and a path into one project's checkout would break when it moves.
 *
 * Signatures below are the contract between the plugin, the command and the
 * dashboard; the bodies are filled in by the plugin work.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { helperUsageDir } from "./helper-usage.ts";

/** First Claude Code release whose model-request hook accepts a family name. */
export const HELPER_PLUGIN_MIN_CLAUDE_VERSION = "2.1.309";

export interface HelperPluginStatus {
  /** The plugin folder exists and at least one settings file loads it. */
  installed: boolean;
  /** Installed, current, and the local Claude Code is new enough. */
  active: boolean;
  /** Plain-words reason when `active` is false; null when active. */
  reason: string | null;
  /** The stable folder the plugin is copied to. */
  plugin_dir: string;
  /** Claude Code user settings files that load the plugin. */
  settings_files: string[];
  /** Local Claude Code version, or null when it could not be read. */
  claude_version: string | null;
  /** Version of this package the installed copy was built from, if installed. */
  plugin_version: string | null;
}

export interface HelperPluginChange {
  /** True when a file was written or removed. */
  changed: boolean;
  status: HelperPluginStatus;
  /** Plain sentences for the person, such as which settings file changed. */
  notes: string[];
}

export interface HelperPluginOptions {
  /** Override the user config base (tests). */
  configHome?: string;
  /** Override the Claude Code user settings files to manage (tests). */
  settingsFiles?: string[];
  /** Override how the local Claude Code version is read (tests). */
  claudeVersion?: () => string | null;
  /** Override what counts as the OS temp directory (tests). */
  tempDir?: string;
}

const PLUGIN_ENV = "CLAUDE_CODE_PLUGIN_DIRS";
/** File inside the installed folder holding `<package version>+<content hash>`. */
const STAMP_FILE = ".harnery-stamp";
/** The parts of the source plugin folder that are installed. */
const PLUGIN_PARTS = [".claude-plugin/plugin.json", "hooks"];

function configBase(options: HelperPluginOptions): string {
  if (options.configHome?.trim()) return options.configHome;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg?.trim() ? xdg : join(homedir(), ".config");
}

/** `~/.config/harnery/claude-code-plugin` (honors `XDG_CONFIG_HOME`). */
export function helperPluginDir(options: HelperPluginOptions = {}): string {
  return join(configBase(options), "harnery", "claude-code-plugin");
}

/** Records what each settings file held before the first install changed it. */
function installRecordPath(options: HelperPluginOptions): string {
  return join(configBase(options), "harnery", "claude-code-plugin.install.json");
}

/** The Claude Code user settings files to manage, without duplicates. */
function managedSettingsFiles(options: HelperPluginOptions): string[] {
  if (options.settingsFiles) return [...new Set(options.settingsFiles.map((f) => resolve(f)))];
  const files: string[] = [];
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir?.trim()) files.push(join(configDir, "settings.json"));
  files.push(join(homedir(), ".claude", "settings.json"));
  return [...new Set(files.map((f) => resolve(f)))];
}

function packageRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg?.name === "harnery") return dir;
    } catch {
      // Not here; keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function packageVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (typeof pkg?.version === "string") return pkg.version;
  } catch {
    // Unreadable metadata.
  }
  return "0.0.0";
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path, base));
    else if (entry.isFile()) out.push(path.slice(base.length + 1));
  }
  return out.sort();
}

/** The source plugin folder in this package and the stamp its copy carries. */
function pluginSource(): { dir: string; stamp: string } | null {
  const root = packageRoot();
  if (!root) return null;
  const dir = join(root, "claude-code-plugin");
  if (!existsSync(join(dir, ".claude-plugin", "plugin.json"))) return null;
  const hash = createHash("sha256");
  for (const part of PLUGIN_PARTS) {
    const path = join(dir, part);
    if (!existsSync(path)) return null;
    const files = statSync(path).isDirectory() ? listFiles(path).map((f) => join(part, f)) : [part];
    for (const file of files) {
      hash.update(file);
      hash.update("\0");
      hash.update(readFileSync(join(dir, file)));
      hash.update("\0");
    }
  }
  return { dir, stamp: `${packageVersion(root)}+${hash.digest("hex").slice(0, 16)}` };
}

function readStamp(dir: string): string | null {
  try {
    const text = readFileSync(join(dir, STAMP_FILE), "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Parse `x.y.z` from a version string, such as `2.1.310 (Claude Code)`. */
function releaseOf(version: string | null | undefined): number[] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** -1, 0 or 1; null when either side has no `x.y.z`. */
export function compareClaudeVersions(a: string, b: string): number | null {
  const pa = releaseOf(a);
  const pb = releaseOf(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function localClaudeVersion(): string | null {
  try {
    const result = spawnSync("claude", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) return null;
    const release = releaseOf(result.stdout);
    return release ? release.join(".") : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type SettingsRead =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "ok"; text: string; value: Record<string, unknown> };

function readSettings(file: string): SettingsRead {
  if (!existsSync(file)) return { kind: "missing" };
  try {
    const text = readFileSync(file, "utf8");
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? { kind: "ok", text, value } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function samePath(a: string, b: string): boolean {
  const strip = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);
  return strip(a) === strip(b);
}

function pathList(value: unknown): string[] {
  return typeof value === "string" ? value.split(delimiter).filter((p) => p.trim()) : [];
}

function loadsPlugin(settings: Record<string, unknown>, dir: string): boolean {
  const env = settings.env;
  if (!isPlainObject(env)) return false;
  return pathList(env[PLUGIN_ENV]).some((p) => samePath(p, dir));
}

/** Serialize in the file's own indentation, keeping its final newline. */
function serialize(value: Record<string, unknown>, original: string | null): string {
  const indent = original ? (/^[{[]\s*\n([ \t]+)\S/.exec(original)?.[1] ?? "  ") : "  ";
  const newline = original === null || original.endsWith("\n") ? "\n" : "";
  return JSON.stringify(value, null, indent) + newline;
}

/** Write through a temp file and rename, keeping the file's mode. */
function writeAtomic(file: string, text: string): void {
  let mode: number | undefined;
  try {
    mode = statSync(file).mode & 0o7777;
  } catch {
    mode = undefined;
  }
  const temp = `${file}.harnery-${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(temp, text, mode === undefined ? undefined : { mode });
    if (mode !== undefined) chmodSync(temp, mode);
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

interface InstallRecord {
  files: Record<string, { original: string | null; written: string }>;
}

function readInstallRecord(options: HelperPluginOptions): InstallRecord {
  try {
    const value: unknown = JSON.parse(readFileSync(installRecordPath(options), "utf8"));
    if (isPlainObject(value) && isPlainObject(value.files)) {
      const files: InstallRecord["files"] = {};
      for (const [file, entry] of Object.entries(value.files)) {
        if (!isPlainObject(entry) || typeof entry.written !== "string") continue;
        const original = typeof entry.original === "string" ? entry.original : null;
        files[file] = { original, written: entry.written };
      }
      return { files };
    }
  } catch {
    // Missing or unreadable: no record.
  }
  return { files: {} };
}

function writeInstallRecord(options: HelperPluginOptions, record: InstallRecord): void {
  const path = installRecordPath(options);
  if (Object.keys(record.files).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
}

/** Read-only: is the plugin installed, current and usable. Never throws. */
export function helperPluginStatus(options: HelperPluginOptions = {}): HelperPluginStatus {
  const pluginDir = helperPluginDir(options);
  const status: HelperPluginStatus = {
    installed: false,
    active: false,
    reason: null,
    plugin_dir: pluginDir,
    settings_files: [],
    claude_version: null,
    plugin_version: null,
  };
  try {
    const stamp = readStamp(pluginDir);
    status.plugin_version = stamp ? (stamp.split("+")[0] ?? null) : null;
    for (const file of managedSettingsFiles(options)) {
      const read = readSettings(file);
      if (read.kind === "ok" && loadsPlugin(read.value, pluginDir))
        status.settings_files.push(file);
    }
    status.installed = stamp !== null && status.settings_files.length > 0;
    status.claude_version = options.claudeVersion ? options.claudeVersion() : localClaudeVersion();

    if (stamp === null) {
      status.reason = "the Harnery plugin for Claude Code is not installed";
    } else if (status.settings_files.length === 0) {
      status.reason = "no Claude Code settings file loads the Harnery plugin";
    } else if (stamp !== pluginSource()?.stamp) {
      status.reason = "the installed Harnery plugin for Claude Code is out of date";
    } else if (status.claude_version === null) {
      status.reason = "the Claude Code version could not be read";
    } else {
      const cmp = compareClaudeVersions(status.claude_version, HELPER_PLUGIN_MIN_CLAUDE_VERSION);
      if (cmp === null) status.reason = "the Claude Code version could not be read";
      else if (cmp < 0) {
        status.reason = `Claude Code ${status.claude_version} is older than ${HELPER_PLUGIN_MIN_CLAUDE_VERSION}`;
      }
    }
    status.active = status.reason === null;
  } catch (err) {
    status.active = false;
    status.reason = `the plugin state could not be read (${err instanceof Error ? err.message : String(err)})`;
  }
  return status;
}

function copyPlugin(sourceDir: string, targetDir: string, stamp: string): void {
  const staging = `${targetDir}.harnery-${process.pid}-${Date.now()}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  try {
    for (const part of PLUGIN_PARTS) {
      const to = join(staging, part);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(join(sourceDir, part), to, { recursive: true });
    }
    writeFileSync(join(staging, STAMP_FILE), `${stamp}\n`);
    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(dirname(targetDir), { recursive: true });
    renameSync(staging, targetDir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

function isInside(path: string, dir: string): boolean {
  const base = resolve(dir);
  const target = resolve(path);
  return target === base || target.startsWith(`${base}/`) || target.startsWith(`${base}\\`);
}

/**
 * A plugin folder under the OS temp directory belongs to a test or a scratch
 * run. Registering it in a settings file outside that directory would leave a
 * person's real settings pointing at a folder that is about to disappear, so
 * that combination is refused.
 */
function isScratchPluginInRealSettings(
  pluginDir: string,
  settingsFile: string,
  options: HelperPluginOptions,
): boolean {
  const temp = options.tempDir ?? tmpdir();
  return isInside(pluginDir, temp) && !isInside(settingsFile, temp);
}

/**
 * Install the plugin, or refresh a copy from an older version. Idempotent.
 * Changes only the plugin folder and the one `CLAUDE_CODE_PLUGIN_DIRS` entry in
 * each settings file's `env` block; every other setting is kept as it was.
 */
export function ensureHelperPlugin(options: HelperPluginOptions = {}): HelperPluginChange {
  const notes: string[] = [];
  let changed = false;
  const pluginDir = helperPluginDir(options);
  const source = pluginSource();
  if (!source) {
    notes.push("The Claude Code plugin files are missing from this Harnery install.");
    return { changed, status: helperPluginStatus(options), notes };
  }

  const current = readStamp(pluginDir);
  if (current !== source.stamp) {
    copyPlugin(source.dir, pluginDir, source.stamp);
    changed = true;
    notes.push(
      current === null
        ? `Installed the Harnery plugin for Claude Code in ${pluginDir}.`
        : `Updated the Harnery plugin for Claude Code in ${pluginDir}.`,
    );
  }

  try {
    mkdirSync(helperUsageDir(), { recursive: true });
  } catch {
    // The plugin's writes create it too; this is a convenience.
  }

  const record = readInstallRecord(options);
  let recordChanged = false;
  for (const file of managedSettingsFiles(options)) {
    const read = readSettings(file);
    if (read.kind === "invalid") {
      notes.push(`Left ${file} alone: it is not a valid JSON settings object.`);
      continue;
    }
    if (read.kind === "missing" && !existsSync(dirname(file))) continue;
    const original = read.kind === "ok" ? read.text : null;
    const value = read.kind === "ok" ? read.value : {};
    if (loadsPlugin(value, pluginDir)) continue;
    if (isScratchPluginInRealSettings(pluginDir, file, options)) {
      notes.push(`Left ${file} alone: the plugin folder ${pluginDir} is a temporary one.`);
      continue;
    }

    const env = isPlainObject(value.env) ? { ...value.env } : {};
    const entries = pathList(env[PLUGIN_ENV]);
    env[PLUGIN_ENV] = [...entries, pluginDir].join(delimiter);
    const next = { ...value, env };
    const text = serialize(next, original);
    writeAtomic(file, text);
    changed = true;
    const prior = record.files[file];
    record.files[file] = { original: prior ? prior.original : original, written: text };
    recordChanged = true;
    notes.push(`Claude Code now loads the Harnery plugin through ${file}.`);
  }
  if (recordChanged) writeInstallRecord(options, record);

  return { changed, status: helperPluginStatus(options), notes };
}

/** Remove the plugin folder and its settings entries. Idempotent. */
export function removeHelperPlugin(options: HelperPluginOptions = {}): HelperPluginChange {
  const notes: string[] = [];
  let changed = false;
  const pluginDir = helperPluginDir(options);
  const record = readInstallRecord(options);
  const files = new Set([...managedSettingsFiles(options), ...Object.keys(record.files)]);

  for (const file of files) {
    const read = readSettings(file);
    const entry = record.files[file];
    if (read.kind === "invalid") {
      notes.push(`Left ${file} alone: it is not a valid JSON settings object.`);
      continue;
    }
    if (read.kind === "missing") {
      delete record.files[file];
      continue;
    }
    if (!loadsPlugin(read.value, pluginDir)) {
      delete record.files[file];
      continue;
    }
    if (entry && entry.written === read.text) {
      // Nothing else changed since the install: put the file back exactly.
      if (entry.original === null) unlinkSync(file);
      else writeAtomic(file, entry.original);
    } else {
      const env = { ...(read.value.env as Record<string, unknown>) };
      const kept = pathList(env[PLUGIN_ENV]).filter((p) => !samePath(p, pluginDir));
      if (kept.length > 0) env[PLUGIN_ENV] = kept.join(delimiter);
      else delete env[PLUGIN_ENV];
      const next: Record<string, unknown> = { ...read.value, env };
      if (Object.keys(env).length === 0) delete next.env;
      writeAtomic(file, serialize(next, read.text));
    }
    delete record.files[file];
    changed = true;
    notes.push(`Claude Code no longer loads the Harnery plugin through ${file}.`);
  }
  writeInstallRecord(options, record);

  if (existsSync(pluginDir)) {
    rmSync(pluginDir, { recursive: true, force: true });
    changed = true;
    notes.push(`Removed the Harnery plugin folder ${pluginDir}.`);
  }
  return { changed, status: helperPluginStatus(options), notes };
}
