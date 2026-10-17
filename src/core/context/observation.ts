/**
 * Repository observation contract shared by context recovery and workflow proof.
 *
 * This module has no runtime imports so read-only consumers (the Codec
 * dashboard, proof readers) can use it without reaching the Git-running
 * snapshot code in ./index.ts.
 */

export type RepoObservation = "ok" | "unavailable" | "partial";

export interface RepoSnapshot {
  cwd: string;
  observation: RepoObservation;
  /** Bounded explanation of an unavailable or incomplete observation. */
  observation_detail?: string;
  root?: string;
  branch?: string;
  head?: string;
  dirty_paths: string[];
  dirty_paths_truncated?: boolean;
}

/** Only explicitly successful observations can establish repository drift. */
export function observationsComparable(
  a: { observation?: string },
  b: { observation?: string },
): boolean {
  return a.observation === "ok" && b.observation === "ok";
}
