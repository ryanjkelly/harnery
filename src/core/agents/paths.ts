import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Walk up from `start` looking for a directory containing `.harnery/`, so
 * adapter + legacy code agree on the same monorepo root.
 */
export function findCoordRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".harnery"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
