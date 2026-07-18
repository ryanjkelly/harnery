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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { coordFreshnessSeconds } from "../../config.ts";

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

function isGitlinkInIndex(coordRoot: string, path: string): boolean {
  const result = spawnSync("git", ["ls-files", "--stage", "--", path], {
    cwd: coordRoot,
    encoding: "utf8",
    timeout: 2000,
  });
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
  if (holderHasLiveForeignPid(coordRoot, holderId)) return false;

  // Gate A: every held path is either in the staged set or already clean in HEAD.
  const holder = peers.find((p) => p.instance_id === holderId);
  if (!holder) return false;
  const files = holder.files_touched ?? [];
  if (files.length === 0) return false;
  for (const held of files) {
    if (stagedSet.has(held)) continue;
    if (isPathCleanInHead(coordRoot, held)) continue;
    return false;
  }
  return true;
}

function holderHasLiveForeignPid(coordRoot: string, holderId: string): boolean {
  const dir = join(coordRoot, ".harnery", "pid-map");
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    let row = "";
    try {
      row = readFileSync(join(dir, f), "utf8").trim();
    } catch {
      continue;
    }
    const owner = row.split("\t")[0]?.trim() ?? "";
    if (owner !== holderId) continue;
    // Process still alive?
    const pid = Number.parseInt(f, 10);
    if (!Number.isFinite(pid)) continue;
    try {
      process.kill(pid, 0); // signal 0 = liveness probe
      return true; // live foreign pid found
    } catch {
      // ESRCH (no such process): pid-map entry is stale, skip
    }
  }
  return false;
}

function isPathCleanInHead(coordRoot: string, relPath: string): boolean {
  // Path is tracked + diff-clean against HEAD = "already committed, holder
  // hasn't released the claim yet". Counts as self-attributable.
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", relPath], {
    cwd: coordRoot,
    encoding: "utf8",
    timeout: 2000,
  });
  if (tracked.status !== 0) return false;
  const diff = spawnSync("git", ["diff", "--quiet", "HEAD", "--", relPath], {
    cwd: coordRoot,
    encoding: "utf8",
    timeout: 2000,
  });
  return diff.status === 0;
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
