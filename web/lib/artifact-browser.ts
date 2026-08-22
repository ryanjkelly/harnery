export const ARTIFACTS_BROWSE_ROOT = ".harnery/artifacts";

export interface ArtifactDirectoryCandidate {
  owner_instance_id: string | null;
  relative_path: string;
  created_at: string | null;
}

/** All of an agent's managed artifact workspaces, newest first. */
export function agentArtifactDirectories(
  entries: readonly ArtifactDirectoryCandidate[],
  instanceId: string,
): string[] {
  return entries
    .filter((entry) => entry.owner_instance_id === instanceId)
    .sort((left, right) => (right.created_at ?? "").localeCompare(left.created_at ?? ""))
    .map((entry) => entry.relative_path);
}
