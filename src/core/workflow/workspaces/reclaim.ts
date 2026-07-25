/**
 * Resolve a workspace stuck at `preserved_dirty` (ADR 0042).
 *
 * When a run ends with uncommitted work, the provider preserves the worktree
 * rather than destroying the only copy of that work. That decision is correct,
 * and until this existed it was also permanent: cleanup re-attempted, found the
 * tree still dirty, preserved again, and incremented a counter. The only exit
 * was to leave Harnery and remove the directory by hand, after which Harnery's
 * records described a workspace that no longer existed.
 *
 * The shape of the fix is deliberate. Neither mode deletes anything directly.
 * Each one makes the working tree *clean* by an explicit, named act, and then
 * hands off to the ordinary cleanup path, which releases a clean workspace as it
 * always has. So reclaim adds no second removal path that could diverge from the
 * audited one, and a force-delete of live work exists nowhere in the codebase.
 */

import { existsSync } from "node:fs";
import { git, gitMaybe } from "./git.ts";

export type ReclaimMode = "salvage" | "discard";

export type ReclaimPreparation =
  | { action: "salvaged"; branch: string; commit: string; detail: string }
  | { action: "discarded"; detail: string }
  | { action: "already_clean"; detail: string }
  | { action: "already_gone"; detail: string };

export interface PrepareReclaimInput {
  worktreePath: string;
  mode: ReclaimMode;
  runId: string;
}

/**
 * Bring the worktree to a clean state so ordinary cleanup can release it.
 *
 * Returns `already_gone` rather than throwing when the directory has been
 * removed out from under us. A workspace whose worktree no longer exists has
 * effectively been reclaimed; treating that as an error is what produced an
 * attempt counter that only ever went up.
 */
export function prepareReclaim(input: PrepareReclaimInput): ReclaimPreparation {
  if (!existsSync(input.worktreePath)) {
    return {
      action: "already_gone",
      detail: "the worktree directory is already gone; nothing to reclaim",
    };
  }

  const status = gitMaybe(input.worktreePath, ["status", "--porcelain"]);
  if (!status.ok) {
    throw new Error(`cannot read worktree status for reclaim: ${status.err || "git failed"}`);
  }
  if (status.out.trim().length === 0) {
    return { action: "already_clean", detail: "the worktree has no uncommitted changes" };
  }

  if (input.mode === "discard") {
    // Ordered: reset drops tracked modifications, clean removes what reset
    // cannot see. Running clean first would leave staged deletions behind.
    git(input.worktreePath, ["reset", "--hard"]);
    git(input.worktreePath, ["clean", "-fd"]);
    return { action: "discarded", detail: "uncommitted changes were discarded on request" };
  }

  // Salvage onto a ref of its own, then put the checked-out branch back exactly
  // where it was. Two reasons, both learned by doing it the obvious way first:
  //
  //  1. Cleanup DELETES the provider's workspace branch. Committing the salvage
  //     there would have parked the work on a ref that the very next step
  //     removes, leaving it unreachable and eventually collectable.
  //  2. Cleanup pins the workspace ref's OID in a frozen intent and refuses when
  //     it moves, which is a guard worth keeping. Advancing that branch turned
  //     every reclaim into `blocked`.
  //
  // Committing and rewinding satisfies both: the tree ends clean, the workspace
  // ref ends untouched, and the work lives on a ref cleanup has no reason to
  // touch.
  const before = git(input.worktreePath, ["rev-parse", "HEAD"]).trim();
  git(input.worktreePath, ["add", "-A"]);
  git(input.worktreePath, ["commit", "--no-verify", "-m", salvageMessage(input.runId)]);
  const commit = git(input.worktreePath, ["rev-parse", "HEAD"]).trim();
  const branch = salvageBranch(input.runId);
  git(input.worktreePath, ["branch", "--force", branch, commit]);
  git(input.worktreePath, ["reset", "--hard", before]);
  return {
    action: "salvaged",
    branch,
    commit,
    detail: `salvaged to ${branch} at ${commit.slice(0, 12)}`,
  };
}

/**
 * `--no-verify` above is not a shortcut. A salvage commit is an archival act on
 * an abandoned workspace, so a repository hook that rejects work in progress
 * would convert "preserve the work" into "cannot preserve the work", which is
 * the failure this whole path exists to prevent.
 */
function salvageMessage(runId: string): string {
  return `chore(workspace): salvage uncommitted work from run ${runId}`;
}

/** Named for the run rather than the workspace, because the run id is what an
 * operator has in hand when they come looking for the work later. */
export function salvageBranch(runId: string): string {
  return `harnery/salvage/${runId}`;
}
