import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The system temp dir is itself a symlink on some platforms (macOS: /tmp ->
// private/tmp), so resolve it once and hand tests a root that is already its
// own realpath.
const TEMP_BASE = realpathSync(tmpdir());

export function tempRoot(label: string): string {
  return mkdtempSync(join(TEMP_BASE, `${label}-`));
}

export function hasGit(): boolean {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A one-commit repository under a fresh temp host directory. */
export function gitFixture(label: string): { host: string; repo: string } {
  const host = tempRoot(label);
  const repo = join(host, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, ".git", "info", "exclude"), ".harnery/\n");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "base");
  return { host: resolve(host), repo: resolve(repo) };
}
