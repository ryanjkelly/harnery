/**
 * Opt-in automatic catch-up for the closing status check.
 *
 * In a shared repository other sessions push constantly, so the closing
 * `agents status --end-turn` often refuses only because the checkout is behind
 * its upstream or a submodule checkout trails its parent gitlink. Nothing of
 * the session's own is unfinished, yet the agent must run the host's sync
 * command by hand and retry.
 *
 * When the project opts in (`agents.gitSyncOnEndTurn: true`) and the ONLY
 * failing findings are that kind of freshness, the closing status runs the
 * configured `agents.gitSyncCommand` once, with a bounded timeout, then repeats
 * the full finalization check. Anything else (owned dirty or unpushed work, a
 * diverged submodule, an unverifiable repository, an incomplete claim history)
 * refuses exactly as before, and the sync never runs. A sync that fails, times
 * out, or leaves findings behind also refuses. The freshness rule itself is
 * unchanged: a stale clone still cannot report success.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coordEnv } from "../../lib/env.ts";
import { agentsGitSyncCommand, stripJsonComments } from "../config.ts";
import type { GitFinalizationResult } from "./finalization.ts";

/** Upper bound on one automatic sync run. */
export const END_TURN_SYNC_TIMEOUT_MS = 120_000;

/**
 * Whether the project opted in to the automatic end-of-turn sync.
 *
 * Project config only, like `agents.gitSyncCommand`: the setting makes the
 * closing status execute a command, and a user-global file must not be able to
 * turn that on for another project.
 *
 * `.harnery/config.jsonc`: `{ "agents": { "gitSyncOnEndTurn": true } }`
 *
 * `HARNERY_AGENTS_GIT_SYNC_ON_END_TURN=0` disables it per process; `=1` cannot
 * enable it without a configured sync command.
 */
export function agentsGitSyncOnEndTurn(coordRoot: string): boolean {
  const env = coordEnv("AGENTS_GIT_SYNC_ON_END_TURN");
  if (env === "0") return false;
  if (env === "1") return true;
  try {
    const raw = readFileSync(join(coordRoot, ".harnery", "config.jsonc"), "utf8");
    const parsed = JSON.parse(stripJsonComments(raw)) as {
      agents?: { gitSyncOnEndTurn?: unknown };
    } | null;
    return parsed?.agents?.gitSyncOnEndTurn === true;
  } catch {
    return false;
  }
}

/**
 * True when the result fails only because the checkout is behind its upstream
 * or a submodule checkout trails its parent gitlink. Any owned-work finding, a
 * diverged submodule, or an unverifiable state disqualifies it.
 */
export function isFreshnessOnlyFailure(result: GitFinalizationResult): boolean {
  return (
    !result.ok &&
    result.claim_history_complete &&
    result.dirty_paths.length === 0 &&
    result.unpushed_repos.length === 0 &&
    result.diverged_submodules.length === 0 &&
    result.unsupported_paths.length === 0 &&
    result.unverifiable_paths.length === 0 &&
    result.unverifiable_repos.length === 0 &&
    (result.behind_repos.length > 0 || result.stale_submodules.length > 0)
  );
}

export interface EndTurnSyncRun {
  command: string;
  outcome: "succeeded" | "failed" | "timed_out";
  exit_code: number | null;
  /** Commits the root checkout gained, or null when HEAD could not be read. */
  commits_pulled: number | null;
  /** Submodule checkouts that were stale before the sync and are current after it. */
  submodules_updated: string[];
  /** Last lines of the command's combined output when it did not succeed. */
  output_tail?: string;
}

export interface EndTurnSyncDependencies {
  run?: (
    command: string,
    cwd: string,
    timeoutMs: number,
  ) => { status: number | null; timedOut: boolean; output: string };
  head?: (cwd: string) => string | null;
  countCommits?: (cwd: string, from: string, to: string) => number | null;
}

