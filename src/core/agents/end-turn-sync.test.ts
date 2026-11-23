import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  agentsGitSyncOnEndTurn,
  attemptEndTurnSync,
  END_TURN_SYNC_TIMEOUT_MS,
  endTurnSyncTimeoutMs,
  formatEndTurnSyncRefusal,
  formatEndTurnSyncSummary,
  isFreshnessOnlyFailure,
} from "./end-turn-sync.ts";
import type { GitFinalizationResult } from "./finalization.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.HARNERY_AGENTS_GIT_SYNC_ON_END_TURN;
});

function project(agents: Record<string, unknown> | null): string {
  const root = mkdtempSync(join(os.tmpdir(), "end-turn-sync-"));
  roots.push(root);
  if (agents) {
    mkdirSync(join(root, ".harnery"), { recursive: true });
    writeFileSync(
      join(root, ".harnery", "config.jsonc"),
      `// project config\n${JSON.stringify({ agents })}\n`,
    );
  }
  return root;
}

function result(overrides: Partial<GitFinalizationResult> = {}): GitFinalizationResult {
  const base: GitFinalizationResult = {
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
  };
  const merged = { ...base, ...overrides };
  if (overrides.ok === undefined) {
    merged.ok = merged.behind_repos.length === 0 && merged.stale_submodules.length === 0;
  }
  return merged;
}

const enabled = { gitSyncOnEndTurn: true, gitSyncCommand: "sync-all" };

describe("agentsGitSyncOnEndTurn", () => {
  test("defaults off and reads the project flag", () => {
    expect(agentsGitSyncOnEndTurn(project(null))).toBe(false);
    expect(agentsGitSyncOnEndTurn(project({ gitSyncOnEndTurn: "yes" }))).toBe(false);
    expect(agentsGitSyncOnEndTurn(project({ gitSyncOnEndTurn: true }))).toBe(true);
  });

  test("the environment can switch it off", () => {
    const root = project({ gitSyncOnEndTurn: true });
    process.env.HARNERY_AGENTS_GIT_SYNC_ON_END_TURN = "0";
    expect(agentsGitSyncOnEndTurn(root)).toBe(false);
  });
});

describe("isFreshnessOnlyFailure", () => {
  test("behind or stale alone qualifies", () => {
    expect(isFreshnessOnlyFailure(result({ behind_repos: ["."] }))).toBe(true);
    expect(isFreshnessOnlyFailure(result({ stale_submodules: ["lib"] }))).toBe(true);
  });

  test("owned work, divergence, or unverifiable state disqualifies", () => {
    expect(isFreshnessOnlyFailure(result())).toBe(false);
    expect(isFreshnessOnlyFailure(result({ behind_repos: ["."], dirty_paths: ["a.ts"] }))).toBe(
      false,
    );
    expect(isFreshnessOnlyFailure(result({ behind_repos: ["."], unpushed_repos: ["."] }))).toBe(
      false,
    );
    expect(
      isFreshnessOnlyFailure(result({ behind_repos: ["."], diverged_submodules: ["lib"] })),
    ).toBe(false);
    expect(isFreshnessOnlyFailure(result({ behind_repos: ["."], unverifiable_repos: ["."] }))).toBe(
      false,
    );
    expect(
      isFreshnessOnlyFailure(result({ behind_repos: ["."], claim_history_complete: false })),
    ).toBe(false);
  });
});

