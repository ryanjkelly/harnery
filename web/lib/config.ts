import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coordRoot } from "./coord-reader";
import { stripJsonComments } from "./files";

/**
 * Host info derived server-side from the coord root: the values the dashboard
 * needs to render commands + paths for the *host* project, not for harnery
 * itself. Read once in the root layout and pushed into a client context via
 * `HostInfoProvider`; client components read it through `useHostInfo()`.
 *
 * `binName` mirrors the CLI-side resolver in `src/core/config.ts`: a dashboard
 * boot for a project whose host CLI is `harn` must tell agents to run `harn agents
 * council …`, not `harn …`. Precedence: `HARNERY_BIN` env → config.jsonc
 * `binName` → `"harn"`.
 */
export interface HostInfo {
  /** Host CLI bin name (e.g. `myapp`) for agent-facing command strings. */
  binName: string;
  /** Absolute coord root, used to shorten absolute paths for display. */
  repoRoot: string;
}

export const DEFAULT_BIN_NAME = "harn";

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
