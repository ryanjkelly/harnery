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
import { dirname, join, resolve, sep } from "node:path";

// NOTE: kept dependency-free (node builtins only); this file is vendored verbatim into
// a downstream consumer, so it cannot import the coordEnv helper.

const MAX_INSTANCE_ID_LENGTH = 128;

/**
 * Instance IDs become coordination filenames, so only one portable basename
 * alphabet is accepted at every filesystem boundary. UUIDs, test IDs, and
 * legacy hex IDs all fit this contract; separators and dot segments do not.
 */
export function isSafeInstanceId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_INSTANCE_ID_LENGTH) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    const alpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const digit = code >= 48 && code <= 57;
    if (!alpha && !digit && code !== 45 && code !== 95) return false;
  }
  return true;
}

export function assertSafeInstanceId(value: unknown): asserts value is string {
  if (!isSafeInstanceId(value)) {
    throw new Error("instance_id must be 1-128 ASCII letters, digits, hyphens, or underscores");
  }
}

/**
 * Resolve one direct-child filename beneath a trusted coordination directory.
 *
 * This is a second boundary behind the instance-ID allowlist. Normalizing the
 * candidate and proving its directory prefix prevents traversal even if a new
 * caller constructs a filename from a different untrusted source.
 */
export function resolveContainedFile(directory: string, fileName: string): string {
  const root = resolve(directory);
  const candidate = resolve(root, fileName);
  if (!candidate.startsWith(`${root}${sep}`) || dirname(candidate) !== root) {
    throw new Error("coordination filename must resolve directly beneath its root");
  }
  return candidate;
}

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
  /** UTC ISO-8601 timestamp when task was last set/cleared. Used by adapters without Stop enforcement to compute staleness. 2026-05-24. */
  task_updated_at?: string | null;
  /** Current evidence-derived activity axis. */
  activity?: "unknown" | "working" | "needs_input" | "idle";
  activity_updated_at?: string;
  activity_source?: string;
  /** Explicit task lifecycle axis. */
  task_state?: "active" | "blocked" | "done";
  task_state_updated_at?: string;
  task_state_reason?: string;
  /** Session name built on the first non-empty set-task; its presence means "this session has been named". 2026-08-09. */
  suggested_session_name?: string;
  /** Stamped by turn.stop once the suggested name is seen in assistant reply text. 2026-08-09. */
  session_name_seen_at?: string;
  /** Which suggested name the latest sighting covered. */
  session_name_seen_for?: string;
  /** Auto-generated per-turn summary written by the Stop hook via Haiku. 2026-05-23. */
  turn_summary?: string | null;
  /** UTC ISO-8601 timestamp when turn_summary was last refreshed. */
  turn_summary_updated_at?: string | null;
  /** Hook client: `claude-code` (default) or `cursor`. Cursor Phase 1. */
  platform?: string;
  workflow_run_id?: string;
  /** Optional declared role consumed by report-only liveness normalization. */
  role?: string;
  /** Durable wait record bindings; absence grants no run-quality exemption. */
  approval_id?: string;
  decision_id?: string;
  next_wake_at?: string;
  work_item_id?: string;
  governor_goal_id?: string;
}

/**
 * Resolve the monorepo root for coord-state purposes.
 *
 * Thin alias for `resolveCoordRoot()`; kept because it is the name the CLI
 * command modules and the vendored downstream consumer already import.
 */
export function monorepoRoot(): string | null {
  return resolveCoordRoot();
}

