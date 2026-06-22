/**
 * The coordination helpers.
 *
 * Both surfaces (bash hooks + this TS module) write into the same
 * `.harnery/active/<owner>.json` heartbeat files and `.harnery/pid-map/`
 * ppid map, so a single coord state can be observed and mutated from
 * either side without divergence.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// NOTE: kept dependency-free (node builtins only); this file is vendored verbatim into
// a downstream consumer, so it cannot import the coordEnv helper.

export interface Heartbeat {
  instance_id: string;
  name?: string;
  kind?: string;
  session_id: string;
  agent_id: string;
  model: string;
  started_at: string;
  last_heartbeat: string;
  files_touched: string[];
  agent_type?: string;
  /** Most recent tool name stamped by the PostToolUse hook. Phase 1. */
  last_tool?: string;
  /** Short string identifying what the last tool acted on (file path, command head, URL). Phase 1. */
  last_tool_target?: string;
  /** Free-form task/intent string set via `harn agents set-task`. Phase 2. */
  task?: string;
  /** UTC ISO-8601 timestamp when task was last set/cleared. Used by harnesses without Stop enforcement to compute staleness. 2026-05-24. */
  task_updated_at?: string | null;
  /** Auto-generated per-turn summary written by the Stop hook via Haiku. 2026-05-23. */
  turn_summary?: string | null;
  /** UTC ISO-8601 timestamp when turn_summary was last refreshed. */
  turn_summary_updated_at?: string | null;
  /** Hook client: `claude_code` (default) or `cursor`. Cursor Phase 1. */
  platform?: string;
}

/**
 * Resolve the monorepo root for coord-state purposes.
 *
 * Resolves the coordination root,
 * including the `--git-common-dir` fallback that strips
 * `<superproject>/.git/modules/<name>/` to recover the superproject for
 * submodule worktrees. Without that fallback, a TS coord caller running
 * inside a `harn worktree add-submodule` checkout would resolve a different
 * `.harnery/` than the bash hooks and the two layers would silently diverge.
 */
export function monorepoRoot(): string | null {
  // Test-only override (matches bash HARNERY_COORD_ROOT_OVERRIDE). Lets tests
  // seed `.harnery/pid-map/<pid>` + `.harnery/active/<owner>.json` fixtures
  // in a tmpdir without needing a real git repo.
  const rootOverride = process.env.HARNERY_COORD_ROOT_OVERRIDE;
  if (rootOverride) {
    return rootOverride;
  }

  // 1. Superproject working tree (when running from inside a submodule).
  const sup = spawnSync("git", ["rev-parse", "--show-superproject-working-tree"], {
    encoding: "utf8",
  });
  if (sup.status === 0 && sup.stdout.trim() !== "") {
    return sup.stdout.trim();
  }

  // 2. --git-common-dir fallback for submodule worktrees. `git worktree add`
  // inside a submodule produces a worktree whose --show-superproject-working-
  // tree is empty (the worktree has no submodule relationship of its own),
  // but --git-common-dir points at <superproject>/.git/modules/<name>/, so
  // we recover the superproject by stripping that suffix.
  const common = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    encoding: "utf8",
  });
  if (common.status === 0) {
    const cd = common.stdout.trim();
    const idx = cd.indexOf("/.git/modules/");
    if (idx !== -1) {
      return cd.substring(0, idx);
    }
  }

  // 3. Top-level fallback (regular checkout).
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (top.status === 0 && top.stdout.trim() !== "") {
    return top.stdout.trim();
  }

  return null;
}

/** Parse owner from a pid-map row (`owner` or `owner\tplatform`). */
export function parsePidmapRowOwner(row: string): string {
  const trimmed = row.trim();
  const tab = trimmed.indexOf("\t");
  return tab >= 0 ? trimmed.slice(0, tab) : trimmed;
}

/** Parse platform from a pid-map row; legacy rows default to `claude_code`. */
export function parsePidmapRowPlatform(row: string): string {
  const trimmed = row.trim();
  const tab = trimmed.indexOf("\t");
  return tab >= 0 ? trimmed.slice(tab + 1).trim() : "claude_code";
}

function readPidmapRow(pidmapDir: string, pid: number): string | null {
  const candidate = resolve(pidmapDir, String(pid));
  if (!existsSync(candidate)) return null;
  try {
    const row = readFileSync(candidate, "utf8").trim();
    return row || null;
  } catch {
    return null;
  }
}

/**
 * Walk up the ppid chain looking for a pid-map entry. Returns
 * the resolved instance_id or null.
 *
 * Pid-map files are `instance_id` or `instance_id\tplatform` (Cursor Phase 1).
 * Prefer a row whose platform matches `HARNERY_AGENT_COORD_PLATFORM` (default
 * `claude_code`); otherwise return the first owner seen on the walk.
 *
 * Subagents intentionally do not write pid-map entries; a Bash-tool ppid-walk
 * from inside a subagent therefore resolves to the *parent's* pid-map entry.
 * v1 ships this behavior; a real subagent-aware bridge is out of scope.
 */
export function resolveOwner(): string | null {
  return resolveOwnerWithSource().owner;
}

/**
 * Like `resolveOwner` but also reports which resolution path matched.
 * Used by `harn agents whoami` to surface the path (`env` / `pidmap`) in
 * the diagnostic output. Operators trying to debug "why doesn't my
 * Codex session see itself?" need to know whether `HARNERY_AGENT_COORD_OWNER`
 * is propagating or the ppid-walk is the load-bearing path.
 */
