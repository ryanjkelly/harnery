/**
 * Git-plumbing collection for `agent-coord git-hook <event>` — the in-process
 * replacement for the bash that host pre-commit / post-commit / post-checkout
 * hooks used to carry.
 *
 * Everything here is a port of hook logic that lived in host repos as shell:
 * staged-path collection with rename handling, submodule canonicalization,
 * the gitlink probe, and the clean-in-worktree checks that gate claim pruning.
 * Owning it here means a harnery upgrade upgrades the behavior; the host hook
 * file keeps only a stable managed region that invokes `git-hook <event>`.
 *
 * All functions take an explicit cwd and return data — no printing, no
 * process.exit — so they unit-test against a temp repo.
 */

import { spawnSync } from "node:child_process";

export type GitHookEvent = "pre-commit" | "post-commit" | "post-checkout";

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? (r.stdout ?? "") : "";
}

/**
 * The coordination root for a hook firing in `cwd`: the superproject when the
 * repo is a submodule, else the repo's own toplevel. Pinning to the
 * superproject matters because some submodules carry a config-only `.harnery/`
 * that a cwd walk would land on, running the check against an empty claims dir.
 */
export function discoverCoordRoot(cwd: string): string | null {
  const superproject = git(["rev-parse", "--show-superproject-working-tree"], cwd).trim();
  if (superproject) return superproject;
  const toplevel = git(["rev-parse", "--show-toplevel"], cwd).trim();
  return toplevel || null;
}

/** Monorepo-relative prefix when `cwd` is inside a submodule ("" in the parent). */
export function submodulePrefix(cwd: string): string {
  const superproject = git(["rev-parse", "--show-superproject-working-tree"], cwd).trim();
  if (!superproject) return "";
  const toplevel = git(["rev-parse", "--show-toplevel"], cwd).trim();
  if (!toplevel.startsWith(`${superproject}/`)) return "";
  return toplevel.slice(superproject.length + 1);
}

/**
 * Parse `--name-status -M` output into repo-local paths. Renames/copies emit
 * BOTH sides so the source's claim releases too; plain statuses emit one.
 */
export function parseNameStatus(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (/^[RC]/.test(status)) {
      if (parts[1]) paths.push(parts[1]);
      if (parts[2]) paths.push(parts[2]);
    } else if (parts[1]) {
      paths.push(parts[1]);
    }
  }
  return paths;
}

function canonicalize(paths: string[], prefix: string): string[] {
  return prefix ? paths.map((p) => `${prefix}/${p}`) : [...paths];
}

/** Is this repo-local path a submodule gitlink (mode 160000) in the index? */
function isGitlink(path: string, cwd: string): boolean {
  return git(["ls-files", "--stage", "--", path], cwd).startsWith("160000 ");
}

/** Is this repo-local path clean in the worktree (no unstaged residue)? */
function isCleanInWorktree(path: string, cwd: string): boolean {
  return git(["status", "--porcelain", "--", path], cwd).trim() === "";
}

/**
 * pre-commit: staged paths (canonical, monorepo-relative) plus which of them
 * are submodule gitlinks — a parent-repo pointer bump is not a claim on the
 * submodule's contents, and the conflict rule's prefix matcher needs to know.
 */
export function collectStaged(cwd: string): { staged: string[]; gitlinks: string[] } {
  const out = git(["diff", "--cached", "--name-status", "-M"], cwd);
  const local = parseNameStatus(out);
  const prefix = submodulePrefix(cwd);
  const staged = canonicalize(local, prefix);
  const gitlinks: string[] = [];
  for (let i = 0; i < local.length; i++) {
    const l = local[i]!;
    if (isGitlink(l, cwd)) gitlinks.push(staged[i]!);
  }
  return { staged, gitlinks };
}

/**
 * post-commit: paths the just-landed HEAD commit touched that are now clean in
 * the worktree. A path with unstaged residue keeps its claim — the agent is
 * still mid-work on it.
 */
export function collectCommitted(cwd: string): string[] {
  // --root: a repo's first commit has no parent; without it diff-tree emits
  // nothing and the root commit's claims never prune (a bash-era blind spot).
  const out = git(
    ["diff-tree", "--no-commit-id", "--name-status", "-M", "-r", "--root", "HEAD"],
    cwd,
  );
  const local = parseNameStatus(out).filter((p) => isCleanInWorktree(p, cwd));
  return canonicalize(local, submodulePrefix(cwd));
}

/**
 * post-checkout: paths the ref move rewrote that are now clean — a checkout
 * that discarded an agent's edits should release its claims so a peer's later
 * Edit isn't falsely blocked. `oldRef`/`newRef` are the hook's $1/$2.
 */
export function collectCheckoutRemoved(cwd: string, oldRef: string, newRef: string): string[] {
  const from = oldRef || "0000000000000000000000000000000000000000";
  const to = newRef || "HEAD";
  const out = git(["diff", "--name-status", "-M", from, to], cwd);
  const local = parseNameStatus(out).filter((p) => isCleanInWorktree(p, cwd));
  return canonicalize(local, submodulePrefix(cwd));
}
