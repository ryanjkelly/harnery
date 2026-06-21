/**
 * `harn init`: idempotently wire harnery into a project.
 *
 * Two things a fresh consumer otherwise has to know to do by hand (both silent
 * if skipped):
 *   1. Create the `.harnery/` coord root; without it `findCoordRoot` returns
 *      null and every hook no-ops forever.
 *   2. Register the agent-hook entries in the harness settings file.
 *
 * Wires whichever harness `--harness` names (Claude Code `.claude/settings.json`,
 * Cursor `.cursor/hooks.json`, or Codex `.codex/hooks.json`): the per-harness
 * file path, event list, and hook-entry shape all come from HARNESS_SPECS.
 *
 * `harn init` does both, non-destructively: it merges hook entries into an
 * existing settings file (preserving any other hooks) and skips entries that are
 * already wired, so it's safe to re-run. `--dry-run` previews without writing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { DEFAULT_BIN_NAME, stripJsonComments } from "../core/config.ts";
import {
  HARNESS_SPECS,
  type HarnessId,
  type HarnessSpec,
  type HookEntryShape,
} from "../core/hooks/harness/events.ts";

// This file is src/commands/init.ts → harnery package root is two levels up.
const HARNERY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface InitOpts {
  harness: string;
  dryRun?: boolean;
  projectRoot?: string;
}

/** Claude Code + Codex entry: `{ hooks: [{ type, command }] }`. */
interface ClaudeHookGroup {
  matcher?: string;
  hooks: { type: string; command: string }[];
}
/** Cursor entry: a flat `{ command }`. */
interface CursorHookGroup {
  command: string;
  type?: string;
  matcher?: string;
}
type HookGroup = ClaudeHookGroup | CursorHookGroup;

export interface SettingsFile {
  version?: number;
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

export function registerInitCommand(program: Command, emit: EmitContext, binName?: string): void {
  program
    .command("init")
    .description(
      "Bootstrap harnery in this project: create .harnery/ and wire the harness " +
        "hooks (idempotent; safe to re-run). Use --dry-run to preview.",
    )
    .option("--harness <id>", "claude-code | cursor | codex", "claude-code")
    .option("--dry-run", "Show what would change without writing")
    .option("--project-root <path>", "Project root (default: git toplevel, else cwd)")
    .action((opts: InitOpts) => {
      const harness = opts.harness as HarnessId;
      const spec = HARNESS_SPECS[harness];
      if (!spec) {
        emit.text(`Unknown harness '${opts.harness}'. Expected: claude-code | cursor | codex.`);
        emit.setExitCode(1);
        return;
      }

      const projectRoot = resolve(opts.projectRoot ?? gitTopLevel() ?? process.cwd());
      const dryRun = opts.dryRun === true;
      const actions: string[] = [];

      // ── 1. coord root ──────────────────────────────────────────────────────
      const coordDir = resolve(projectRoot, ".harnery");
      if (existsSync(coordDir)) {
        actions.push("· .harnery/ already exists");
      } else if (dryRun) {
        actions.push("+ would create .harnery/ (+ .harnery/.gitignore)");
      } else {
        mkdirSync(coordDir, { recursive: true });
        // Runtime state is machine-local; don't let consumers commit heartbeats.
        writeFileSync(resolve(coordDir, ".gitignore"), "*\n!.gitignore\n");
        actions.push("+ created .harnery/ (+ .harnery/.gitignore)");
      }

      // ── 1b. stamp the host bin name ────────────────────────────────────────
      // The coord binaries (agent-hook/agent-coord) and web UI run as harnery
      // itself, so they can't see a consumer CLI's name; they read it back from
      // config.jsonc. Standalone `harn` is the resolver's default, so only a
      // consumer (binName ≠ "harn") needs the stamp.
      if (binName && binName !== DEFAULT_BIN_NAME) {
        const configPath = resolve(coordDir, "config.jsonc");
        const stamp = stampBinName(configPath, binName, dryRun);
        if (stamp) actions.push(stamp);
      }

      // ── 2. harness hooks ───────────────────────────────────────────────────
      const settingsPath = resolve(projectRoot, spec.settingsFile);
      const agentHook = relative(projectRoot, resolve(HARNERY_ROOT, "bin", "agent-hook"));

      let settings: SettingsFile;
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
        } catch (err) {
          emit.text(
            `✗ ${rel(projectRoot, settingsPath)} exists but isn't valid JSON; refusing to ` +
              `overwrite. Fix it and re-run.\n  (${(err as Error).message})`,
          );
          emit.setExitCode(1);
          return;
        }
      } else {
        settings = {};
      }
      const { wired, already } = wireHooks(settings, spec, agentHook, harness);

      if (wired === 0) {
        actions.push(
          `· all ${spec.events.length} ${harness} hooks already wired in ${rel(projectRoot, settingsPath)}`,
        );
      } else if (dryRun) {
        actions.push(
          `+ would wire ${wired} hook(s) into ${rel(projectRoot, settingsPath)} (${already} already present)`,
        );
      } else {
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
        actions.push(
          `+ wired ${wired} hook(s) into ${rel(projectRoot, settingsPath)} (${already} already present)`,
        );
      }

      emit.text(render(projectRoot, dryRun, actions));
    });
}