/**
 * THE coordination-root resolution. Every surface — the hooks, the CLI's reads,
 * and the CLI's canonical emits — resolves through this one function, because a
 * root the two layers disagree about is a root that silently breaks the
 * end-of-turn rules: the hook evaluates `state.status_checked` from the stream
 * it reads, so an emit into a different `.harnery/events.ndjson` is invisible
 * and rule 1/3 blocks a turn that did run `agents status`, with no sequence of
 * CLI commands able to satisfy it.
 *
 * Precedence:
 *   1. `HARNERY_COORD_ROOT_OVERRIDE` — explicit pin (tests, git hooks, and the
 *      root every coord-helper spawn pins for its child).
 *   2. `CLAUDE_PROJECT_DIR` — the adapter stating which project it opened. Hook
 *      processes inherit the session's *shell* cwd, which follows `cd` into a
 *      subdirectory or submodule that may carry a `.harnery/` of its own (or
 *      none at all), so the adapter's own statement outranks the cwd walk.
 *   3. The candidate root that already holds THIS session's heartbeat.
 *   4. The nearest enclosing `.harnery/`, then a git-derived root.
 *
 * Step 3 is what makes CLI/hook disagreement structurally impossible rather
 * than a coin flip. Choosing either root unconditionally is wrong in one
 * direction each: preferring the git superproject strands a session whose
 * adapter opened the submodule itself (its heartbeat lives in the submodule,
 * so status/set-task wrote events the hook never read), while walking up from
 * cwd alone strands the opposite case, a session opened on the superproject
 * whose shell has cd'd into a submodule that carries its own `.harnery/`
 * (regression-tested in tests/unit/coord-helper-root-pin.test.ts). The session's
 * own heartbeat settles it: whichever root the hook registered this session in
 * is the root the CLI must use, and the adapter-exported session id needed to
 * recognize it is available to a plain tool-call subprocess even though
 * `CLAUDE_PROJECT_DIR` is not.
 */
export function resolveCoordRoot(start: string = process.cwd()): string | null {
  const rootOverride = process.env.HARNERY_COORD_ROOT_OVERRIDE;
  if (rootOverride) return rootOverride;

  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) {
    const fromProject = nearestCoordRoot(projectDir);
    if (fromProject) return fromProject;
  }

  // Nearest-first, so the fallback at the end keeps the historical cwd-walk
  // behavior for a shell that has no registered session at all.
  const ancestors = ancestorCoordRoots(start);
  for (const candidate of ancestors) {
    if (rootKnowsSession(candidate)) return candidate;
  }

  // Only reached when no enclosing root knows this session: a submodule
  // worktree (`harn worktree add-submodule`) has no ancestor relationship with
  // the superproject that registered the session, so ask git for it.
  const gitRoots = gitCoordRoots(start).filter((r) => !ancestors.includes(r));
  for (const candidate of gitRoots) {
    if (rootKnowsSession(candidate)) return candidate;
  }

  if (ancestors.length > 0) return ancestors[0] as string;
  if (gitRoots.length > 0) return gitRoots[0] as string;
  // Nothing carries `.harnery/` yet. Hand back the enclosing checkout so a
  // first run (`harn init`, agent-hook's session.start) has somewhere to
  // create it.
  return gitToplevel(start);
}

/** Nearest enclosing directory carrying `.harnery/`, or null. */
export function nearestCoordRoot(start: string): string | null {
  return ancestorCoordRoots(start)[0] ?? null;
}

/** Every enclosing directory carrying `.harnery/`, nearest first. */
function ancestorCoordRoots(start: string): string[] {
  const found: string[] = [];
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".harnery"))) found.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/**
 * Does this root's `.harnery/` already know the process asking?
 *
 * Two discriminators, both genuinely about *this* session: the adapter-exported
 * session id matching a live heartbeat, and a pid-map row on our own ppid
 * chain. Deliberately NOT the single-live-agent fallback that owner resolution
 * ends with — a lone stranger in the wrong root is exactly how `whoami` came to
 * report another agent's name and task as its own.
 */
export function rootKnowsSession(root: string): boolean {
  if (resolveOwnerBySessionEnv(root)) return true;
  return resolveOwnerByPidmap(root).owner !== null;
}

/**
 * Git-derived candidate roots for `start`, in preference order, filtered to
 * those that actually carry `.harnery/`.
 *
 * Spawns run with `cwd: start` rather than the process cwd so an injected
 * start dir resolves its own repository — without that, a call about some
 * unrelated directory inherits this process's repo and can resolve a root that
 * has nothing to do with the question asked.
 */
