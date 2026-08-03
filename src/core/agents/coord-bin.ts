/**
 * Locate harnery's own bundled coordination binaries (`agent-coord`,
 * `agent-hook`, `harn`).
 *
 * Every coord-helper spawn used to build its path as
 * `<coordRoot>/harnery/bin/<name>`, which only exists in one host layout: a
 * superproject carrying harnery as a submodule at `harnery/`. That assumption
 * was load-bearing in the worst way — because the path missed whenever the
 * resolved root was anything else, root resolution itself was bent toward the
 * git superproject to keep the spawns working, which is what split the CLI's
 * root from the hook's and blocked end-of-turn rule 1/3. The same missing path
 * also surfaced as a crash rather than an error: `spawnSync` on a nonexistent
 * binary reports `status: null` and `stderr: null`, so a caller checking
 * `status !== 0` then reading `stderr.trim()` threw "null is not an object".
 *
 * The binaries ship inside the harnery package, so the package is what knows
 * where they are. Resolution walks up from this module to the package root,
 * which covers every install shape: `src/` under Bun, `dist/` on Node, and
 * `node_modules/harnery/`. The layout-specific paths remain as fallbacks so a
 * host whose harnery copy is not the one executing (a vendored tree, a shim)
 * still resolves.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coordEnv } from "../../lib/env.ts";

export type CoordBinName = "agent-coord" | "agent-hook" | "harn";

/**
 * Absolute path to one of harnery's bundled binaries, or null when no candidate
 * exists on disk. Callers must handle null — a missing helper is a real state
 * (a partially installed package) and silently spawning a nonexistent path is
 * what produced the null-deref crash above.
 */
export function coordBinPath(name: CoordBinName, coordRoot?: string | null): string | null {
  for (const candidate of coordBinCandidates(name, coordRoot)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Candidate paths for `name`, in resolution order. Exported for tests. */
export function coordBinCandidates(name: CoordBinName, coordRoot?: string | null): string[] {
  const candidates: string[] = [];
  const push = (value: string | null | undefined) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  // Explicit pin, for a host that relocates the binaries.
  const pinned = coordEnv("BIN_DIR");
  if (pinned) push(join(pinned, name));

  // The package this code is executing from.
  const pkgRoot = packageRoot(name);
  if (pkgRoot) push(join(pkgRoot, "bin", name));

  if (coordRoot) {
    // Host layouts, in decreasing specificity: harnery as a submodule, as an
    // installed dependency, or the coord root being harnery's own checkout.
    push(resolve(coordRoot, "harnery", "bin", name));
    push(resolve(coordRoot, "node_modules", "harnery", "bin", name));
    push(resolve(coordRoot, "bin", name));
  }

  return candidates;
}

/**
 * Walk up from this module to the directory holding `bin/<name>`.
 *
 * The walk keys on the binary itself rather than on `package.json`, because
 * both `src/core/agents/` and the built `dist/core/agents/` sit under the same
 * package root and only the binary's presence proves we found the right level.
 */
function packageRoot(name: CoordBinName): string | null {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    // No import.meta (a CJS transpile); the coordRoot fallbacks still apply.
    return null;
  }
  for (let hop = 0; hop < 8; hop++) {
    if (existsSync(join(dir, "bin", name))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