/**
 * Merge agent-hook entries into a harness settings object in place, idempotently.
 * Preserves every existing hook; skips events already wired to
 * `agent-hook <subcommand>`. Honors the harness's entry shape (Claude/Codex nest
 * under an inner `hooks` array; Cursor uses a flat `{ command }`) and ensures the
 * root `version` key when the harness requires one. Pure (no fs/git) so it's
 * unit-testable.
 *
 * The trailing space in the match (`agent-hook ${subcommand} `) is load-bearing:
 * it keeps `stop` from matching `stop-failure`.
 */
export function wireHooks(
  settings: SettingsFile,
  spec: HarnessSpec,
  agentHookPath: string,
  harness: HarnessId,
): { wired: number; already: number } {
  if (spec.rootVersion !== undefined && settings.version === undefined) {
    settings.version = spec.rootVersion;
  }
  if (!settings.hooks) settings.hooks = {};
  let wired = 0;
  let already = 0;
  for (const { settingsKey, subcommand } of spec.events) {
    const command = `bash ${agentHookPath} ${subcommand} --harness ${harness}`;
    const groups = settings.hooks[settingsKey] ?? [];
    const present = groups.some((g) =>
      groupCommands(g).some((c) => c.includes(`agent-hook ${subcommand} `)),
    );
    if (present) {
      already++;
      continue;
    }
    groups.push(makeEntry(spec.entryShape, command));
    settings.hooks[settingsKey] = groups;
    wired++;
  }
  return { wired, already };
}

/**
 * Inverse of {@link wireHooks}: strip every harnery-owned hook entry from a
 * settings object in place, idempotently. A hook is "harnery's" when its command
 * contains `agent-hook ` (the trailing space matches `agent-hook <subcommand>`),
 * so any non-harnery hook the consumer added is preserved. Emptied
 * `hooks[settingsKey]` arrays are dropped; an emptied `hooks` object is dropped
 * entirely. Harness-agnostic (scans every key) so it removes entries left by any
 * harness. Pure (no fs) so it's unit-testable. Returns the count removed and the
 * count of non-harnery hooks left behind.
 */
export function unwireHooks(settings: SettingsFile): { removed: number; remaining: number } {
  if (!settings.hooks || typeof settings.hooks !== "object") return { removed: 0, remaining: 0 };
  let removed = 0;
  for (const key of Object.keys(settings.hooks)) {
    const groups = settings.hooks[key];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !groupCommands(g).some((c) => c.includes("agent-hook ")));
    removed += groups.length - kept.length;
    // removing the emptied hook key is the intent (tiny one-shot object)
    if (kept.length === 0) delete settings.hooks[key];
    else settings.hooks[key] = kept;
  }
  let remaining = 0;
  for (const groups of Object.values(settings.hooks)) {
    if (Array.isArray(groups)) remaining += groups.length;
  }
  // drop the now-empty hooks object so callers see a clean shape
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return { removed, remaining };
}