describe("attemptEndTurnSync", () => {
  const heads = (values: string[]) => {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)] ?? null;
  };

  test("does nothing unless opted in with a command", () => {
    const behind = result({ behind_repos: ["."] });
    let ran = 0;
    const run = () => {
      ran++;
      return { status: 0, timedOut: false, output: "" };
    };
    expect(attemptEndTurnSync(project(null), behind, () => result(), { run })).toBeNull();
    expect(
      attemptEndTurnSync(project({ gitSyncOnEndTurn: true }), behind, () => result(), { run }),
    ).toBeNull();
    expect(
      attemptEndTurnSync(project({ gitSyncCommand: "sync-all" }), behind, () => result(), {
        run,
      }),
    ).toBeNull();
    expect(ran).toBe(0);
  });

  test("never runs for a failure that includes owned work", () => {
    let ran = 0;
    const out = attemptEndTurnSync(
      project(enabled),
      result({ behind_repos: ["."], dirty_paths: ["a.ts"] }),
      () => result(),
      {
        run: () => {
          ran++;
          return { status: 0, timedOut: false, output: "" };
        },
      },
    );
    expect(out).toBeNull();
    expect(ran).toBe(0);
  });

  test("runs once and passes when the re-check is clean", () => {
    const root = project(enabled);
    const calls: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
    const out = attemptEndTurnSync(
      root,
      result({ behind_repos: ["."], stale_submodules: ["lib", "vendor"] }),
      () => result({ ok: true }),
      {
        run: (command, cwd, timeoutMs) => {
          calls.push({ command, cwd, timeoutMs });
          return { status: 0, timedOut: false, output: "ok" };
        },
        head: heads(["aaa", "bbb"]),
        countCommits: () => 3,
      },
      5_000,
    );
    expect(calls).toEqual([{ command: "sync-all", cwd: root, timeoutMs: 5_000 }]);
    expect(out?.result.ok).toBe(true);
    expect(out?.sync).toEqual({
      command: "sync-all",
      outcome: "succeeded",
      exit_code: 0,
      commits_pulled: 3,
      submodules_updated: ["lib", "vendor"],
      timeout_ms: 5_000,
    });
    expect(formatEndTurnSyncSummary(out!.sync)).toBe(
      "ran `sync-all` to catch up; brought in 3 upstream commits and updated submodules lib, vendor",
    );
  });

  test("refuses when findings remain after the sync", () => {
    const out = attemptEndTurnSync(
      project(enabled),
      result({ behind_repos: ["."] }),
      () => result({ diverged_submodules: ["lib"], ok: false }),
      {
        run: () => ({ status: 0, timedOut: false, output: "" }),
        head: heads(["aaa", "aaa"]),
      },
    );
    expect(out?.result.ok).toBe(false);
    expect(out?.sync.commits_pulled).toBe(0);
    expect(formatEndTurnSyncRefusal(out!.sync)).toContain("still not clean");
  });

  test("a failed or timed-out command never passes, even if the re-check looks clean", () => {
    for (const ran of [
      { status: 1, timedOut: false, output: "line1\nconflict in x" },
      { status: null, timedOut: true, output: "" },
    ]) {
      const out = attemptEndTurnSync(
        project(enabled),
        result({ behind_repos: ["."] }),
        () => result({ ok: true }),
        { run: () => ran, head: heads(["aaa", "aaa"]) },
      );
      expect(out?.result.ok).toBe(false);
      expect(out?.sync.outcome).toBe(ran.timedOut ? "timed_out" : "failed");
    }
    const failed = attemptEndTurnSync(
      project(enabled),
      result({ behind_repos: ["."] }),
      () => result({ ok: true }),
      {
        run: () => ({ status: 1, timedOut: false, output: "conflict in x" }),
        head: heads(["aaa", "aaa"]),
      },
    );
    expect(formatEndTurnSyncRefusal(failed!.sync)).toContain("conflict in x");
  });

  test("a sync that throws is reported as failed", () => {
    const out = attemptEndTurnSync(
      project(enabled),
      result({ behind_repos: ["."] }),
      () => result({ behind_repos: ["."] }),
      {
        run: () => {
          throw new Error("spawn failed");
        },
        head: () => null,
      },
    );
    expect(out?.sync.outcome).toBe("failed");
    expect(out?.sync.commits_pulled).toBeNull();
    expect(out?.result.ok).toBe(false);
  });
});

describe("attemptEndTurnSync with a real command", () => {
  test("executes the configured shell command in the project root", () => {
    const root = project({ gitSyncOnEndTurn: true, gitSyncCommand: "echo synced > marker.txt" });
    const out = attemptEndTurnSync(root, result({ behind_repos: ["."] }), () =>
      result({ ok: true }),
    );
    expect(out?.sync.outcome).toBe("succeeded");
    expect(Bun.file(join(root, "marker.txt")).size).toBeGreaterThan(0);
  });
});

describe("endTurnSyncTimeoutMs", () => {
  const key = "HARNERY_END_TURN_SYNC_TIMEOUT_MS";
  afterEach(() => {
    delete process.env[key];
  });
  test("defaults to the full bound", () => {
    delete process.env[key];
    expect(endTurnSyncTimeoutMs()).toBe(END_TURN_SYNC_TIMEOUT_MS);
  });
  test("an override can only lower the bound", () => {
    process.env[key] = "9000";
    expect(endTurnSyncTimeoutMs()).toBe(9_000);
    process.env[key] = String(END_TURN_SYNC_TIMEOUT_MS * 10);
    expect(endTurnSyncTimeoutMs()).toBe(END_TURN_SYNC_TIMEOUT_MS);
    process.env[key] = "junk";
    expect(endTurnSyncTimeoutMs()).toBe(END_TURN_SYNC_TIMEOUT_MS);
  });
});
