/**
 * Ownership-aware Git completion checks for the end-of-turn status ritual.
 *
 * The heartbeat's durable `files_touched` ledger is the ownership boundary. We
 * inspect only those paths, plus any enclosing submodule gitlinks, so a peer's
 * active edits elsewhere in a shared checkout do not block this session.
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type AgentFinalizationDisposition, agentsFinalizationRoots } from "../config.ts";
import { readFinalizationScopeV3 } from "../events/v3/finalization-view.ts";
import { liveInstanceIdV3, resolveLiveEventLedgerRouteV3 } from "../events/v3/live-routing.ts";

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
  gitlinks: Set<string>;
}

export interface GitFinalizationResult {
  ok: boolean;
  claim_history_complete: boolean;
  dirty_paths: string[];
  unpushed_repos: string[];
  behind_repos: string[];
  stale_submodules: string[];
  diverged_submodules: string[];
  host_output_paths: string[];
  unsupported_paths: UnsupportedFinalizationPath[];
  unverifiable_paths: string[];
  unverifiable_repos: string[];
  repos_checked: string[];
}

export type UnsupportedFinalizationReason =
  | "outside_finalization_roots"
  | "invalid_finalization_root"
  | "ambiguous_finalization_roots"
  | "path_escapes_finalization_root"
  | "git_repository_unavailable"
  | "output_path_is_git";

export interface UnsupportedFinalizationPath {
  path: string;
  reason: UnsupportedFinalizationReason;
}

export interface ClaimFinalizationDescriptor {
  disposition: AgentFinalizationDisposition;
  root: string;
}

export type ClaimFinalizationDecision =
  | {
      allow: true;
      path: string;
      descriptor: ClaimFinalizationDescriptor;
      authorityRoot: string;
      repo?: { root: string; path: string };
    }
  | {
      allow: false;
      path: string;
      reason: UnsupportedFinalizationReason;
    };

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
  _sessionId: string,
): SessionWriteClaims {
  const route = resolveLiveEventLedgerRouteV3(coordRoot);
  if (route.state === "blocked") return { paths: [], complete: false };
  try {
    const scope = readFinalizationScopeV3(coordRoot, liveInstanceIdV3(instanceId));
    return { paths: scope.files_touched, complete: true };
  } catch {
    return { paths: [], complete: false };
  }
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

function existingProbeDir(authorityRoot: string, absolutePath: string): string | null {
  let current = absolutePath;
  if (existsSync(current) && !statSync(current).isDirectory()) current = dirname(current);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current || !pathInside(authorityRoot, parent)) return null;
    current = parent;
  }
  return pathInside(authorityRoot, current) ? current : null;
}

/** Resolve existing ancestors through symlinks while preserving a missing tail. */
function physicalPath(absolutePath: string): string | null {
  let existing = absolutePath;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return null;
    existing = parent;
  }
  try {
    const physical = realpathSync.native(existing);
    const tail = relative(existing, absolutePath);
    return resolve(physical, tail);
  } catch {
    return null;
  }
}

/**
 * Translate a Windows-native WSL UNC claim back to the Linux path seen by the
 * coordination process. Codex can report `\\\\wsl.localhost\\<distro>\\...`
 * while Harnery runs inside that distro with a `/...` coord root.
 */
function resolveHeldPath(coordRoot: string, heldPath: string): string {
  const wslUnc = /^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+\\(.+)$/i.exec(heldPath);
  if (wslUnc) {
    const linuxPath = `/${wslUnc[1]!.replaceAll("\\", "/")}`;
    const slashRoot = coordRoot.replaceAll("\\", "/");
    if (slashRoot.startsWith("/") || pathInside(coordRoot, linuxPath)) return linuxPath;
  }
  return resolve(coordRoot, heldPath);
}

