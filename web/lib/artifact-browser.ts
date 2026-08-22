import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_MANIFEST } from "../../src/core/artifacts/index";

const ARTIFACTS_DIR = ".harnery/artifacts";

interface OwnedWorkspace {
  relative_path: string;
  created_at: string;
}

/**
 * Fast owner lookup for /browse: readdir the artifact root and read ONE small
 * manifest per entry. Deliberately NOT `inventoryArtifacts`, whose per-entry
 * recursive tree-size, git-tracked, and owner-liveness checks cost tens of
 * seconds on a large artifact root — far too slow for a page render.
 *
 * Returns the agent's managed workspaces as repo-relative paths, newest first.
 */
export function agentArtifactDirectories(repoRoot: string, instanceId: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(repoRoot, ARTIFACTS_DIR));
  } catch {
    return [];
  }
  const owned: OwnedWorkspace[] = [];
  for (const name of names) {
    try {
      const raw = readFileSync(join(repoRoot, ARTIFACTS_DIR, name, ARTIFACT_MANIFEST), "utf8");
      const manifest = JSON.parse(raw) as {
        created_by?: { instance_id?: string };
        created_at?: string;
      };
      if (manifest?.created_by?.instance_id === instanceId) {
        owned.push({
          relative_path: `${ARTIFACTS_DIR}/${name}`,
          created_at: typeof manifest.created_at === "string" ? manifest.created_at : "",
        });
      }
    } catch {
      // No manifest (unmanaged entry), unreadable, or invalid JSON — not a candidate.
    }
  }
  return owned
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .map((entry) => entry.relative_path);
}
