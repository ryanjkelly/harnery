import { resolveCoordRoot } from "../../agents/coord-client.ts";

/**
 * The hooks-side name for THE coordination-root resolution.
 *
 * Delegates to `resolveCoordRoot()` so the hooks and the CLI cannot resolve
 * different roots. They used to: this walked up from `CLAUDE_PROJECT_DIR` or
 * cwd while the CLI's `monorepoRoot()` asked git for the superproject first, so
 * with a shell inside a submodule that carries its own `.harnery/`, the CLI's
 * `state.status_checked` landed in a stream this side never read and rule 1/3
 * blocked every turn.
 *
 * Resolution precedence (see `resolveCoordRoot` for the full rationale):
 *   1. HARNERY_COORD_ROOT_OVERRIDE — explicit pin (tests, git hooks).
 *   2. The adapter's project dir (CLAUDE_PROJECT_DIR) — hook processes inherit
 *      the session's *shell* cwd, which follows `cd` into subdirectories or
 *      submodules that may carry a `.harnery/` of their own (or none at all,
 *      e.g. a journal dir under /tmp). The session's coordination home is the
 *      project the adapter opened, not wherever the shell happens to sit.
 *   3. The root that already holds this session's heartbeat.
 *   4. The nearest enclosing `.harnery/`, then a git-derived root.
 */
export function findCoordRoot(start: string = process.cwd()): string | null {
  return resolveCoordRoot(start);
}
