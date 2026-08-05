/**
 * Ownership-aware Git completion checks for the end-of-turn status ritual.
 *
 * The heartbeat's durable `files_touched` ledger is the ownership boundary. We
 * inspect only those paths, plus any enclosing submodule gitlinks, so a peer's
 * active edits elsewhere in a shared checkout do not block this session.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readStreamTailBounded } from "./events/consume.ts";

const CLAIM_HISTORY_CAP_BYTES = 128 * 1024 * 1024;

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

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface RepoWork {
  root: string;
  paths: Set<string>;
}

export interface GitFinalizationResult {
  ok: boolean;
  claim_history_complete: boolean;
  dirty_paths: string[];
  unpushed_repos: string[];
  unverifiable_paths: string[];
  unverifiable_repos: string[];
  repos_checked: string[];
}

export interface SessionWriteClaims {
  paths: string[];
  complete: boolean;
}

/**
 * Read every write claim made by this session, including claims released after
 * a commit. Current heartbeat claims describe dirty ownership; this history is
 * what keeps the touched repository in scope until its commits are pushed.
 */
export function readSessionWriteClaims(
  coordRoot: string,
  instanceId: string,
  sessionId: string,
): SessionWriteClaims {
  const streamPath = join(coordRoot, ".harnery", "events.ndjson");
  const { text, truncated } = readStreamTailBounded(streamPath, CLAIM_HISTORY_CAP_BYTES);
  const paths = new Set<string>();
  let sawSessionStart = false;

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const event = JSON.parse(line) as {
        event_type?: string;
        instance_id?: string;
        session_id?: string;
        data?: { path?: unknown; mode?: unknown };
      };
      if (event.instance_id !== instanceId || event.session_id !== sessionId) continue;
      if (event.event_type === "session.start") sawSessionStart = true;
      if (
        event.event_type === "claim.acquire" &&
        event.data?.mode === "write" &&
        typeof event.data.path === "string"
      ) {
        paths.add(event.data.path);
      }
    } catch {
      // Ignore malformed and crash-truncated event lines, matching the
      // canonical stream consumer's recovery behavior.
    }
  }

  return { paths: [...paths], complete: !truncated || sawSessionStart };
}

function git(args: string[], cwd: string): GitResult {
  const env = { ...process.env };
  for (const name of GIT_DISCOVERY_VARS) delete env[name];
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 5_000 });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function repoLabel(coordRoot: string, repoRoot: string): string {
  const rel = relative(coordRoot, repoRoot).replaceAll("\\", "/");
  return rel.length === 0 ? "." : rel;
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function existingProbeDir(coordRoot: string, absolutePath: string): string | null {
  let current = absolutePath;
  if (existsSync(current) && !statSync(current).isDirectory()) current = dirname(current);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current || !pathInside(coordRoot, parent)) return null;
    current = parent;
  }
  return current;
}

function discoverRepo(coordRoot: string, heldPath: string): { root: string; path: string } | null {
  const absolutePath = resolve(coordRoot, heldPath);
  if (!pathInside(coordRoot, absolutePath)) return null;
  const probeDir = existingProbeDir(coordRoot, absolutePath);
  if (!probeDir) return null;
  const rootResult = git(["rev-parse", "--show-toplevel"], probeDir);
  if (rootResult.status !== 0) return null;
  const repoRoot = resolve(rootResult.stdout.trim());
  if (!pathInside(coordRoot, repoRoot) || !pathInside(repoRoot, absolutePath)) return null;
  const repoPath = relative(repoRoot, absolutePath).replaceAll("\\", "/") || ".";
  return { root: repoRoot, path: repoPath };
}

function addRepoPath(repos: Map<string, RepoWork>, root: string, path: string): void {
  const work = repos.get(root) ?? { root, paths: new Set<string>() };
  work.paths.add(path);
  repos.set(root, work);
}

function addSuperprojects(coordRoot: string, repos: Map<string, RepoWork>, leafRoot: string): void {
  let childRoot = leafRoot;
  for (;;) {
    const result = git(["rev-parse", "--show-superproject-working-tree"], childRoot);
    if (result.status !== 0 || result.stdout.trim().length === 0) return;
    const parentRoot = resolve(result.stdout.trim());
    if (!pathInside(coordRoot, parentRoot) || parentRoot === childRoot) return;
    const gitlink = relative(parentRoot, childRoot).replaceAll("\\", "/");
    addRepoPath(repos, parentRoot, gitlink);
    childRoot = parentRoot;
  }
}

function repoHasRemote(repoRoot: string): boolean {
  const result = git(["remote"], repoRoot);
  return result.status === 0 && result.stdout.trim().length > 0;
}