function gitCoordRoots(start: string): string[] {
  const roots: string[] = [];
  const push = (value: string | null) => {
    if (value && existsSync(join(value, ".harnery")) && !roots.includes(value)) roots.push(value);
  };

  // Superproject working tree (running from inside a submodule).
  push(gitRevParse(start, "--show-superproject-working-tree"));

  // `--git-common-dir` fallback for submodule worktrees: `git worktree add`
  // inside a submodule produces a worktree whose superproject working tree is
  // empty (the worktree has no submodule relationship of its own), but the
  // common dir points at `<superproject>/.git/modules/<name>/`, so the
  // superproject is recoverable by stripping that suffix.
  const common = gitRevParse(start, "--git-common-dir");
  if (common) {
    const idx = common.indexOf("/.git/modules/");
    if (idx !== -1) push(common.substring(0, idx));
  }

  // Top-level (regular checkout).
  push(gitRevParse(start, "--show-toplevel"));
  return roots;
}

function gitToplevel(start: string): string | null {
  return gitRevParse(start, "--show-toplevel");
}

function gitRevParse(cwd: string, flag: string): string | null {
  const key = `${cwd} ${flag}`;
  const cached = gitRevParseCache.get(key);
  if (cached !== undefined) return cached;
  let value: string | null = null;
  try {
    // `cwd` must exist or the spawn itself fails; callers pass paths that may
    // not (a project dir from a stale env var), so treat any failure as "no
    // answer" rather than letting it throw.
    const r = spawnSync("git", ["rev-parse", flag], { encoding: "utf8", cwd });
    if (r.status === 0) value = r.stdout.trim() || null;
  } catch {
    value = null;
  }
  gitRevParseCache.set(key, value);
  return value;
}

/**
 * Memoized because git spawns are the expensive part of resolution and every
 * CLI command resolves the root many times per invocation. Keyed by (cwd, flag);
 * a repository's identity does not change under a running process.
 */
const gitRevParseCache = new Map<string, string | null>();

/** Parse owner from a pid-map row (`owner` or `owner\tplatform`). */
export function parsePidmapRowOwner(row: string): string {
  const trimmed = row.trim();
  const tab = trimmed.indexOf("\t");
  return tab >= 0 ? trimmed.slice(0, tab) : trimmed;
}

/** Parse platform from a pid-map row; legacy rows default to `claude-code`. */
export function parsePidmapRowPlatform(row: string): string {
  const platform = row.trim().split("\t")[1]?.trim();
  return platform || "claude-code";
}

/** Parse the start token from a pid-map row; rows written before it carry none. */
export function parsePidmapRowStartToken(row: string): string | undefined {
  return row.trim().split("\t")[2]?.trim() || undefined;
}

/**
 * Is the process now holding `pid` the one this row was written for?
 *
 * A pid is a number the OS re-issues, and quickly: a `pid_max` of 99999 against
 * ~100 new processes a second recycles the whole space about every quarter
 * hour. Believing a row past that point resolves this session to whichever
 * agent last held the number — which is what made `whoami` report a stranger's
 * name and files. The start token settles it, since two processes may share a
 * pid but never a pid and a start instant.
 *
 * Deliberately inlined rather than imported from `state/proc-start.ts`: this
 * file is vendored verbatim into a downstream consumer and stays on node
 * builtins only. The token is a wire format shared with that module and with
 * the host's commit guard, so the copies must agree byte for byte; exported so
 * a test can hold this one against `processStartToken` and fail on drift.
 */
export function pidStartToken(pid: number): string | null {
  const forced = process.env.HARNERY_PID_PROBE;
  const useProcfs = forced === "procfs" || (forced !== "ps" && existsSync("/proc/self/stat"));
  // One machine, one probe. Falling back to the other on a read failure would
  // answer in the wrong dialect and read as a recycled pid.
  if (useProcfs) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const afterComm = stat.slice(stat.lastIndexOf(") ") + 2);
      // Fields after comm, 0-based: 0 is state (field 3), starttime (22) is 19.
      const ticks = afterComm.split(" ")[19];
      if (!ticks || !/^\d+$/.test(ticks)) return null;
      // Ticks count from boot, so they repeat across reboots; the boot id scopes
      // them. Rows written before it carry ticks alone and still compare.
      let boot = "";
      try {
        const raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
          .trim()
          .replace(/-/g, "");
        if (/^[0-9a-f]{8,}$/.test(raw)) boot = `${raw.slice(0, 8)}.`;
      } catch {
        /* unnamed boot: fall back to the tick-only shape */
      }
      return `l${boot}${ticks}`;
    } catch {
      return null;
    }
  }
  try {
    // TZ and locale are pinned because `ps` renders the date through them, and
    // two callers with different environments must not disagree about one
    // process.
    const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    });
    if (out.status !== 0) return null;
    const lstart = (out.stdout ?? "").split("\n")[0]?.trim().replace(/\s+/g, " ");
    return lstart ? `p${lstart}` : null;
  } catch {
    return null;
  }
}

