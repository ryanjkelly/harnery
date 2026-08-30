import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Resolve the coordination root from path evidence only.
 *
 * This path-only resolver deliberately does not inspect live producer state.
 * Code that reads or writes coordination authority must use
 * `resolveCoordRoot()` from `agents/coord-client.ts`, which disambiguates
 * nested coordination roots through the registered session. Keeping the two
 * responsibilities separate lets configuration and other path-only consumers
 * avoid loading the event recorder and its contract graph.
 *
 * Resolution precedence (see `resolveCoordRoot` for the full rationale):
 *   1. HARNERY_COORD_ROOT_OVERRIDE — explicit pin (tests, git hooks).
 *   2. The adapter's project dir (CLAUDE_PROJECT_DIR) — hook processes inherit
 *      the session's *shell* cwd, which follows `cd` into subdirectories or
 *      submodules that may carry a `.harnery/` of their own (or none at all,
 *      e.g. a journal dir under /tmp). The session's coordination home is the
 *      project the adapter opened, not wherever the shell happens to sit.
 *   3. The nearest enclosing `.harnery/`.
 *   4. A git-derived root when no `.harnery/` exists yet.
 */
export function findCoordRoot(start: string = process.cwd()): string | null {
  const rootOverride = process.env.HARNERY_COORD_ROOT_OVERRIDE;
  if (rootOverride) return rootOverride;

  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) {
    const fromProject = nearestCoordRoot(projectDir);
    if (fromProject) return fromProject;
  }

  const nearest = nearestCoordRoot(start);
  if (nearest) return nearest;
  return gitCoordRoots(start)[0] ?? gitToplevel(start);
}

/** Nearest enclosing directory carrying `.harnery/`, or null. */
export function nearestCoordRoot(start: string): string | null {
  return ancestorCoordRoots(start)[0] ?? null;
}

/** Every enclosing directory carrying `.harnery/`, nearest first. */
export function ancestorCoordRoots(start: string): string[] {
  const found: string[] = [];
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".harnery"))) found.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/**
 * Git-derived roots carrying `.harnery/`, in superproject-first order.
 *
 * Spawns use `start` as cwd so a call about another checkout cannot inherit
 * this process's repository. The common-dir fallback recovers a superproject
 * from a submodule worktree, where Git reports no direct superproject path.
 */
export function gitCoordRoots(start: string): string[] {
  const roots: string[] = [];
  const push = (value: string | null) => {
    if (value && existsSync(join(value, ".harnery")) && !roots.includes(value)) roots.push(value);
  };

  push(gitRevParse(start, "--show-superproject-working-tree"));
  const common = gitRevParse(start, "--git-common-dir");
  if (common) {
    const index = common.indexOf("/.git/modules/");
    if (index !== -1) push(common.substring(0, index));
  }
  push(gitToplevel(start));
  return roots;
}

export function gitToplevel(start: string): string | null {
  return gitRevParse(start, "--show-toplevel");
}

function gitRevParse(start: string, flag: string): string | null {
  const key = `${start}\0${flag}`;
  const cached = gitRevParseCache.get(key);
  if (cached !== undefined) return cached;
  let value: string | null = null;
  try {
    // A stale adapter project directory may no longer exist. Treat spawn
    // failure as no path evidence instead of turning discovery into an error.
    const result = spawnSync("git", ["rev-parse", flag], {
      cwd: start,
      encoding: "utf8",
    });
    if (result.status === 0) value = result.stdout.trim() || null;
  } catch {
    value = null;
  }
  gitRevParseCache.set(key, value);
  return value;
}

const gitRevParseCache = new Map<string, string | null>();
