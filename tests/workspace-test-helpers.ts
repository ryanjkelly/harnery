import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { descriptorBackedPathsSupported } from "../src/core/workflow/workspaces/paths.ts";

let sequence = 0;
let replacementSequence = 0;

// Workspace roots are validated with `validateConfiguredRoot`, which rejects a
// root containing symlink components so a workspace's path authority cannot be
// redirected under it. The system temp dir is itself a symlink on some platforms
// (macOS: /tmp -> private/tmp, /var -> private/var), so resolve it once here and
// hand workspace code a root that is already its own realpath.
const TEMP_BASE = realpathSync(tmpdir());

export function tempRoot(label: string): string {
  return mkdtempSync(join(TEMP_BASE, `${label}-`));
}

export function hasGit(): boolean {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

/**
 * Whether this host can serve a real isolated workspace allocation.
 *
 * The local Git worktree provider walks into a workspace through inherited
 * directory descriptors, which needs a descriptor path that can be *traversed*
 * (`/proc/self/fd/<n>/child`). Linux provides that. macOS exposes `/dev/fd/<n>`,
 * which stats and realpaths but is not traversable, so the provider reports
 * itself unsupported there rather than dropping the containment guarantee, and
 * every test that drives a real allocation has to be gated on the same fact.
 *
 * Delegates to the production check so the gate cannot drift from the capability
 * the provider actually requires.
 *
 * Two gating styles, by scope:
 *   - a whole suite that is descriptor-dependent → `describe.skipIf(!descriptorPathsAvailable)`,
 *     which reports every case in it as skipped (see workspaces/integration.test.ts).
 *   - one case inside a suite that otherwise runs → `if (!descriptorPathsAvailable) return;`
 *     as the first line, matching the `hasGit()` gates already beside it.
 *
 * The second style reports as a pass without running, which is the tradeoff the
 * `hasGit()` gates already make. Per-case `test.skipIf` reports honestly but is not
 * free here: the formatter only hugs a callback for a recognized test identifier, so
 * `test.skipIf(...)(...)` (or any alias) loses the hug, overflows the line width, and
 * reindents every body, turning a one-line gate into a whole-file rewrite. If that
 * trade is ever worth taking, take it for the whole directory in one commit, not
 * file-by-file.
 */
export const descriptorPathsAvailable: boolean = descriptorBackedPathsSupported();

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
  probeBilling: (adapter: string) => ({
    adapter,
    apiKeySource: null,
    apiKeyPresent: false,
    login: "present" as const,
    mode: "subscription" as const,
  }),
};