function pidWasRecycled(pid: number, row: string): boolean {
  const recorded = parsePidmapRowStartToken(row);
  if (!recorded) return false; // pre-token row: unverifiable, behave as before
  const current = pidStartToken(pid);
  if (!current) return false;
  if (current === recorded) return false;
  // A row predating the boot segment recorded ticks alone; compare it on what
  // it recorded rather than pruning every live row on the first upgraded run.
  if (
    recorded[0] === "l" &&
    current[0] === "l" &&
    recorded.includes(".") !== current.includes(".")
  ) {
    const ticks = (t: string) => (t.includes(".") ? t.slice(t.indexOf(".") + 1) : t.slice(1));
    return ticks(recorded) !== ticks(current);
  }
  return true;
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
 * `claude-code`); otherwise return the first owner seen on the walk.
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
  const bridge = process.env.HARNERY_AGENT_COORD_BRIDGE?.trim();
  const envOwner = process.env.HARNERY_AGENT_COORD_OWNER?.trim();
  // A bridge-marked child must prove identity through a live heartbeat. An
  // inherited owner override is only a string, so trusting it here would let a
  // stale or foreign environment bypass the bridge's fail-closed contract.
  if (envOwner && !bridge) {
    return { owner: envOwner, source: "env" };
  }

  const root = monorepoRoot();
  if (!root) return { owner: null, source: "none" };

  // Every supported adapter exports its session id into the env of the
  // subprocess it spawns for a tool call, and each heartbeat records the
  // session id it was minted under. Matching the two names us outright, even
  // with many live agents, so it goes ahead of the ppid walk rather than
  // catching what the walk drops. Cursor needed this first because its
  // Glass/Agents UI runs several chats under one node ancestor, making that row
  // last-writer-wins; pid recycling generalises the same hazard to every
  // adapter.
  if (shouldPreferSessionEnv()) {
    const bySession = resolveOwnerBySessionEnv(root);
    if (bySession) {
      return { owner: bySession, source: "session_env" };
    }
  }

  // Connector children cross process-tree boundaries where pid ancestry is
  // not logical session identity. Once marked, a missing or stale session
  // heartbeat is terminal: never guess through pid-map or singleton fallback.
  if (bridge) return { owner: null, source: "none" };

  if (!existsSync(resolve(root, ".harnery", "pid-map"))) return { owner: null, source: "none" };

  const byPidmap = resolveOwnerByPidmap(root);
  if (byPidmap.owner) return byPidmap;

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
 * Walk our own ppid chain for a pid-map row in ONE given root.
 *
 * Root-parameterized (rather than resolving the root itself) so root resolution
 * can use it as a discriminator without recursing back into itself.
 */