export function resolveOwnerWithSource(): {
  owner: string | null;
  source: "env" | "pidmap" | "pidmap_fallback" | "active_singleton" | "none";
} {
  const envOwner = process.env.HARNERY_AGENT_COORD_OWNER?.trim();
  if (envOwner) {
    return { owner: envOwner, source: "env" };
  }

  const root = monorepoRoot();
  if (!root) return { owner: null, source: "none" };
  const pidmapDir = resolve(root, ".harnery", "pid-map");
  if (!existsSync(pidmapDir)) return { owner: null, source: "none" };

  const prefer = process.env.HARNERY_AGENT_COORD_PLATFORM?.trim() || "claude_code";
  let fallbackOwner: string | null = null;
  let pid: number | null = process.pid;

  for (let hop = 0; hop < 20; hop++) {
    if (pid === null) break;
    const row = readPidmapRow(pidmapDir, pid);
    if (row) {
      const rowOwner = parsePidmapRowOwner(row);
      const rowPlat = parsePidmapRowPlatform(row);
      if (rowPlat === prefer) {
        return { owner: rowOwner || null, source: "pidmap" };
      }
      if (!fallbackOwner && rowOwner) fallbackOwner = rowOwner;
    }
    pid = readPpid(pid);
  }
  if (fallbackOwner) {
    return { owner: fallbackOwner, source: "pidmap_fallback" };
  }

  // Last resort: the ppid walk found nothing (e.g. a Bash-tool subshell whose
  // process tree doesn't climb back to the harness anchor). If exactly one
  // agent is live in this coord root, it's unambiguously us — resolve to it.
  // This is what lets the bare `agents status` / `set-task` the stop hook
  // recommends work without a `--session-id` flag in the common single-agent
  // case. With 0 or 2+ live agents it would be a guess, so we stay null and
  // require the explicit flag.
  const singleton = resolveSingleActiveOwner(root);
  if (singleton) {
    return { owner: singleton, source: "active_singleton" };
  }

  return { owner: null, source: "none" };
}

/**
 * Return the instance_id of the sole live agent in this coord root, or null
 * if there are zero or more than one. "Live" reuses the 10-minute heartbeat
 * freshness window the rest of the agents surface applies (kept inline as a
 * literal so this file stays node-builtins-only for vendored downstream use).
 *
 * Exported for unit testing with an injectable root (the caller in
 * `resolveOwnerWithSource` passes `monorepoRoot()`).
 */
export function resolveSingleActiveOwner(root: string): string | null {
  const activeDir = resolve(root, ".harnery", "active");
  if (!existsSync(activeDir)) return null;
  const FRESHNESS_SECS = 600;
  const cutoffMs = Date.now() - FRESHNESS_SECS * 1000;
  const live: string[] = [];
  let files: string[];
  try {
    files = readdirSync(activeDir);
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(resolve(activeDir, file), "utf8"));
      if (!parsed || typeof parsed.instance_id !== "string") continue;
      const ts = Date.parse(parsed.last_heartbeat);
      if (Number.isFinite(ts) && ts >= cutoffMs) live.push(parsed.instance_id);
    } catch {
      // skip malformed
    }
    if (live.length > 1) return null; // ambiguous; bail early
  }
  return live.length === 1 ? live[0]! : null;
}

/**
 * Read and parse a heartbeat file. Returns null if the file is missing,
 * unreadable, or contains malformed JSON. Does not throw.
 *
 * Phase 8 cleanup (2026-05-27): the v1/v2 dual-write bridge is gone; the
 * projector writes additively-merged heartbeats directly to
 * `.harnery/active/<id>.json` (the canonical location every reader expects).
 */
export function readHeartbeat(instanceId: string): Heartbeat | null {
  if (!instanceId) return null;
  const root = monorepoRoot();
  if (!root) return null;
  return readJsonHeartbeatFile(resolve(root, ".harnery", "active", `${instanceId}.json`));
}

function readJsonHeartbeatFile(path: string): Heartbeat | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.instance_id === "string") {
      return parsed as Heartbeat;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Render the display form for an instance_id: `agent-<Name>` if the heartbeat
 * carries a non-empty `.name`, else `agent-<8-char-hex-prefix>`.
 *
 * Hex fallback handles three cases cleanly:
 *  - heartbeat written before this feature shipped (no `name` field)
 *  - heartbeat pruned but instance_id still appears in older log lines
 *  - the narrow window between instance_id resolution and heartbeat read
 */
export function displayName(instanceId: string): string {
  if (!instanceId) return "agent-unknown";
  const hb = readHeartbeat(instanceId);
  if (hb && typeof hb.name === "string" && hb.name.length > 0) {
    return `agent-${hb.name}`;
  }
  return `agent-${instanceId.slice(0, 8)}`;
}

/**
 * Convenience: resolve self via ppid walk, then render. Returns
 * `agent-unknown` when the walk fails.
 */
export function selfDisplayName(): string {
  const owner = resolveOwner();
  if (!owner) return "agent-unknown";
  return displayName(owner);
}

function readPpid(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^PPid:\s+(\d+)/m);
    if (!m) return null;
    const parsed = Number.parseInt(m[1]!, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}