function discoverRepo(
  authorityRoot: string,
  absolutePath: string,
): { root: string; path: string } | null {
  const probeDir = existingProbeDir(authorityRoot, absolutePath);
  if (!probeDir) return null;
  const rootResult = git(["rev-parse", "--show-toplevel"], probeDir);
  if (rootResult.status !== 0) return null;
  const repoRoot = physicalPath(resolve(rootResult.stdout.trim()));
  if (!repoRoot || !pathInside(authorityRoot, repoRoot) || !pathInside(repoRoot, absolutePath)) {
    return null;
  }
  const repoPath = relative(repoRoot, absolutePath).replaceAll("\\", "/") || ".";
  return { root: repoRoot, path: repoPath };
}

interface FinalizationRoot {
  configuredPath: string;
  disposition: AgentFinalizationDisposition;
  lexicalRoot: string;
  physicalRoot: string | null;
  invalid: boolean;
}

function rootIsGitRepository(root: string): boolean {
  if (!existsSync(root) || !statSync(root).isDirectory()) return false;
  const result = git(["rev-parse", "--show-toplevel"], root);
  if (result.status !== 0) return false;
  const discovered = physicalPath(resolve(result.stdout.trim()));
  const physicalRoot = physicalPath(root);
  return discovered !== null && physicalRoot !== null && discovered === physicalRoot;
}

function outputRootIsInsideGit(root: string): boolean {
  let probe = root;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  if (!statSync(probe).isDirectory()) probe = dirname(probe);
  return git(["rev-parse", "--show-toplevel"], probe).status === 0;
}

function finalizationRoots(coordRoot: string): FinalizationRoot[] {
  const root = resolve(coordRoot);
  const configured = agentsFinalizationRoots(root).map((entry) => {
    const lexicalRoot = resolveHeldPath(root, entry.path);
    const physicalRoot = physicalPath(lexicalRoot);
    const invalid =
      physicalRoot === null ||
      (entry.disposition === "git"
        ? !rootIsGitRepository(physicalRoot)
        : outputRootIsInsideGit(physicalRoot));
    return {
      configuredPath: entry.path,
      disposition: entry.disposition,
      lexicalRoot,
      physicalRoot,
      invalid,
    } satisfies FinalizationRoot;
  });

  const rootPhysical = physicalPath(root);
  if (rootPhysical && rootIsGitRepository(rootPhysical)) {
    configured.push({
      configuredPath: ".",
      disposition: "git",
      lexicalRoot: root,
      physicalRoot: rootPhysical,
      invalid: false,
    });
  }

  for (const current of configured) {
    if (!current.physicalRoot) continue;
    for (const peer of configured) {
      if (current === peer || !peer.physicalRoot || current.disposition === peer.disposition) {
        continue;
      }
      if (
        pathInside(current.physicalRoot, peer.physicalRoot) ||
        pathInside(peer.physicalRoot, current.physicalRoot)
      ) {
        current.invalid = true;
        peer.invalid = true;
      }
    }
  }

  return configured;
}

/**
 * Resolve one guarded write to the host's single supported end-turn
 * disposition. Claim event data never grants authority: every call starts from
 * the project-owned finalization roots and only then inspects the selected
 * repository or output tree.
 */
