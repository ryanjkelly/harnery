/**
 * Pre-commit E-guard verdict. The caller (typically a bash pre-commit hook)
 * sends a JSON request with the staged paths, resolves its own instance_id
 * via pid-map, and prints the verdict messages + exits with
 * verdict.exit_code.
 *
 * Three outcomes:
 *   1. allow (no conflicts): exit 0.
 *   2. allow + suppressed (self-attribution heuristic: holder's files ⊆
 *      staged set AND no live foreign pid anchors them): exit 0, prints
 *      "treating as self under transient identity".
 *   3. block: exit 1, prints "Commit blocked by multi-agent coordination".
 *
 * `bypass: true` flips conflict → allow + warning lines (the
 * `HARNERY_AGENT_COORD_BYPASS=1` escape hatch).
 *
 * Gitlink discrimination: a parent-repo staged submodule path is a pointer
 * bump, NOT a claim on the submodule's contents. The caller supplies
 * `staged_gitlinks[]` (cheap to compute via `git ls-files --stage`); paths
 * in that set are matched with the staged-is-gitlink rule.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { coordFreshnessSeconds } from "../../config.ts";
import { instanceHasLivePid } from "../state/pidmap.ts";

interface PeerHeartbeat {
  instance_id: string;
  session_id?: string;
  name?: string;
  files_touched?: string[];
  last_heartbeat?: string;
}

interface Conflict {
  /** Staged path that triggered the match. */
  staged_path: string;
  /** The peer's claimed path (may be a parent/child of staged_path). */
  claimed_path: string;
  /** Peer's instance_id. */
  instance_id: string;
  /** Peer's display name (or first 8 chars of instance_id). */
  short_name: string;
}

export interface CommitVerdictRequest {
  instance_id: string;
  /** Group key. Subagents inherit parent's session_id. */
  session_id: string;
  /** Canonical monorepo-relative paths. */
  staged_paths: string[];
  /** Paths in `staged_paths` that resolve to submodule gitlinks (mode 160000)
   * in the index. Used for gitlink-discrimination prefix matching. */
  staged_gitlinks?: string[];
  /** `HARNERY_AGENT_COORD_BYPASS=1` was set. Conflicts become warnings, not blocks. */
  bypass?: boolean;
}

export interface CommitVerdictResult {
  allow: boolean;
  exit_code: number;
  rule: string;
  /** Conflict details (for the caller to print). */
  conflicts: Conflict[];
  /** Path-specific gates that fired (for `coord_log` lines). */
  log_lines: string[];
  /** Human-readable header for printing. */
  message: string;
  /** When true, conflicts were detected but suppressed (self-attribution). */
  suppressed_self_attribution?: boolean;
}

