/**
 * The few Git reads self-update needs. Every call is synchronous, bounded by a
 * timeout, and goes through an injectable runner so tests never touch a
 * network remote.
 */

import { spawnSync } from "node:child_process";

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], opts: { cwd: string; timeoutMs: number }) => GitResult;

const LOCAL_TIMEOUT_MS = 10_000;
const REMOTE_TIMEOUT_MS = 15_000;

export const defaultGitRunner: GitRunner = (args, opts) => {
  const result = spawnSync("git", args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    windowsHide: true,
    // Never block a background run on a credential prompt.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    status: result.error ? null : result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
};

function read(
  run: GitRunner,
  root: string,
  args: string[],
  timeoutMs = LOCAL_TIMEOUT_MS,
): string | null {
  const result = run(args, { cwd: root, timeoutMs });
  if (result.status !== 0) return null;
  const out = result.stdout.trim();
  return out || null;
}

export function head(root: string, run: GitRunner = defaultGitRunner): string | null {
  return read(run, root, ["rev-parse", "HEAD"]);
}

export interface Upstream {
  remote: string;
  branch: string;
  /** e.g. `origin/main`. */
  display: string;
}

/** The current branch's upstream, or null when detached or untracked. */
export function upstream(root: string, run: GitRunner = defaultGitRunner): Upstream | null {
  const display = read(run, root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!display) return null;
  const current = read(run, root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (current) {
    const remote = read(run, root, ["config", "--get", `branch.${current}.remote`]);
    const merge = read(run, root, ["config", "--get", `branch.${current}.merge`]);
    if (remote && merge) {
      return { remote, branch: merge.replace(/^refs\/heads\//, ""), display };
    }
  }
  const slash = display.indexOf("/");
  if (slash <= 0) return null;
  return { remote: display.slice(0, slash), branch: display.slice(slash + 1), display };
}

/** The remote branch's sha, or null when the remote cannot be reached or lacks the branch. */
export function lsRemote(
  root: string,
  remote: string,
  branch: string,
  run: GitRunner = defaultGitRunner,
): string | null {
  const out = read(
    run,
    root,
    ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`],
    REMOTE_TIMEOUT_MS,
  );
  if (!out) return null;
  const sha = out.split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** True when `sha` exists locally and is an ancestor of HEAD. */
export function contains(root: string, sha: string, run: GitRunner = defaultGitRunner): boolean {
  const exists = run(["cat-file", "-e", `${sha}^{commit}`], {
    cwd: root,
    timeoutMs: LOCAL_TIMEOUT_MS,
  });
  if (exists.status !== 0) return false;
  const ancestor = run(["merge-base", "--is-ancestor", sha, "HEAD"], {
    cwd: root,
    timeoutMs: LOCAL_TIMEOUT_MS,
  });
  return ancestor.status === 0;
}

export function changedFiles(
  root: string,
  from: string,
  to: string,
  run: GitRunner = defaultGitRunner,
): string[] {
  const out = read(run, root, ["diff", "--name-only", from, to]);
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