export function resolveOwnerByPidmap(root: string): {
  owner: string | null;
  source: "pidmap" | "pidmap_fallback" | "none";
} {
  const pidmapDir = resolve(root, ".harnery", "pid-map");
  if (!existsSync(pidmapDir)) return { owner: null, source: "none" };

  const prefer = process.env.HARNERY_AGENT_COORD_PLATFORM?.trim() || "claude-code";
  let fallbackOwner: string | null = null;
  let pid: number | null = process.pid;

  for (let hop = 0; hop < 20; hop++) {
    if (pid === null) break;
    const row = readPidmapRow(pidmapDir, pid);
    if (row && !pidWasRecycled(pid, row)) {
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
  return { owner: null, source: "none" };
}

/**
 * Adapter-exported session-id environment variables, in precedence order. Each
 * supported adapter propagates its session id into the env of the subprocess it
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
  "CODEX_THREAD_ID",
] as const;

/** Read normalized candidates from the first non-empty adapter session-id env var. */
/**
 * First adapter/bridge-stamped session id from the environment, WITHOUT the
 * live-heartbeat validation resolveOwnerBySessionEnv applies. A fresh session
 * has no heartbeat until its first set-task, so heartbeat-validated resolution
 * returns null there by design; commands that REGISTER a session (set-task)
 * may use this id directly — it carries the same trust as an explicit
 * `--session-id` argument, because the adapter or connector stamped it.
 */
export function sessionIdentityFromEnv(): string | null {
  return sessionIdsFromEnv()[0] ?? null;
}

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

/** Read the first non-empty adapter session-id env var, or null. */
function sessionIdFromEnv(): string | null {
  return sessionIdsFromEnv()[0] ?? null;
}

/**
 * Should the adapter-exported session id be consulted before the ppid walk?
 *
 * Yes, whenever one is exported. The env var is the adapter stating its own
 * identity; the walk is a guess over a namespace the OS recycles. On a box with
 * `pid_max` of 99999 and ~100 pids allocated per second the whole pid space
 * turns over about every quarter hour, so a row written before that can name a
 * pid some unrelated process now holds. Pruning cannot save the walk here:
 * it removes rows whose pid is dead, and a recycled pid is alive. Letting a
 * guess outrank a statement of fact is what made `agents whoami` report another
 * agent's name and file list.
 *
 * This only reorders the two. Session-env resolution still requires a live
 * heartbeat carrying that session id, so when it does not match, the walk runs
 * exactly as before.
 */
function shouldPreferSessionEnv(): boolean {
  return sessionIdFromEnv() !== null;
}

/**
 * Resolve the owner by matching the adapter session-id env var against the
 * `session_id` of a live heartbeat in this coord root. Returns the matching
 * `instance_id`, or null if there's no session-id env var or no live heartbeat
 * carries it. "Live" reuses the same 10-minute freshness window the singleton
 * fallback applies, so a stale heartbeat from a prior session of the same id
 * doesn't resolve. When legacy Cursor Glass state contains both the canonical
 * bare id and its raw `bc-` alias, candidate order wins first; ties prefer a
 * named heartbeat, then the newest heartbeat, with instance id as a stable
 * final tie-breaker. Filesystem enumeration order never decides identity.
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
  const matches: Array<{
    instanceId: string;
    sessionPreference: number;
    /** 0 = the adapter session itself; 1 = subagent/transient/workflow child. */
    kindRank: number;
    hasName: boolean;
    lastHeartbeatMs: number;
  }> = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(resolve(activeDir, file), "utf8"));
      if (!parsed) continue;
      const sessionPreference = sessionIds.indexOf(parsed.session_id);
      if (sessionPreference === -1) continue;
      if (typeof parsed.instance_id !== "string") continue;
      const ts = Date.parse(parsed.last_heartbeat);
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;
      // In-process subagents inherit the adapter's session-id env var, so their
      // heartbeats carry the SAME session_id as the session that spawned them —
      // several live heartbeats can match at once. The env var names the
      // adapter session, so the session-kind heartbeat is the owner; ranking a
      // subagent above it hands the session's CLI calls (journal, decision,
      // artifacts) to whichever child heartbeated most recently. This also
      // matches the ppid-walk contract: subagent CLI calls attribute to the
      // parent session (subagents write no pid-map rows by design).
      const isSideKind =
        (typeof parsed.kind === "string" && parsed.kind !== "session") ||
        typeof parsed.workflow_run_id === "string";
      matches.push({
        instanceId: parsed.instance_id,
        sessionPreference,
        kindRank: isSideKind ? 1 : 0,
        hasName: typeof parsed.name === "string" && parsed.name.trim().length > 0,
        lastHeartbeatMs: ts,
      });
    } catch {
      // skip malformed
    }
  }
  matches.sort(
    (a, b) =>
      a.sessionPreference - b.sessionPreference ||
      a.kindRank - b.kindRank ||
      Number(b.hasName) - Number(a.hasName) ||
      b.lastHeartbeatMs - a.lastHeartbeatMs ||
      a.instanceId.localeCompare(b.instanceId),
  );
  return matches[0]?.instanceId ?? null;
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
  if (!isSafeInstanceId(instanceId)) return null;
  const root = monorepoRoot();
  if (!root) return null;
  const path = resolveContainedFile(resolve(root, ".harnery", "active"), `${instanceId}.json`);
  return readJsonHeartbeatFile(path);
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
