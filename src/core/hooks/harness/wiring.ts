/**
 * Read-only harness-hook wiring inspection — the inverse of `harn init`'s
 * writer (commands/init.ts `wireHooks`). Compares what `init` would wire
 * (HARNESS_SPECS) against what's actually present in a project's harness
 * settings file, so `harn doctor` and the SessionStart nudge can tell an agent
 * when a harnery upgrade changed the hook set but the project hasn't been
 * re-wired yet.
 *
 * The shared types + matcher live here (not in init.ts) so the writer, the
 * doctor check, and the session-start renderer all agree on what "wired" means
 * — there's exactly one definition of the `agent-hook <subcommand>` match.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARNESS_SPECS,
  type HarnessId,
  type HarnessSpec,
  type HookEntryShape,
  type HookEvent,
} from "./events.ts";

/** Claude Code + Codex entry: `{ hooks: [{ type, command }] }`. */
export interface ClaudeHookGroup {
  matcher?: string;
  hooks: { type: string; command: string }[];
}
/** Cursor entry: a flat `{ command }`. */
export interface CursorHookGroup {
  command: string;
  type?: string;
  matcher?: string;
}
export type HookGroup = ClaudeHookGroup | CursorHookGroup;

export interface SettingsFile {
  version?: number;
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

/** Build a hook entry in the harness's shape. */
export function makeEntry(shape: HookEntryShape, command: string): HookGroup {
  return shape === "cursor" ? { command } : { hooks: [{ type: "command", command }] };
}

/** Pull every command string out of a hook entry, regardless of shape. */
export function groupCommands(group: HookGroup): string[] {
  if ("command" in group && typeof group.command === "string") return [group.command];
  if ("hooks" in group && Array.isArray(group.hooks)) {
    return group.hooks.map((h) => h.command).filter((c): c is string => typeof c === "string");
  }
  return [];
}

/**
 * Whether a hook command string wires the given agent-hook subcommand. The
 * trailing space is load-bearing: it keeps `stop` from matching `stop-failure`.
 */
export function commandWiresSubcommand(command: string, subcommand: string): boolean {
  return command.includes(`agent-hook ${subcommand} `);
}

/** Pull the agent-hook subcommand out of a command string, or null if none. */
function commandSubcommand(command: string): string | null {
  const m = command.match(/agent-hook\s+([a-z][a-z-]*)\s/);
  return m ? m[1]! : null;
}

export interface WiringDiff {
  /** Spec events not wired in the settings file. */
  missing: HookEvent[];
  /** Spec events already wired. */
  present: HookEvent[];
  /**
   * agent-hook subcommands wired in the file that are NOT in the current spec
   * (e.g. an event renamed/removed by an upgrade). Additive re-init won't clean
   * these — they need explicit removal — so they're surfaced separately.
   */
  orphans: string[];
}

/**
 * Pure diff of one settings object against one harness spec. Read-only inverse
 * of `wireHooks`; no fs, so it's unit-testable.
 */
export function diffWiring(settings: SettingsFile, spec: HarnessSpec): WiringDiff {
  const missing: HookEvent[] = [];
  const present: HookEvent[] = [];
  const hooks = settings.hooks ?? {};

  for (const event of spec.events) {
    const groups = hooks[event.settingsKey] ?? [];
    const wired = groups.some((g) =>
      groupCommands(g).some((c) => commandWiresSubcommand(c, event.subcommand)),
    );
    (wired ? present : missing).push(event);
  }

  const specSubcommands = new Set(spec.events.map((e) => e.subcommand));
  const orphans = new Set<string>();
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const c of groupCommands(g)) {
        const sub = commandSubcommand(c);
        if (sub && !specSubcommands.has(sub)) orphans.add(sub);
      }
    }
  }

  return { missing, present, orphans: [...orphans].sort() };
}

export interface HarnessWiringStatus {
  harness: HarnessId;
  /** Settings file path, relative to the project root. */
  settingsFile: string;
  missing: HookEvent[];
  orphans: string[];
}

/**
 * Inspect every harness whose settings file exists under `projectRoot` and
 * return only those with *drift*. Read-only; never writes.
 *
 * Drift is reported only for a harness the project has **already opted into** —
 * i.e. at least one harnery hook is already wired. A settings file with zero
 * harnery hooks just means this harness isn't harnery-wired here (a bare
 * `.claude/settings.json` is a generic Claude Code file); that's `harn init`'s
 * job to surface on first run, not drift to nag about every session. A harness
 * with no settings file at all, or an unparseable one, is skipped.
 */
export function loadHarnessWiring(projectRoot: string): HarnessWiringStatus[] {
  const out: HarnessWiringStatus[] = [];
  for (const [id, spec] of Object.entries(HARNESS_SPECS) as [HarnessId, HarnessSpec][]) {
    const settingsPath = resolve(projectRoot, spec.settingsFile);
    if (!existsSync(settingsPath)) continue;
    let settings: SettingsFile;
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
    } catch {
      // Unparseable settings file: can't tell opt-in from noise, and the
      // harness itself will complain about its own malformed config. Skip.
      continue;
    }
    const diff = diffWiring(settings, spec);
    if (diff.present.length === 0) continue; // not opted in → not drift
    if (diff.missing.length === 0 && diff.orphans.length === 0) continue; // current
    out.push({
      harness: id,
      settingsFile: spec.settingsFile,
      missing: diff.missing,
      orphans: diff.orphans,
    });
  }
  return out;
}

/**
 * Resolve the harnery package version for context in nudges/checks. Walks up
 * from this module to the package root (works under Bun from `src/` and Node
 * from `dist/`). Returns "" if unresolved — callers omit it from the message.
 */
export function harneryVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg.name === "harnery" && typeof pkg.version === "string") return pkg.version;
      } catch {
        /* no package.json here, or not ours; keep walking up */
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* import.meta.url unavailable or fs error */
  }
  return "";
}