/** Build a hook entry in the harness's shape. */
function makeEntry(shape: HookEntryShape, command: string): HookGroup {
  return shape === "cursor" ? { command } : { hooks: [{ type: "command", command }] };
}

/** Pull every command string out of a hook entry, regardless of shape. */
function groupCommands(group: HookGroup): string[] {
  if ("command" in group && typeof group.command === "string") return [group.command];
  if ("hooks" in group && Array.isArray(group.hooks)) {
    return group.hooks.map((h) => h.command).filter((c): c is string => typeof c === "string");
  }
  return [];
}

/**
 * Idempotently record `binName` in `.harnery/config.jsonc`, preserving any
 * existing JSONC comments and the `files` section. Returns an action line, or
 * null when nothing changed. Three cases:
 *   - file absent → write a minimal commented stub;
 *   - `binName` already present + matching → no-op;
 *   - present-but-different value → comment-safe in-place value swap;
 *   - key absent → splice it in as the first key (comment-safe).
 */
export function stampBinName(configPath: string, binName: string, dryRun: boolean): string | null {
  const rel = (p: string) => relative(dirname(dirname(configPath)), p) || p;
  const quoted = JSON.stringify(binName);

  if (!existsSync(configPath)) {
    if (dryRun) return `+ would stamp binName "${binName}" into ${rel(configPath)}`;
    writeFileSync(
      configPath,
      `{\n  // Host CLI bin name, surfaced in agent-facing prompts + nudges.\n  "binName": ${quoted}\n}\n`,
    );
    return `+ stamped binName "${binName}" into ${rel(configPath)}`;
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  let parsed: { binName?: unknown } & Record<string, unknown>;
  try {
    parsed = (JSON.parse(stripJsonComments(raw)) as typeof parsed) ?? {};
  } catch {
    // Unparseable config: don't clobber it; leave the bin name to env/manual fix.
    return `· ${rel(configPath)} isn't valid JSONC; skipped binName stamp`;
  }

  if (parsed.binName === binName) return null;

  if (typeof parsed.binName === "string") {
    // Existing value differs; swap it in place (keeps comments + layout).
    const next = raw.replace(/("binName"\s*:\s*)"(?:[^"\\]|\\.)*"/, `$1${quoted}`);
    if (dryRun) return `~ would update binName → "${binName}" in ${rel(configPath)}`;
    writeFileSync(configPath, next);
    return `~ updated binName → "${binName}" in ${rel(configPath)}`;
  }

  // No binName key yet; splice it as the first key.
  const keys = Object.keys(parsed);
  let next: string;
  if (keys.length === 0) {
    next = `{\n  "binName": ${quoted}\n}\n`;
  } else {
    // Insert after the first structural `{` (skipping leading ws + comments).
    const at = firstBraceIndex(raw);
    if (at < 0) return `· ${rel(configPath)} has no object literal; skipped binName stamp`;
    next = `${raw.slice(0, at + 1)}\n  "binName": ${quoted},${raw.slice(at + 1)}`;
  }
  if (dryRun) return `+ would add binName "${binName}" to ${rel(configPath)}`;
  writeFileSync(configPath, next);
  return `+ added binName "${binName}" to ${rel(configPath)}`;
}

/** Index of the first structural `{`, skipping leading whitespace + comments. */
function firstBraceIndex(raw: string): number {
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
    } else if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
    } else if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
    } else if (ch === "{") {
      return i;
    } else {
      return -1;
    }
  }
  return -1;
}

function render(projectRoot: string, dryRun: boolean, actions: string[]): string {
  const head = dryRun ? "harn init (dry run): no changes written" : "harn init";
  const tail = dryRun
    ? "\nRe-run without --dry-run to apply."
    : "\nDone. Start a session and check `harn agents whoami`.";
  return `${head}\n  root: ${projectRoot}\n${actions.map((a) => `  ${a}`).join("\n")}${tail}`;
}

function gitTopLevel(): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const out = r.status === 0 ? r.stdout.trim() : "";
  return out || null;
}

function rel(root: string, p: string): string {
  const r = relative(root, p);
  return r || p;
}