export function classifyWriteClaimFinalization(
  coordRoot: string,
  heldPath: string,
): ClaimFinalizationDecision {
  const root = resolve(coordRoot);
  const absolutePath = resolveHeldPath(root, heldPath);
  const roots = finalizationRoots(root);
  const lexicalMatches = roots.filter((entry) => pathInside(entry.lexicalRoot, absolutePath));
  if (lexicalMatches.length === 0) {
    return { allow: false, path: heldPath, reason: "outside_finalization_roots" };
  }
  if (lexicalMatches.some((entry) => entry.invalid)) {
    return { allow: false, path: heldPath, reason: "invalid_finalization_root" };
  }

  const physical = physicalPath(absolutePath);
  if (!physical) {
    return { allow: false, path: heldPath, reason: "path_escapes_finalization_root" };
  }
  const matches = lexicalMatches.filter(
    (entry) => entry.physicalRoot && pathInside(entry.physicalRoot, physical),
  );
  if (matches.length === 0) {
    return { allow: false, path: heldPath, reason: "path_escapes_finalization_root" };
  }
  const dispositions = new Set(matches.map((entry) => entry.disposition));
  if (dispositions.size !== 1) {
    return { allow: false, path: heldPath, reason: "ambiguous_finalization_roots" };
  }
  const selected = [...matches].sort(
    (a, b) => (b.physicalRoot?.length ?? 0) - (a.physicalRoot?.length ?? 0),
  )[0]!;
  const normalizedPath = relative(root, absolutePath).replaceAll("\\", "/") || ".";
  const descriptor: ClaimFinalizationDescriptor = {
    disposition: selected.disposition,
    root: selected.configuredPath,
  };

  if (selected.disposition === "output") {
    const probe = existingProbeDir(selected.physicalRoot!, physical);
    if (probe && git(["rev-parse", "--show-toplevel"], probe).status === 0) {
      return { allow: false, path: heldPath, reason: "output_path_is_git" };
    }
    return {
      allow: true,
      path: normalizedPath,
      descriptor,
      authorityRoot: selected.physicalRoot!,
    };
  }

  const repo = discoverRepo(selected.physicalRoot!, physical);
  if (!repo) {
    return { allow: false, path: heldPath, reason: "git_repository_unavailable" };
  }
  return {
    allow: true,
    path: normalizedPath,
    descriptor,
    authorityRoot: selected.physicalRoot!,
    repo,
  };
}

function addRepoPath(
  repos: Map<string, RepoWork>,
  root: string,
  path: string,
  gitlink = false,
): void {
  const work = repos.get(root) ?? {
    root,
    paths: new Set<string>(),
    gitlinks: new Set<string>(),
  };
  work.paths.add(path);
  if (gitlink) work.gitlinks.add(path);
  repos.set(root, work);
}