function repoSyncState(repoRoot: string): "synced" | "unpushed" | "unverifiable" {
  if (!repoHasRemote(repoRoot)) return "synced";
  if (git(["rev-parse", "--verify", "HEAD"], repoRoot).status !== 0) return "unverifiable";

  const upstream = git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    repoRoot,
  );
  if (upstream.status === 0) {
    const ahead = git(["rev-list", "--count", "@{upstream}..HEAD"], repoRoot);
    if (ahead.status !== 0) return "unverifiable";
    return Number.parseInt(ahead.stdout.trim(), 10) > 0 ? "unpushed" : "synced";
  }

  // Detached submodules commonly have no upstream. A remote ref containing
  // HEAD proves that commit is available elsewhere without requiring a branch.
  const containing = git(
    ["branch", "--remotes", "--contains", "HEAD", "--format=%(refname:short)"],
    repoRoot,
  );
  if (containing.status !== 0) return "unverifiable";
  return containing.stdout.trim().length > 0 ? "synced" : "unpushed";
}

/** Check that this session's held paths are committed and their repositories are pushed. */
export function checkGitFinalization(
  coordRoot: string,
  heldPaths: readonly string[],
  options: { claimHistoryComplete?: boolean } = {},
): GitFinalizationResult {
  const root = resolve(coordRoot);
  const repos = new Map<string, RepoWork>();
  const unverifiablePaths: string[] = [];

  for (const heldPath of heldPaths) {
    const discovered = discoverRepo(root, heldPath);
    if (!discovered) {
      unverifiablePaths.push(heldPath);
      continue;
    }
    addRepoPath(repos, discovered.root, discovered.path);
    addSuperprojects(root, repos, discovered.root);
  }

  const dirtyPaths = new Set<string>();
  const unpushedRepos: string[] = [];
  const unverifiableRepos: string[] = [];

  for (const work of repos.values()) {
    for (const repoPath of work.paths) {
      const status = git(
        ["status", "--porcelain=v1", "--untracked-files=all", "--", repoPath],
        work.root,
      );
      if (status.status !== 0) {
        unverifiablePaths.push(join(repoLabel(root, work.root), repoPath).replaceAll("\\", "/"));
      } else if (status.stdout.length > 0) {
        const label = repoLabel(root, work.root);
        dirtyPaths.add(label === "." ? repoPath : `${label}/${repoPath}`);
      }
    }

    const syncState = repoSyncState(work.root);
    const label = repoLabel(root, work.root);
    if (syncState === "unpushed") unpushedRepos.push(label);
    if (syncState === "unverifiable") unverifiableRepos.push(label);
  }

  const result: GitFinalizationResult = {
    ok: false,
    claim_history_complete: options.claimHistoryComplete ?? true,
    dirty_paths: [...dirtyPaths].sort(),
    unpushed_repos: [...new Set(unpushedRepos)].sort(),
    unverifiable_paths: [...new Set(unverifiablePaths)].sort(),
    unverifiable_repos: [...new Set(unverifiableRepos)].sort(),
    repos_checked: [...repos.keys()].map((repo) => repoLabel(root, repo)).sort(),
  };
  result.ok =
    result.claim_history_complete &&
    result.dirty_paths.length === 0 &&
    result.unpushed_repos.length === 0 &&
    result.unverifiable_paths.length === 0 &&
    result.unverifiable_repos.length === 0;
  return result;
}

export function formatGitFinalizationFailure(result: GitFinalizationResult, bin: string): string {
  const lines = ["Owned Git work is not finalized; the status box was not issued."];
  if (!result.claim_history_complete) {
    lines.push("This session's write-claim history is older than the bounded event window.");
  }
  if (result.dirty_paths.length > 0) {
    lines.push("Dirty owned paths:", ...result.dirty_paths.map((path) => `  - ${path}`));
  }
  if (result.unpushed_repos.length > 0) {
    lines.push(
      "Repositories with commits not on their remote:",
      ...result.unpushed_repos.map((repo) => `  - ${repo}`),
    );
  }
  if (result.unverifiable_paths.length > 0) {
    lines.push(
      "Paths whose Git state could not be verified:",
      ...result.unverifiable_paths.map((path) => `  - ${path}`),
    );
  }
  if (result.unverifiable_repos.length > 0) {
    lines.push(
      "Repositories whose remote state could not be verified:",
      ...result.unverifiable_repos.map((repo) => `  - ${repo}`),
    );
  }
  lines.push(`Commit and push the owned work, then rerun \`${bin} agents status --final\`.`);
  return lines.join("\n");
}