export function evaluateCommit(coordRoot: string, req: CommitVerdictRequest): CommitVerdictResult {
  if (req.staged_paths.length === 0) {
    return {
      allow: true,
      exit_code: 0,
      rule: "commit.pass",
      conflicts: [],
      log_lines: [],
      message: "",
    };
  }

  const peers = readActivePeers(coordRoot);
  const cutoffMs = Date.now() - coordFreshnessSeconds(coordRoot) * 1000;
  const stagedSet = new Set(req.staged_paths);
  const gitlinkSet = new Set(req.staged_gitlinks ?? []);

  const conflicts: Conflict[] = [];
  for (const peer of peers) {
    if (peer.instance_id === req.instance_id) continue;
    const peerSession = peer.session_id ?? peer.instance_id;
    if (req.session_id && peerSession === req.session_id) continue; // same group
    const ts = peer.last_heartbeat ? Date.parse(peer.last_heartbeat) : 0;
    if (!Number.isFinite(ts) || ts < cutoffMs) continue; // stale
    const files = peer.files_touched ?? [];
    if (files.length === 0) continue;

    for (const staged of req.staged_paths) {
      const stagedIsGitlink = gitlinkSet.has(staged);
      const hit = findOverlap(staged, files, coordRoot, stagedIsGitlink);
      if (!hit) continue;
      conflicts.push({
        staged_path: staged,
        claimed_path: hit,
        instance_id: peer.instance_id,
        short_name: shortName(peer),
      });
      break; // one conflict per peer is enough
    }
  }

  if (conflicts.length === 0) {
    return {
      allow: true,
      exit_code: 0,
      rule: "commit.pass",
      conflicts: [],
      log_lines: [],
      message: "",
    };
  }

  if (req.bypass) {
    return {
      allow: true,
      exit_code: 0,
      rule: "commit.bypass",
      conflicts,
      log_lines: conflicts.map(
        (c) => `COMMIT_BYPASSED  path=${c.staged_path} owner=${c.short_name}`,
      ),
      message:
        "⚠ Multi-Agent coordination: bypass active; staged paths claimed by other agents will be committed anyway:",
    };
  }

  // Self-attribution check (Fix #2): if every conflicting holder is plausibly
  // us under a transient identity (held files_touched ⊆ the staged set AND no
  // live foreign PID anchors the holder via pid-map), suppress the block.
  const allSelfAttributed = conflicts.every((c) =>
    isHolderSelfAttributed(coordRoot, c.instance_id, stagedSet, peers),
  );
  if (allSelfAttributed) {
    return {
      allow: true,
      exit_code: 0,
      rule: "commit.suppressed",
      conflicts,
      log_lines: conflicts.map(
        (c) =>
          `COMMIT_SUPPRESSED  path=${c.staged_path} owner=${c.short_name} reason=self_attribution`,
      ),
      message:
        "⚠ Multi-Agent coordination: self-attribution detected; staged paths\n" +
        "  are claimed by an unanchored heartbeat that holds only files in\n" +
        "  this commit's staged set. Treating as self under a transient\n" +
        "  identity; commit will proceed.",
      suppressed_self_attribution: true,
    };
  }

  return {
    allow: false,
    exit_code: 1,
    rule: "commit.conflict",
    conflicts,
    log_lines: conflicts.map((c) => `COMMIT_BLOCKED  path=${c.staged_path} owner=${c.short_name}`),
    message:
      "✗ Commit blocked by multi-agent coordination (E guard).\n\n" +
      "  The following staged paths are currently claimed by other\n" +
      "  active agents:",
  };
}

function findOverlap(
  staged: string,
  files: readonly string[],
  coordRoot: string,
  stagedIsGitlink: boolean,
): string | null {
  for (const claimed of files) {
    if (claimed === staged) return claimed;
    if (claimed.startsWith(`${staged}/`)) {
      // Staged is a submodule gitlink, claimed is a file inside it. Disjoint.
      if (stagedIsGitlink) continue;
      return claimed;
    }
    if (staged.startsWith(`${claimed}/`)) {
      // Claimed is a gitlink, staged is a file inside it. Disjoint.
      if (isGitlinkInIndex(coordRoot, claimed)) continue;
      return claimed;
    }
  }
  return null;
}

/**
 * Repository-discovery environment that git exports to its own hooks.
 *
 * A hook runs with GIT_DIR (and friends) already pointing at the repository
 * being committed, and every child inherits them. That silently outranks `cwd`,
 * so a probe launched from some other directory still interrogates the hook's
 * repository. Committing inside a submodule therefore asked the submodule about
 * superproject paths and vice versa, and the answers were wrong in whichever
 * direction did not match. Scrubbing these lets git rediscover the repository
 * from `cwd`, which is the whole point of choosing a `cwd` per path.
 */
const GIT_DISCOVERY_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
] as const;