function addSuperprojects(
  authorityRoot: string,
  repos: Map<string, RepoWork>,
  leafRoot: string,
): void {
  let childRoot = leafRoot;
  for (;;) {
    const result = git(["rev-parse", "--show-superproject-working-tree"], childRoot);
    if (result.status !== 0 || result.stdout.trim().length === 0) return;
    const parentRoot = physicalPath(resolve(result.stdout.trim()));
    if (!parentRoot || !pathInside(authorityRoot, parentRoot) || parentRoot === childRoot) return;
    const gitlink = relative(parentRoot, childRoot).replaceAll("\\", "/");
    addRepoPath(repos, parentRoot, gitlink, true);
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

function repoIsBehindUpstream(repoRoot: string): boolean {
  if (!repoHasRemote(repoRoot)) return false;
  const upstream = git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    repoRoot,
  );
  if (upstream.status !== 0) return false;
  const behind = git(["rev-list", "--count", "HEAD..@{upstream}"], repoRoot);
  return behind.status === 0 && Number.parseInt(behind.stdout.trim(), 10) > 0;
}

function rootSubmoduleFreshness(repoRoot: string): {
  stale: string[];
  diverged: string[];
} {
  const modules = git(
    ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    repoRoot,
  );
  if (modules.status !== 0 || modules.stdout.trim().length === 0) {
    return { stale: [], diverged: [] };
  }

  const stale: string[] = [];
  const diverged: string[] = [];
  for (const line of modules.stdout.trim().split("\n")) {
    const path = line.trim().split(/\s+/).at(-1);
    if (!path) continue;
    const target = git(["rev-parse", `HEAD:${path}`], repoRoot);
    const checkout = git(["rev-parse", "HEAD"], join(repoRoot, path));
    if (target.status !== 0 || checkout.status !== 0) {
      stale.push(path);
      continue;
    }
    const targetSha = target.stdout.trim();
    const checkoutSha = checkout.stdout.trim();
    if (targetSha === checkoutSha) continue;

    const checkoutBehind = git(
      ["merge-base", "--is-ancestor", checkoutSha, targetSha],
      join(repoRoot, path),
    );
    if (checkoutBehind.status === 0) {
      stale.push(path);
      continue;
    }
    const checkoutAhead = git(
      ["merge-base", "--is-ancestor", targetSha, checkoutSha],
      join(repoRoot, path),
    );
    // A checkout ahead of its gitlink is in-flight local work. Its owning
    // session is responsible for the eventual pointer bump; unrelated turns
    // must not be blocked globally while that work is active.
    if (checkoutAhead.status !== 0) diverged.push(path);
  }
  return { stale: stale.sort(), diverged: diverged.sort() };
}

/** Compare gitlink commits without treating dirty contents inside the child as a pointer change. */
function gitlinkIsDirty(parentRoot: string, gitlink: string): boolean {
  const head = git(["rev-parse", `HEAD:${gitlink}`], parentRoot);
  const index = git(["ls-files", "--stage", "--", gitlink], parentRoot);
  const child = git(["rev-parse", "HEAD"], join(parentRoot, gitlink));
  if (head.status !== 0 || index.status !== 0 || child.status !== 0) return true;
  const indexMatch = /^160000 ([0-9a-f]{40}) 0\t/.exec(index.stdout.trim());
  if (!indexMatch) return true;
  return head.stdout.trim() !== indexMatch[1] || child.stdout.trim() !== indexMatch[1];
}

/** Check that this session's held paths are committed and their repositories are pushed. */
export function checkGitFinalization(
  coordRoot: string,
  heldPaths: readonly string[],
  options: { claimHistoryComplete?: boolean } = {},
): GitFinalizationResult {
  const root = resolve(coordRoot);
  const repos = new Map<string, RepoWork>();
  const hostOutputPaths = new Set<string>();
  const unsupportedPaths: UnsupportedFinalizationPath[] = [];
  const unverifiablePaths: string[] = [];

  for (const heldPath of heldPaths) {
    const decision = classifyWriteClaimFinalization(root, heldPath);
    if (!decision.allow) {
      unsupportedPaths.push({ path: heldPath, reason: decision.reason });
      continue;
    }
    if (decision.descriptor.disposition === "output") {
      hostOutputPaths.add(decision.path);
      continue;
    }
    if (!decision.repo) {
      unsupportedPaths.push({ path: heldPath, reason: "git_repository_unavailable" });
      continue;
    }
    addRepoPath(repos, decision.repo.root, decision.repo.path);
    addSuperprojects(decision.authorityRoot, repos, decision.repo.root);
  }

  const dirtyPaths = new Set<string>();
  const unpushedRepos: string[] = [];
  const unverifiableRepos: string[] = [];

  for (const work of repos.values()) {
    for (const repoPath of work.paths) {
      if (work.gitlinks.has(repoPath)) {
        if (gitlinkIsDirty(work.root, repoPath)) {
          const label = repoLabel(root, work.root);
          dirtyPaths.add(label === "." ? repoPath : `${label}/${repoPath}`);
        }
        continue;
      }
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

  const behindRepos = repoIsBehindUpstream(root) ? ["."] : [];
  const submoduleFreshness = rootSubmoduleFreshness(root);

  const result: GitFinalizationResult = {
    ok: false,
    claim_history_complete: options.claimHistoryComplete ?? true,
    dirty_paths: [...dirtyPaths].sort(),
    unpushed_repos: [...new Set(unpushedRepos)].sort(),
    behind_repos: behindRepos,
    stale_submodules: submoduleFreshness.stale,
    diverged_submodules: submoduleFreshness.diverged,
    host_output_paths: [...hostOutputPaths].sort(),
    unsupported_paths: unsupportedPaths.sort(
      (a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason),
    ),
    unverifiable_paths: [...new Set(unverifiablePaths)].sort(),
    unverifiable_repos: [...new Set(unverifiableRepos)].sort(),
    repos_checked: [...repos.keys()].map((repo) => repoLabel(root, repo)).sort(),
  };
  result.ok =
    result.claim_history_complete &&
    result.dirty_paths.length === 0 &&
    result.unpushed_repos.length === 0 &&
    result.behind_repos.length === 0 &&
    result.stale_submodules.length === 0 &&
    result.diverged_submodules.length === 0 &&
    result.unsupported_paths.length === 0 &&
    result.unverifiable_paths.length === 0 &&
    result.unverifiable_repos.length === 0;
  return result;
}

export function formatGitFinalizationFailure(result: GitFinalizationResult, bin: string): string {
  const lines = ["Owned work is not finalized; the status box was not issued."];
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
  if (result.behind_repos.length > 0) {
    lines.push(
      "Repositories behind their upstream:",
      ...result.behind_repos.map((repo) => `  - ${repo}`),
    );
  }
  if (result.stale_submodules.length > 0) {
    lines.push(
      "Submodule checkouts behind their parent gitlinks:",
      ...result.stale_submodules.map((path) => `  - ${path}`),
    );
  }
  if (result.diverged_submodules.length > 0) {
    lines.push(
      "Submodule checkouts diverged from their parent gitlinks:",
      ...result.diverged_submodules.map((path) => `  - ${path}`),
    );
  }
  if (result.unsupported_paths.length > 0) {
    lines.push(
      "Paths without an authorized end-turn disposition:",
      ...result.unsupported_paths.map(
        ({ path, reason }) => `  - ${path}: ${unsupportedReasonMessage(reason)}`,
      ),
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
  if (
    result.dirty_paths.length > 0 ||
    result.unpushed_repos.length > 0 ||
    result.behind_repos.length > 0 ||
    result.stale_submodules.length > 0 ||
    result.diverged_submodules.length > 0 ||
    result.unverifiable_paths.length > 0 ||
    result.unverifiable_repos.length > 0
  ) {
    lines.push(
      `Commit and push the owned Git work, then rerun \`${bin} agents status --end-turn\`.`,
    );
  }
  if (
    result.behind_repos.length > 0 ||
    result.stale_submodules.length > 0 ||
    result.diverged_submodules.length > 0
  ) {
    lines.push(
      "Run the host repository's safe sync command, resolve any reported submodule state, then rerun the guarded status.",
    );
  }
  if (result.unsupported_paths.length > 0) {
    lines.push(
      "For a legacy claim, add the containing Git repository or intentional non-Git output root to the project's `agents.finalizationRoots`, then rerun the guarded status. For new work, start the task from the target Git project or configure that root before editing.",
    );
  }
  return lines.join("\n");
}

function unsupportedReasonMessage(reason: UnsupportedFinalizationReason): string {
  switch (reason) {
    case "outside_finalization_roots":
      return "outside the coordination repository and project-configured finalization roots";
    case "invalid_finalization_root":
      return "the matching project-configured root is invalid or overlaps another disposition";
    case "ambiguous_finalization_roots":
      return "more than one finalization disposition matches this path";
    case "path_escapes_finalization_root":
      return "the resolved path escapes its configured root";
    case "git_repository_unavailable":
      return "the configured Git root does not contain a verifiable repository for this path";
    case "output_path_is_git":
      return "the configured non-Git output path is inside a Git repository";
  }
}

export function formatWriteClaimFinalizationDenial(
  decision: Extract<ClaimFinalizationDecision, { allow: false }>,
  bin: string,
): string {
  return (
    `Harnery denied the write to ${decision.path} before mutation: ` +
    `${unsupportedReasonMessage(decision.reason)}. ` +
    "Start the task from the target Git project, or add its Git repository root " +
    "(or an intentional non-Git output root) to the project's `agents.finalizationRoots` " +
    `before editing. Then retry the tool and finish with \`${bin} agents status --end-turn\`.`
  );
}
