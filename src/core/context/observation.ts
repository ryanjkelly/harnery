/**
 * Repository observation contract shared by context recovery and workflow proof.
 *
 * This module runs no Git and touches no files, so read-only consumers (the
 * Codec dashboard, proof readers) can use it without reaching the
 * Git-running snapshot code in ./index.ts.
 */

import { isAbsolute } from "node:path";

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

/**
 * Every reason two snapshots cannot establish repository drift. Only an empty
 * list lets a caller compare branch, HEAD and dirty paths; anything else
 * leaves the whole comparison unknown.
 */
export function repoComparisonProblems(
  a: RepoSnapshot,
  b: RepoSnapshot,
  labels: readonly [string, string],
): string[] {
  const sides = [
    [labels[0], a],
    [labels[1], b],
  ] as const;
  const failed = sides.flatMap(([label, repo]) =>
    repo.observation === "ok"
      ? []
      : [
          // Snapshots recorded before observations existed carry none.
          `${label} snapshot is ${repo.observation ?? "unavailable"}${repo.observation_detail ? ` (${repo.observation_detail})` : ""}`,
        ],
  );
  if (failed.length > 0) return failed;
  const problems: string[] = [];
  if (a.dirty_paths_truncated || b.dirty_paths_truncated) {
    problems.push("dirty path list is truncated");
  }
  if (!a.root || !b.root || !isAbsolute(a.root) || !isAbsolute(b.root)) {
    problems.push("repository root is unknown");
  } else if (a.root !== b.root) {
    problems.push("repository roots differ");
  }
  if (!a.branch?.trim() || !b.branch?.trim()) problems.push("branch is unknown");
  if (!a.head?.trim() || !b.head?.trim()) problems.push("HEAD is unknown");
  return problems;
}
