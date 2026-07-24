import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

export type GitResult = { ok: true; out: string } | { ok: false; err: string };

export function git(cwd: string, args: readonly string[]): string {
  const result = gitMaybe(cwd, args);
  if (!result.ok) throw new Error(result.err || `git ${args.join(" ")} failed`);
  return result.out;
}

export function gitMaybe(cwd: string, args: readonly string[]): GitResult {
  return runGit(cwd, args);
}

export function gitMaybeWithDirectoryDescriptor(
  cwd: string,
  args: readonly string[],
  fd: number,
): GitResult {
  const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "pipe", "pipe"];
  while (stdio.length <= fd) stdio.push("ignore");
  stdio[fd] = fd;
  return runGit(cwd, args, stdio);
}

export function worktreeInventory(
  cwd: string,
): Array<{ path: string; ref?: string; head?: string }> {
  return parseWorktreeInventory(git(cwd, ["worktree", "list", "--porcelain"]));
}

export function parseWorktreeInventory(
  body: string,
): Array<{ path: string; ref?: string; head?: string }> {
  const entries: Array<{ path: string; ref?: string; head?: string }> = [];
  let current: { path: string; ref?: string; head?: string } | undefined;
  const fields = body.includes("\0") ? body.split("\0") : body.split("\n");
  for (const field of fields) {
    if (field.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: field.slice("worktree ".length) };
    } else if (current && field.startsWith("HEAD ")) {
      current.head = field.slice("HEAD ".length);
    } else if (current && field.startsWith("branch ")) {
      current.ref = field.slice("branch ".length);
    }
  }
  if (current) entries.push(current);
  return entries;
}

export function gitOperations(cwd: string): string[] {
  const gitDir = realpathSync(resolve(cwd, git(cwd, ["rev-parse", "--git-dir"])));
  const candidates: Array<[string, string]> = [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_LOG", "bisect"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
  ];
  return [
    ...new Set(
      candidates.filter(([entry]) => existsSync(join(gitDir, entry))).map(([, name]) => name),
    ),
  ];
}

export function overwriteRiskPaths(cwd: string, changed: readonly string[]): string[] {
  const untracked = nulEntries(git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]));
  const ignored = nulEntries(
    git(cwd, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]),
  );
  const candidates = new Set([...untracked, ...ignored]);
  return changed.filter((path) => candidates.has(path));
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return gitMaybe(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;
}

export function nulEntries(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function runGit(
  cwd: string,
  args: readonly string[],
  stdio?: Array<"ignore" | "pipe" | number>,
): GitResult {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: isolatedGitEnvironment(),
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: GIT_TIMEOUT_MS,
    stdio,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      err: (result.stderr || result.stdout || result.error?.message || "git failed").trim(),
    };
  }
  return { ok: true, out: result.stdout.replace(/\n$/, "") };
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GCM_INTERACTIVE = "Never";
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "core.hooksPath";
  env.GIT_CONFIG_VALUE_0 = process.platform === "win32" ? "NUL" : "/dev/null";
  return env;
}
