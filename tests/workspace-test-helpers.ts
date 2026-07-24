import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

let sequence = 0;
let replacementSequence = 0;

export function tempRoot(label: string): string {
  return mkdtempSync(join("/tmp", `${label}-`));
}

export function hasGit(): boolean {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

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

export function writeScript(root: string, body: string): string {
  const dir = join(root, "scripts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `workflow-${++sequence}.mjs`);
  writeFileSync(path, body, "utf8");
  return path;
}

export function replaceSourceCheckout(root: string): () => void {
  const priorRoot = `${root}-frozen-${++replacementSequence}`;
  renameSync(root, priorRoot);
  mkdirSync(root);
  for (const entry of readdirSync(priorRoot)) {
    renameSync(join(priorRoot, entry), join(root, entry));
  }
  return () => {
    for (const entry of readdirSync(root)) {
      renameSync(join(root, entry), join(priorRoot, entry));
    }
    rmSync(root, { recursive: true, force: true });
    renameSync(priorRoot, root);
  };
}

export const quiet = {
  onLog: () => {},
  probeBilling: (harness: string) => ({
    harness,
    apiKeySource: null,
    apiKeyPresent: false,
    login: "present" as const,
    mode: "subscription" as const,
  }),
};
