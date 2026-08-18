/**
 * Read-only adapter-hook wiring inspection — the inverse of `harn init`'s
 * writer (commands/init.ts `wireHooks`). Compares what `init` would wire
 * (ADAPTER_SPECS) against what's actually present in a project's adapter
 * settings file, so `harn doctor` and the SessionStart nudge can tell an agent
 * when a harnery upgrade changed the hook set but the project hasn't been
 * re-wired yet.
 *
 * The shared types + matcher live here (not in init.ts) so the writer, the
 * doctor check, and the session-start renderer all agree on what "wired" means
 * — there's exactly one definition of the `agent-hook <subcommand>` match.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_SPECS,
  type AdapterId,
  type AdapterSpec,
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
  description?: string;
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

/** Build a hook entry in the adapter's shape. */
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
 * token boundary keeps `stop` from matching `stop-failure`, while accepting a
 * minimal command that ends immediately after the subcommand.
 */
export function commandWiresSubcommand(command: string, subcommand: string): boolean {
  const escaped = subcommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\/\\s])agent-hook\\s+${escaped}(?:\\s|$)`).test(command);
}

/** Pull the agent-hook subcommand out of a command string, or null if none. */
function commandSubcommand(command: string): string | null {
  const m = command.match(/(?:^|[/\s])agent-hook\s+([a-z][a-z-]*)(?:\s|$)/);
  return m ? m[1]! : null;
}

/** Whether a command invokes Harnery's agent-hook binary at all. */
export function isAgentHookCommand(command: string): boolean {
  return commandSubcommand(command) !== null;
}

/** The canonical command installed for one adapter event. */
export function hookCommand(
  spec: AdapterSpec,
  agentHookPath: string,
  subcommand: string,
  adapter: AdapterId,
): string {
  const anchor = spec.projectDirEnv ? `"\${${spec.projectDirEnv}:-.}"/` : "";
  return `bash ${anchor}${agentHookPath} ${subcommand} --adapter ${adapter}`;
}

export interface WiringDiff {
  /** Spec events not wired in the settings file. */
  missing: HookEvent[];
  /** Spec events already wired. */
  present: HookEvent[];
  /**
   * agent-hook subcommands wired in the file that are NOT in the current spec
   * (e.g. an event renamed/removed by an upgrade). Re-init removes these, so
   * they are surfaced separately from missing hooks.
   */
  orphans: string[];
  /** Spec events wired more than once under their correct event key. */
  duplicates: HookEvent[];
  /** Spec events wired under an event key other than the canonical one. */
  misplaced: HookEvent[];
  /** Spec events whose correct-key command differs from init's canonical command. */
  stale: HookEvent[];
  /** Settings fields rejected by a adapter with a strict top-level schema. */
  invalidTopLevelKeys: string[];
  /** Hook event names rejected by a adapter with a strict event schema. */
  invalidEventKeys: string[];
}

/**
 * Pure diff of one settings object against one adapter spec. Read-only inverse
 * of `wireHooks`; no fs, so it's unit-testable.
 */
export function diffWiring(
  settings: SettingsFile,
  spec: AdapterSpec,
  expected?: { agentHookPath: string; adapter: AdapterId },
): WiringDiff {
  const missing: HookEvent[] = [];
  const present: HookEvent[] = [];
  const duplicates: HookEvent[] = [];
  const misplaced: HookEvent[] = [];
  const stale: HookEvent[] = [];
  const hooks = settings.hooks ?? {};

  for (const event of spec.events) {
    const groups = hooks[event.settingsKey] ?? [];
    const commands = groups
      .flatMap(groupCommands)
      .filter((c) => commandWiresSubcommand(c, event.subcommand));
    (commands.length > 0 ? present : missing).push(event);
    if (commands.length > 1) duplicates.push(event);
    if (expected && commands.length > 0) {
      const canonical = hookCommand(
        spec,
        expected.agentHookPath,
        event.subcommand,
        expected.adapter,
      );
      if (commands.some((command) => command !== canonical)) stale.push(event);
    }
    const wrongKey = Object.entries(hooks).some(
      ([key, otherGroups]) =>
        key !== event.settingsKey &&
        Array.isArray(otherGroups) &&
        otherGroups.some((group) =>
          groupCommands(group).some((command) => commandWiresSubcommand(command, event.subcommand)),
        ),
    );
    if (wrongKey) misplaced.push(event);
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

  const invalidTopLevelKeys = spec.allowedTopLevelKeys
    ? Object.keys(settings)
        .filter((key) => !spec.allowedTopLevelKeys!.includes(key))
        .sort()
    : [];
  const invalidEventKeys = spec.allowedEventKeys
    ? Object.keys(hooks)
        .filter((key) => !spec.allowedEventKeys!.includes(key))
        .sort()
    : [];

  return {
    missing,
    present,
    orphans: [...orphans].sort(),
    duplicates,
    misplaced,
    stale,
    invalidTopLevelKeys,
    invalidEventKeys,
  };
}

export interface AdapterWiringStatus {
  adapter: AdapterId;
  /** Settings file path, relative to the project root. */
  settingsFile: string;
  missing: HookEvent[];
  orphans: string[];
  duplicates: HookEvent[];
  misplaced: HookEvent[];
  stale: HookEvent[];
  invalidTopLevelKeys: string[];
  invalidEventKeys: string[];
  parseError?: string;
}

/**
 * Inspect every adapter whose settings file exists under `projectRoot` and
 * return only those with *drift*. Read-only; never writes.
 *
 * Drift is reported only for a adapter the project has **already opted into** —
 * i.e. at least one harnery hook is already wired. A settings file with zero
 * harnery hooks just means this adapter isn't harnery-wired here (a bare
 * `.claude/settings.json` is a generic Claude Code file); that's `harn init`'s
 * job to surface on first run, not drift to nag about every session. A adapter
 * with no settings file at all, or an unparseable one, is skipped.
 */
export function loadAdapterWiring(projectRoot: string): AdapterWiringStatus[] {
  const out: AdapterWiringStatus[] = [];
  for (const [id, spec] of Object.entries(ADAPTER_SPECS) as [AdapterId, AdapterSpec][]) {
    const settingsPath = resolve(projectRoot, spec.settingsFile);
    if (!existsSync(settingsPath)) continue;
    let settings: SettingsFile;
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
    } catch (error) {
      out.push({
        adapter: id,
        settingsFile: spec.settingsFile,
        missing: [],
        orphans: [],
        duplicates: [],
        misplaced: [],
        stale: [],
        invalidTopLevelKeys: [],
        invalidEventKeys: [],
        parseError: (error as Error).message,
      });
      continue;
    }
    const packageRoot = harneryPackageRoot();
    const diff = diffWiring(
      settings,
      spec,
      packageRoot
        ? {
            agentHookPath: relative(projectRoot, join(packageRoot, "bin", "agent-hook")),
            adapter: id,
          }
        : undefined,
    );
    if (diff.present.length === 0) continue; // not opted in → not drift
    if (
      diff.missing.length === 0 &&
      diff.orphans.length === 0 &&
      diff.duplicates.length === 0 &&
      diff.misplaced.length === 0 &&
      diff.stale.length === 0 &&
      diff.invalidTopLevelKeys.length === 0 &&
      diff.invalidEventKeys.length === 0
    ) {
      continue; // current
    }
    out.push({
      adapter: id,
      settingsFile: spec.settingsFile,
      missing: diff.missing,
      orphans: diff.orphans,
      duplicates: diff.duplicates,
      misplaced: diff.misplaced,
      stale: diff.stale,
      invalidTopLevelKeys: diff.invalidTopLevelKeys,
      invalidEventKeys: diff.invalidEventKeys,
    });
  }
  return out;
}

export interface AdapterWiringSummary {
  /** Adapters carrying at least one harnery hook. */
  wired: AdapterId[];
  /**
   * Adapters carrying none: no settings file at all, or a settings file with
   * none of ours in it. An unparseable file lands in neither list, since
   * `loadAdapterWiring` already reports that as drift.
   */
  unwired: AdapterId[];
}

/**
 * Classify every known adapter as wired or unwired, without judging whether an
 * unwired one is a problem.
 *
 * `loadAdapterWiring` stays deliberately silent about an adapter with zero
 * harnery hooks, because a bare settings file is not an opt-out signal and
 * nagging about it would false-warn every session. That silence is right in
 * isolation and wrong once you also know the adapter's CLI is installed: then
 * an agent can start a session here and register nothing. Splitting the fact
 * from the judgement lets a caller holding both (doctor) tell "not used here"
 * from "never wired" without changing what counts as drift.
 */
export function summarizeAdapterWiring(projectRoot: string): AdapterWiringSummary {
  const wired: AdapterId[] = [];
  const unwired: AdapterId[] = [];
  for (const [id, spec] of Object.entries(ADAPTER_SPECS) as [AdapterId, AdapterSpec][]) {
    const settingsPath = resolve(projectRoot, spec.settingsFile);
    if (!existsSync(settingsPath)) {
      unwired.push(id);
      continue;
    }
    let settings: SettingsFile;
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
    } catch {
      continue; // unparseable → already surfaced by loadAdapterWiring
    }
    (diffWiring(settings, spec).present.length > 0 ? wired : unwired).push(id);
  }
  return { wired, unwired };
}

/**
 * Resolve the harnery package version for context in nudges/checks. Walks up
 * from this module to the package root (works under Bun from `src/` and Node
 * from `dist/`). Returns "" if unresolved — callers omit it from the message.
 */
export function harneryVersion(): string {
  const root = harneryPackageRoot();
  if (!root) return "";
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (pkg.name === "harnery" && typeof pkg.version === "string") return pkg.version;
  } catch {
    /* unreadable package metadata */
  }
  return "";
}

/** Resolve the package root from either src/ (Bun) or dist/ (Node). */
export function harneryPackageRoot(): string | null {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg.name === "harnery") return dir;
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
  return null;
}
