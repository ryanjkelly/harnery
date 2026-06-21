import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { coordEnv } from "../../../lib/env.ts";

/**
 * Walk up from `start` looking for a directory containing `.harnery/`. The
 * single coord-root resolution so every adapter agrees on the same root.
 */
export function findCoordRoot(start: string = process.cwd()): string | null {
  // HARNERY_COORD_ROOT_OVERRIDE: test-mode escape hatch matched by agent-coord
  // and the bash side. Lets the sandboxed coord-test suite run against a
  // temp directory rather than the real monorepo root. agent-hook's
  // session.start handler may be the FIRST thing to create .harnery/ in a
  // fresh sandbox, so the override is honored unconditionally (we don't
  // require .harnery/ to pre-exist).
  const override = coordEnv("COORD_ROOT_OVERRIDE");
  if (override) return override;
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".harnery"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
