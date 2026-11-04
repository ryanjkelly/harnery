import {
  checkGitFinalization,
  type GitFinalizationResult,
  GitFinalizationTimeout,
  readSessionFinalizationScope,
} from "./finalization.ts";
import { readLiveCoordinationRow } from "./state/live-coordination-view.ts";

export type StopGitFinalization =
  | { state: "observed"; result: GitFinalizationResult }
  | { state: "unavailable"; reason: "session_unavailable" | "check_failed" | "check_timeout" };

/**
 * Recheck known owned paths after the reply completes. This does not attest
 * to unknown paths or writes a background process might make in the future.
 */
export function observeStopGitFinalization(
  coordRoot: string,
  instanceId: string,
  sessionId: string,
  dependencies: {
    readRow?: typeof readLiveCoordinationRow;
    readScope?: typeof readSessionFinalizationScope;
    check?: typeof checkGitFinalization;
  } = {},
): StopGitFinalization {
  try {
    const row = (dependencies.readRow ?? readLiveCoordinationRow)(coordRoot, instanceId);
    if (!row) return { state: "unavailable", reason: "session_unavailable" };
    const scope = (dependencies.readScope ?? readSessionFinalizationScope)(
      coordRoot,
      row,
      sessionId,
    );
    if (!scope.complete) {
      // A known history failure must not disappear behind a later observer error.
      return {
        state: "observed",
        result: {
          ok: false,
          claim_history_complete: false,
          dirty_paths: [],
          unpushed_repos: [],
          behind_repos: [],
          stale_submodules: [],
          diverged_submodules: [],
          host_output_paths: [],
          unsupported_paths: [],
          unverifiable_paths: [],
          unverifiable_repos: [],
          repos_checked: [],
        },
      };
    }
    const result = (dependencies.check ?? checkGitFinalization)(coordRoot, scope.paths, {
      claimHistoryComplete: scope.complete,
      includeRepositoryFreshness: false,
      timeoutMs: 2_000,
    });
    return { state: "observed", result };
  } catch (error) {
    // Unknown is never a successful Git observation. The caller records it
    // and still runs every pre-existing Stop rule.
    return {
      state: "unavailable",
      reason: error instanceof GitFinalizationTimeout ? "check_timeout" : "check_failed",
    };
  }
}
