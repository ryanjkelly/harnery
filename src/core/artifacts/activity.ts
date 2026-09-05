import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_MANIFEST } from "./constants.ts";

/** A checkpoint taken before an internal manifest write, never an expiry override. */
export interface ArtifactActivity {
  last_changed_at: string;
  root_entries_sha256: string;
}

export function validArtifactActivity(value: unknown): value is ArtifactActivity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<ArtifactActivity>;
  return (
    typeof item.last_changed_at === "string" &&
    Number.isFinite(Date.parse(item.last_changed_at)) &&
    typeof item.root_entries_sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(item.root_entries_sha256)
  );
}

export function artifactRootEntries(path: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        readdirSync(path)
          .filter((name) => name !== ARTIFACT_MANIFEST)
          .sort(),
      ),
    )
    .digest("hex");
}

/** Metadata writes change both the manifest and its parent directory timestamps.
 * Keep the prior root activity while its payload entries match the checkpoint.
 * A root deletion or rename changes that fingerprint; nested changes retain
 * their ordinary filesystem timestamps. Symlinks are inspected, never followed.
 */
export function readArtifactActivity(
  path: string,
  now: Date,
  previous?: ArtifactActivity,
): ArtifactActivity {
  const entries = artifactRootEntries(path);
  const nowMs = now.getTime();
  const accept = (timestamp: number): number =>
    Number.isFinite(timestamp) && timestamp <= nowMs + 5 * 60 * 1000
      ? Math.min(timestamp, nowMs)
      : 0;
  const walk = (entry: string, root = false): number => {
    const stat = lstatSync(entry);
    let latest =
      root && previous?.root_entries_sha256 === entries
        ? accept(Date.parse(previous.last_changed_at))
        : Math.max(accept(stat.mtimeMs), accept(stat.ctimeMs));
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of readdirSync(entry)) {
        // Only this unit's own control manifest is metadata. Nested artifact
        // manifests are payload from the containing workspace's point of view.
        if (root && previous && name === ARTIFACT_MANIFEST) continue;
        latest = Math.max(latest, walk(join(entry, name)));
      }
    }
    return latest;
  };
  const latest = Math.max(accept(Date.parse(previous?.last_changed_at ?? "")), walk(path, true));
  if (artifactRootEntries(path) !== entries)
    throw new Error("artifact entries changed during scan");
  return { last_changed_at: new Date(latest).toISOString(), root_entries_sha256: entries };
}
