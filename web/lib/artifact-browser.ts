import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_MANIFEST, ARTIFACTS_DIR } from "../../src/core/artifacts/constants";

interface OwnedWorkspace {
  owner_instance_id: string;
  relative_path: string;
  created_at: string;
}

/**
 * Read the bounded ownership index shared by /browse and Codec. This performs
 * one root readdir plus one small manifest read per workspace; it deliberately
 * avoids `inventoryArtifacts`, whose recursive size and git checks are far too
 * expensive for a page render.
 */
function ownedArtifactWorkspaces(repoRoot: string): OwnedWorkspace[] {
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
      const ownerInstanceId = manifest?.created_by?.instance_id;
      if (ownerInstanceId) {
        owned.push({
          owner_instance_id: ownerInstanceId,
          relative_path: `${ARTIFACTS_DIR}/${name}`,
          created_at: typeof manifest.created_at === "string" ? manifest.created_at : "",
        });
      }
    } catch {
      // No manifest (unmanaged entry), unreadable, or invalid JSON — not a candidate.
    }
  }
  return owned;
}

/** All agent ids that own at least one managed artifact workspace. */
export function artifactOwnerInstanceIds(repoRoot: string): Set<string> {
  return new Set(ownedArtifactWorkspaces(repoRoot).map((entry) => entry.owner_instance_id));
}

/** Returns one agent's managed workspaces as repo-relative paths, newest first. */
export function agentArtifactDirectories(repoRoot: string, instanceId: string): string[] {
  const owned = ownedArtifactWorkspaces(repoRoot).filter(
    (entry) => entry.owner_instance_id === instanceId,
  );
  return owned
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .map((entry) => entry.relative_path);
}
