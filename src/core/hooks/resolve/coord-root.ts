import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { coordEnv } from "../../../lib/env.ts";

/**
 * Walk up from `start` looking for a directory containing `.harnery/`. The
 * single coord-root resolution so every adapter agrees on the same root.
 *
 * Resolution precedence:
 *   1. HARNERY_COORD_ROOT_OVERRIDE — explicit pin (tests, git hooks).
 *   2. The harness's project dir (CLAUDE_PROJECT_DIR) — hook processes
 *      inherit the session's *shell* cwd, which follows `cd` into
 *      subdirectories/submodules that may carry a `.harnery/` of their own
 *      (or none at all, e.g. a scratch dir under /tmp). The session's
 *      coordination home is the project the harness opened, not wherever the
 *      shell happens to sit, so a project dir that resolves to a coord root
 *      wins over the cwd walk.
 *   3. Walk up from `start` (default cwd).
 */
export function findCoordRoot(start: string = process.cwd()): string | null {
  // HARNERY_COORD_ROOT_OVERRIDE: explicit pin matched by agent-coord and the
  // bash side. Lets the sandboxed coord-test suite run against a temp
  // directory rather than the real monorepo root. agent-hook's session.start
  // handler may be the FIRST thing to create .harnery/ in a fresh sandbox,
  // so the override is honored unconditionally (we don't require .harnery/
  // to pre-exist).
  const override = coordEnv("COORD_ROOT_OVERRIDE");
  if (override) return override;
  // Claude Code exports CLAUDE_PROJECT_DIR to every hook process; other
  // harnesses don't set it, so this is inert outside claude-code hooks.
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) {
    const fromProject = walkUp(projectDir);
    if (fromProject) return fromProject;
  }
  return walkUp(start);
}

function walkUp(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".harnery"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