function defaultRun(
  command: string,
  cwd: string,
  timeoutMs: number,
): { status: number | null; timedOut: boolean; output: string } {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
  const timedOut =
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
    (result.status === null && result.signal === "SIGTERM");
  return {
    status: result.status,
    timedOut,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function defaultHead(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

function defaultCountCommits(cwd: string, from: string, to: string): number | null {
  const r = spawnSync("git", ["rev-list", "--count", `${from}..${to}`], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function tail(output: string, lines = 6): string {
  return output.trimEnd().split("\n").slice(-lines).join("\n");
}

/**
 * Run the sync command once and re-check finalization. Returns null when the
 * automatic sync does not apply (not opted in, no command, or a failure that is
 * not freshness-only), in which case the caller refuses as usual.
 */
export function attemptEndTurnSync(
  coordRoot: string,
  initial: GitFinalizationResult,
  recheck: () => GitFinalizationResult,
  dependencies: EndTurnSyncDependencies = {},
  timeoutMs = END_TURN_SYNC_TIMEOUT_MS,
): { sync: EndTurnSyncRun; result: GitFinalizationResult } | null {
  if (!isFreshnessOnlyFailure(initial)) return null;
  if (!agentsGitSyncOnEndTurn(coordRoot)) return null;
  const command = agentsGitSyncCommand(coordRoot);
  if (!command) return null;

  const head = dependencies.head ?? defaultHead;
  const countCommits = dependencies.countCommits ?? defaultCountCommits;
  const before = head(coordRoot);
  let ran: { status: number | null; timedOut: boolean; output: string };
  try {
    ran = (dependencies.run ?? defaultRun)(command, coordRoot, timeoutMs);
  } catch (err) {
    ran = { status: null, timedOut: false, output: String(err) };
  }
  const outcome: EndTurnSyncRun["outcome"] = ran.timedOut
    ? "timed_out"
    : ran.status === 0
      ? "succeeded"
      : "failed";
  const after = head(coordRoot);
  const result = recheck();
  const stillStale = new Set(result.stale_submodules);
  const sync: EndTurnSyncRun = {
    command,
    outcome,
    exit_code: ran.status,
    commits_pulled:
      before && after ? (before === after ? 0 : countCommits(coordRoot, before, after)) : null,
    submodules_updated: initial.stale_submodules.filter((path) => !stillStale.has(path)),
    ...(outcome === "succeeded" ? {} : { output_tail: tail(ran.output) }),
  };
  // A failed or timed-out command never counts as a pass, even when the
  // checkout happens to look current afterwards.
  if (outcome !== "succeeded" && result.ok) {
    return { sync, result: { ...result, ok: false } };
  }
  return { sync, result };
}

/** One plain line describing what the sync did, for the status box. */
export function formatEndTurnSyncSummary(sync: EndTurnSyncRun): string {
  if (sync.outcome === "timed_out") {
    return `ran \`${sync.command}\`; it timed out after ${Math.round(END_TURN_SYNC_TIMEOUT_MS / 1000)}s`;
  }
  if (sync.outcome === "failed") {
    return `ran \`${sync.command}\`; it failed (exit ${sync.exit_code ?? "unknown"})`;
  }
  const parts: string[] = [];
  if (sync.commits_pulled === null) parts.push("new upstream commits");
  else if (sync.commits_pulled > 0)
    parts.push(`${sync.commits_pulled} upstream commit${sync.commits_pulled === 1 ? "" : "s"}`);
  if (sync.submodules_updated.length > 0) {
    parts.push(
      `updated submodule${sync.submodules_updated.length === 1 ? "" : "s"} ${sync.submodules_updated.join(", ")}`,
    );
  }
  const brought = parts.length > 0 ? parts.join(" and ") : "no new commits";
  return `ran \`${sync.command}\` to catch up; brought in ${brought}`;
}

/** Refusal preface used when an automatic sync ran but did not clear the check. */
export function formatEndTurnSyncRefusal(sync: EndTurnSyncRun): string {
  const lines = [`Harnery tried to catch up automatically: ${formatEndTurnSyncSummary(sync)}.`];
  if (sync.outcome === "succeeded") {
    lines.push("The checkout is still not clean after the sync; the findings below remain.");
  } else if (sync.output_tail) {
    lines.push(
      "Last output from the sync command:",
      ...sync.output_tail.split("\n").map((l) => `  ${l}`),
    );
  }
  return lines.join("\n");
}
