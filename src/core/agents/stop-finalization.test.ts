import { describe, expect, test } from "bun:test";
import { type GitFinalizationResult, GitFinalizationTimeout } from "./finalization.ts";
import type { readLiveCoordinationRow } from "./state/live-coordination-view.ts";
import { observeStopGitFinalization } from "./stop-finalization.ts";

const row = {
  instance_id: "operator",
  session_id: "native",
  files_touched: ["current.ts"],
} as NonNullable<ReturnType<typeof readLiveCoordinationRow>>;
const clean: GitFinalizationResult = {
  ok: true,
  claim_history_complete: true,
  dirty_paths: [],
  unpushed_repos: [],
  behind_repos: [],
  stale_submodules: [],
  diverged_submodules: [],
  host_output_paths: [],
  unsupported_paths: [],
  unverifiable_paths: [],
  unverifiable_repos: [],
  repos_checked: ["."],
};

describe("observeStopGitFinalization", () => {
  test("rechecks the shared current/history scope without repository-wide freshness", () => {
    let checked: unknown;
    const observed = observeStopGitFinalization("root", "operator", "native", {
      readRow: () => row,
      readScope: (root, current, session) => {
        expect([root, current, session]).toEqual(["root", row, "native"]);
        return { paths: ["current.ts", "released.ts"], complete: true };
      },
      check: (...args) => {
        checked = args;
        return clean;
      },
    });
    expect(checked).toEqual([
      "root",
      ["current.ts", "released.ts"],
      {
        claimHistoryComplete: true,
        includeRepositoryFreshness: false,
        timeoutMs: 2_000,
      },
    ]);
    expect(observed).toMatchObject({
      state: "observed",
      result: { ok: true, claim_history_complete: true },
    });
  });

  test("incomplete history stays observed bad even when Git cannot run", () => {
    let checked = false;
    expect(
      observeStopGitFinalization("root", "operator", "native", {
        readRow: () => row,
        readScope: () => ({ paths: [], complete: false }),
        check: () => {
          checked = true;
          throw new Error("Git cannot run");
        },
      }),
    ).toMatchObject({ state: "observed", result: { ok: false, claim_history_complete: false } });
    expect(checked).toBe(false);
  });

  test("preserves a known Git failure as observed bad state", () => {
    const result = { ...clean, ok: false, unverifiable_repos: ["."] };
    expect(
      observeStopGitFinalization("root", "operator", "native", {
        readRow: () => row,
        readScope: () => ({ paths: [], complete: true }),
        check: () => result,
      }),
    ).toEqual({ state: "observed", result });
  });

  test("records observer failure as unavailable", () => {
    expect(
      observeStopGitFinalization("root", "operator", "native", {
        readRow: () => row,
        readScope: () => {
          throw new Error("observer stopped");
        },
      }),
    ).toEqual({ state: "unavailable", reason: "check_failed" });
    expect(
      observeStopGitFinalization("root", "operator", "native", {
        readRow: () => null,
      }),
    ).toEqual({ state: "unavailable", reason: "session_unavailable" });
  });

  test("records a Git time limit separately from known bad Git state", () => {
    expect(
      observeStopGitFinalization("root", "operator", "native", {
        readRow: () => row,
        readScope: () => ({ paths: ["current.ts"], complete: true }),
        check: () => {
          throw new GitFinalizationTimeout();
        },
      }),
    ).toEqual({ state: "unavailable", reason: "check_timeout" });
  });
});
