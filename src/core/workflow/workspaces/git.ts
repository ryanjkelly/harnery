import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    windowsHide: true,
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
  // Git for Windows sets core.autocrlf in its system config, and checkouts made
  // under it have CRLF files; skipping the system config would make them look
  // modified. Keep only that value, at system level, so a user's global or
  // repository setting still overrides it as usual.
  const systemConfig = minimalSystemConfig();
  if (systemConfig) env.GIT_CONFIG_SYSTEM = systemConfig;
  else env.GIT_CONFIG_NOSYSTEM = "1";
  env.GCM_INTERACTIVE = "Never";
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "core.hooksPath";
  env.GIT_CONFIG_VALUE_0 = process.platform === "win32" ? "NUL" : "/dev/null";
  return env;
}

let cachedSystemConfig: string | null | undefined;

/** A system config holding only core.autocrlf (Windows, when set); null otherwise. */
function minimalSystemConfig(): string | null {
  if (cachedSystemConfig !== undefined) return cachedSystemConfig;
  cachedSystemConfig = null;
  const autocrlf = systemAutocrlf();
  if (!autocrlf) return null;
  const path = join(tmpdir(), `harnery-git-system-autocrlf-${autocrlf.toLowerCase()}.gitconfig`);
  try {
    writeFileSync(path, `[core]\n\tautocrlf = ${autocrlf}\n`, "utf8");
    cachedSystemConfig = path;
  } catch {
    // Without the file, fall back to skipping the system config entirely.
  }
  return cachedSystemConfig;
}

let cachedAutocrlf: string | null | undefined;

/** The system-level core.autocrlf on Windows (read once per process); null elsewhere. */
function systemAutocrlf(): string | null {
  if (process.platform !== "win32") return null;
  if (cachedAutocrlf !== undefined) return cachedAutocrlf;
  const result = spawnSync("git", ["config", "--system", "--get", "core.autocrlf"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  cachedAutocrlf = /^(true|false|input)$/i.test(value) ? value : null;
  return cachedAutocrlf;
}