/** Run a read-only git probe in `cwd`, free of the caller's repo environment. */
function gitProbe(args: string[], cwd: string): { status: number; stdout: string } {
  const env = { ...process.env };
  for (const v of GIT_DISCOVERY_VARS) delete env[v];
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 2000 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

function isGitlinkInIndex(coordRoot: string, path: string): boolean {
  const result = gitProbe(["ls-files", "--stage", "--", path], coordRoot);
  if (result.status !== 0) return false;
  // ls-files --stage emits "<mode> <sha> <stage>\t<path>"; mode 160000 = gitlink.
  return result.stdout.trim().startsWith("160000 ");
}

function isHolderSelfAttributed(
  coordRoot: string,
  holderId: string,
  stagedSet: Set<string>,
  peers: readonly PeerHeartbeat[],
): boolean {
  // Gate B (cheaper): live foreign pid-map entry blocks self-attribution.
  if (holderHasLiveForeignPid(coordRoot, holderId)) {
    debugGate(coordRoot, { holder: holderId, gate: "B", reason: "live_pid_anchor" });
    return false;
  }

  // Gate A: every held path is either in the staged set or already clean in HEAD.
  const holder = peers.find((p) => p.instance_id === holderId);
  if (!holder) {
    debugGate(coordRoot, { holder: holderId, gate: "A", reason: "holder_not_found" });
    return false;
  }
  const files = holder.files_touched ?? [];
  if (files.length === 0) {
    debugGate(coordRoot, { holder: holderId, gate: "A", reason: "holder_holds_nothing" });
    return false;
  }
  for (const held of files) {
    if (stagedSet.has(held)) continue;
    if (isPathCleanInHead(coordRoot, held)) continue;
    if (isPathIgnoredByGit(coordRoot, held)) continue;
    debugGate(coordRoot, { holder: holderId, gate: "A", reason: "path_unverifiable", path: held });
    return false;
  }
  return true;
}

/**
 * Append one line explaining a refused gate, when HARNERY_COORD_DEBUG is set.
 *
 * Worth carrying permanently: the deciding state lives inside a git hook, whose
 * stderr the caller discards and whose process is gone before anyone can look.
 * Reconstructing a refusal afterwards means guessing, because the holder's claim
 * set has moved on by then. This turns that into evidence.
 */
function debugGate(coordRoot: string, detail: Record<string, string>): void {
  if (!process.env.HARNERY_COORD_DEBUG) return;
  try {
    appendFileSync(
      join(coordRoot, ".harnery", "coord-debug.ndjson"),
      `${JSON.stringify({ event: "self_attribution_refused", pid: process.pid, ...detail })}\n`,
      "utf8",
    );
  } catch {
    /* diagnostics never break a verdict */
  }
}

/**
 * Does git ignore this path?
 *
 * Such a claim is safe to look past. Agents write scratch files into ignored
 * directories constantly, and each one used to leave a claim that Gate A could
 * never vouch for: not staged, not tracked, therefore "unknown", therefore
 * blocked. That defeated self-attribution for the rest of a session and taught
 * agents to reach for the bypass. An ignored path cannot enter anyone's commit,
 * so it cannot be work this commit might clobber. A merely untracked path is a
 * different matter and still counts against the holder, since anybody could add
 * it.
 */
function isPathIgnoredByGit(coordRoot: string, relPath: string): boolean {
  const abs = join(coordRoot, relPath);
  const cwd = dirname(abs);
  if (!existsSync(cwd)) return false;
  // check-ignore exits 0 when the path is ignored, 1 when it is not.
  return gitProbe(["check-ignore", "--quiet", "--", basename(abs)], cwd).status === 0;
}

function holderHasLiveForeignPid(coordRoot: string, holderId: string): boolean {
  return instanceHasLivePid(coordRoot, holderId);
}

function isPathCleanInHead(coordRoot: string, relPath: string): boolean {
  // Path is tracked + diff-clean against HEAD = "already committed, holder
  // hasn't released the claim yet". Counts as self-attributable.
  //
  // Ask the repository that actually tracks the path, by running git from the
  // file's own directory instead of the coord root. Claims are recorded
  // monorepo-relative, so a submodule file arrives here as `sub/src/x.ts`, and
  // the superproject does not track submodule contents: asking it always
  // answered "not tracked". Gate A therefore failed for every submodule path,
  // self-attribution never suppressed a submodule commit, and the operator paid
  // a HARNERY_AGENT_COORD_BYPASS=1 per commit. Running from the file's directory
  // lands in the submodule's own repo and handles any nesting depth.
  const abs = join(coordRoot, relPath);
  const cwd = dirname(abs);
  const base = basename(abs);
  if (!existsSync(cwd)) return false;
  if (gitProbe(["ls-files", "--error-unmatch", "--", base], cwd).status !== 0) return false;
  return gitProbe(["diff", "--quiet", "HEAD", "--", base], cwd).status === 0;
}

function readActivePeers(coordRoot: string): PeerHeartbeat[] {
  const dir = join(coordRoot, ".harnery", "active");
  if (!existsSync(dir)) return [];
  const out: PeerHeartbeat[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const hb = JSON.parse(readFileSync(join(dir, f), "utf8")) as PeerHeartbeat;
      if (hb.instance_id) out.push(hb);
    } catch {
      /* skip */
    }
  }
  return out;
}

function shortName(peer: PeerHeartbeat): string {
  if (peer.name && peer.name.length > 0) return `agent-${peer.name}`;
  return `agent-${peer.instance_id.slice(0, 8)}`;
}
