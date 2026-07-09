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
  source: "env" | "pidmap" | "pidmap_fallback" | "session_env" | "active_singleton" | "none";
} {
  const envOwner = process.env.HARNERY_AGENT_COORD_OWNER?.trim();
  if (envOwner) {
    return { owner: envOwner, source: "env" };
  }

  const root = monorepoRoot();
  if (!root) return { owner: null, source: "none" };

  // Cursor's Glass/Agents UI can run several chats under one long-lived node
  // process, so the pid-map row for that shared ancestor is last-writer-wins.
  // Prefer the per-chat session id when Cursor exposes one in the tool env.
  if (shouldPreferSessionEnv()) {
    const bySession = resolveOwnerBySessionEnv(root);
    if (bySession) {
      return { owner: bySession, source: "session_env" };
    }
  }

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

  // The ppid walk found nothing (e.g. a Bash-tool subshell whose process tree
  // doesn't climb back to the harness anchor). Before guessing, try the
  // harness-provided session id from the environment: every supported harness
  // exports its session id into the tool subprocess env, and each heartbeat
  // records the `session_id` it was minted under. Matching the two resolves us
  // unambiguously even with multiple live agents, which is the case the
  // singleton fallback below cannot handle.
  const bySession = resolveOwnerBySessionEnv(root);
  if (bySession) {
    return { owner: bySession, source: "session_env" };
  }

  // Last resort: if exactly one agent is live in this coord root, it's
  // unambiguously us — resolve to it. This is what lets the bare `agents
  // status` / `set-task` the stop hook recommends work without a `--session-id`
  // flag in the common single-agent case. With 0 or 2+ live agents it would be
  // a guess, so we stay null and require the explicit flag.
  const singleton = resolveSingleActiveOwner(root);
  if (singleton) {
    return { owner: singleton, source: "active_singleton" };
  }

  return { owner: null, source: "none" };
}

/**
 * Harness-exported session-id environment variables, in precedence order. Each
 * supported harness propagates its session id into the env of the subprocess it
 * spawns for a tool call (Claude Code's Bash tool, Cursor's terminal, Codex's
 * shell). A coord CLI invoked as such a tool can therefore recover its own
 * identity from the env even when the ppid walk misses.
 *
 * Kept inline (no shared-helper import) so this file stays node-builtins-only
 * for the vendored downstream consumer.
 */
const SESSION_ID_ENV_VARS = [
  "HARNERY_AGENT_COORD_SESSION_ID", // explicit override, wins if set
  "CLAUDE_CODE_SESSION_ID",
  "CURSOR_SESSION_ID",
  "CURSOR_CONVERSATION_ID",
  "CODEX_SESSION_ID",
] as const;

/** Read normalized candidates from the first non-empty harness session-id env var. */
function sessionIdsFromEnv(): string[] {
  for (const key of SESSION_ID_ENV_VARS) {
    const v = process.env[key]?.trim();
    if (!v) continue;
    if (key === "CURSOR_CONVERSATION_ID" && v.startsWith("bc-") && v.length > 3) {
      return [v.slice(3), v];
    }
    return [v];
  }
  return [];
}

/** Read the first non-empty harness session-id env var, or null. */
function sessionIdFromEnv(): string | null {
  return sessionIdsFromEnv()[0] ?? null;
}

function shouldPreferSessionEnv(): boolean {
  if (!sessionIdFromEnv()) return false;
  const platform = process.env.HARNERY_AGENT_COORD_PLATFORM?.trim();
  return process.env.CURSOR_AGENT === "1" || platform === "cursor";
}

/**
 * Resolve the owner by matching the harness session-id env var against the
 * `session_id` of a live heartbeat in this coord root. Returns the matching
 * `instance_id`, or null if there's no session-id env var or no live heartbeat
 * carries it. "Live" reuses the same 10-minute freshness window the singleton
 * fallback applies, so a stale heartbeat from a prior session of the same id
 * doesn't resolve.
 *
 * Exported for unit testing with an injectable root.
 */
export function resolveOwnerBySessionEnv(root: string): string | null {
  const sessionIds = sessionIdsFromEnv();
  if (sessionIds.length === 0) return null;

  const activeDir = resolve(root, ".harnery", "active");
  if (!existsSync(activeDir)) return null;
  const FRESHNESS_SECS = 600;
  const cutoffMs = Date.now() - FRESHNESS_SECS * 1000;
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
      if (!parsed || !sessionIds.includes(parsed.session_id)) continue;
      if (typeof parsed.instance_id !== "string") continue;
      const ts = Date.parse(parsed.last_heartbeat);
      if (Number.isFinite(ts) && ts >= cutoffMs) return parsed.instance_id;
    } catch {
      // skip malformed
    }
  }
  return null;
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
  // Linux/WSL fast path: /proc/<pid>/status carries `PPid:`.
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^PPid:\s+(\d+)/m);
    if (m) {
      const parsed = Number.parseInt(m[1]!, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // no /proc (macOS/BSD) — fall through to ps
  }
  // Portable fallback: `ps -o ppid= -p <pid>` works on macOS/BSD/Linux.
  try {
    const out = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
    if (out.status === 0) {
      const parsed = Number.parseInt(out.stdout.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // ps unavailable — give up
  }
  return null;
}
