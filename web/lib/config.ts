import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coordRoot } from "./coord-reader";
import { stripJsonComments } from "./files";
import { DEFAULT_BIN_NAME, type HostInfo } from "./host-info";

/**
 * Server-side host-info reader, derived from the coord root: the values the
 * dashboard needs to render commands + paths for the *host* project, not for
 * harnery itself. Read once in the root layout and pushed into a client context
 * via `HostInfoProvider`; client components read it through `useHostInfo()`.
 *
 * The HostInfo type + DEFAULT_BIN_NAME live in ./host-info (browser-safe, no
 * node:* imports) so client components can import them without pulling this
 * module's `fs` code into the bundle. Re-exported here for server-side callers.
 *
 * `binName` mirrors the CLI-side resolver in `src/core/config.ts`: a dashboard
 * boot for a project whose host CLI is `harn` must tell agents to run `harn agents
 * council …`, not `harn …`. Precedence: `HARNERY_BIN` env → config.jsonc
 * `binName` → `"harn"`.
 */
export { DEFAULT_BIN_NAME };
export type { HostInfo };

export function hostInfo(): HostInfo {
  const repoRoot = coordRoot();
  return { binName: resolveBinName(repoRoot), repoRoot };
}

function resolveBinName(root: string): string {
  const env = process.env.HARNERY_BIN?.trim();
  if (env) return env;
  try {
    const raw = readFileSync(join(root, ".harnery", "config.jsonc"), "utf8");
    const parsed = JSON.parse(stripJsonComments(raw)) as { binName?: unknown };
    if (typeof parsed.binName === "string" && parsed.binName.trim()) return parsed.binName.trim();
  } catch {
    /* missing or unparseable → default */
  }
  return DEFAULT_BIN_NAME;
}
