export const ARTIFACTS_BROWSE_ROOT = ".harnery/artifacts";

export interface ArtifactDirectoryCandidate {
  owner_instance_id: string | null;
  relative_path: string;
  created_at: string | null;
}

/** Resolve an agent to its newest managed artifact workspace. */
export function latestAgentArtifactDirectory(
  entries: readonly ArtifactDirectoryCandidate[],
  instanceId: string,
): string | null {
  return (
    entries
      .filter((entry) => entry.owner_instance_id === instanceId)
      .sort((left, right) => (right.created_at ?? "").localeCompare(left.created_at ?? ""))[0]
      ?.relative_path ?? null
  );
}
