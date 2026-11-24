import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  annotatePeerCommits,
  formatGitFinalizationFailure,
  freshnessBlockedOnlyByPeerCommits,
  type GitFinalizationResult,
} from "./finalization.ts";
import type { GitCommitActivityView } from "./git-activity.ts";

function result(overrides: Partial<GitFinalizationResult> = {}): GitFinalizationResult {
  return {
    ok: false,
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
    repos_checked: [],
    ...overrides,
  };
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "final-peers-")));

function view(instance_id: string, repo: string, agent?: string): GitCommitActivityView {
  return {
    schema_version: 1,
    instance_id,
    ...(agent ? { agent } : {}),
    repo: join(root, repo),
    git_pid: 1,
    started_at: "2026-01-01T00:00:00Z",
    slots: ["pre-commit tests"],
  };
}

describe("annotatePeerCommits", () => {
  test("names peer commits in repositories a freshness finding lists", () => {
    const annotated = annotatePeerCommits(
      root,
      result({ diverged_submodules: ["web"] }),
      "inst-self",
      {
        activity: () => [
          view("inst-peer", "web", "Bonnie"),
          view("inst-self", "web", "Celeste"),
          view("inst-other", "cli", "Mason"),
        ],
      },
    );
    expect(annotated.peer_commits_in_flight).toEqual([
      {
        repo: "web",
        agent: "agent-Bonnie",
        instance_id: "inst-peer",
        started_at: "2026-01-01T00:00:00Z",
        slots: ["pre-commit tests"],
      },
    ]);
  });

  test("leaves a passing result alone", () => {
    const passing = result({ ok: true });
    expect(annotatePeerCommits(root, passing, "x", { activity: () => [view("p", ".")] })).toBe(
      passing,
    );
  });
});

describe("freshnessBlockedOnlyByPeerCommits", () => {
  const peer = {
    repo: "web",
    agent: "agent-Bonnie",
    instance_id: "p",
    started_at: "2026-01-01T00:00:00Z",
    slots: [],
  };

  test("true when every affected repository has a peer commit in progress", () => {
    expect(
      freshnessBlockedOnlyByPeerCommits(
        result({
          behind_repos: ["."],
          diverged_submodules: ["web"],
          peer_commits_in_flight: [peer],
        }),
      ),
    ).toBe(true);
  });

  test("false when a sync could still fix an affected repository", () => {
    expect(
      freshnessBlockedOnlyByPeerCommits(
        result({ diverged_submodules: ["web", "cli"], peer_commits_in_flight: [peer] }),
      ),
    ).toBe(false);
  });

  test("false whenever the session has unfinished work of its own", () => {
    expect(
      freshnessBlockedOnlyByPeerCommits(
        result({
          diverged_submodules: ["web"],
          unpushed_repos: ["."],
          peer_commits_in_flight: [peer],
        }),
      ),
    ).toBe(false);
    expect(
      freshnessBlockedOnlyByPeerCommits(
        result({
          diverged_submodules: ["web"],
          dirty_paths: ["a.ts"],
          peer_commits_in_flight: [peer],
        }),
      ),
    ).toBe(false);
  });

  test("false without a recorded peer commit", () => {
    expect(freshnessBlockedOnlyByPeerCommits(result({ diverged_submodules: ["web"] }))).toBe(false);
  });
});

test("the refusal names the peer and its checks", () => {
  const text = formatGitFinalizationFailure(
    result({
      diverged_submodules: ["web"],
      peer_commits_in_flight: [
        {
          repo: "web",
          agent: "agent-Bonnie",
          instance_id: "p",
          started_at: new Date(Date.now() - 4 * 60_000).toISOString(),
          slots: ["pre-commit tests"],
        },
      ],
    }),
    "harn",
    "status",
    "git pull",
  );
  expect(text).toContain("This checkout is behind while agent-Bonnie finishes a commit");
  expect(text).toContain(
    "web: agent-Bonnie has been committing for 4 min; running pre-commit tests",
  );
});
