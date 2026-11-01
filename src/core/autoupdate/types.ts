/**
 * Shared contracts for project self-update (ADR 0229).
 *
 * Activity fires it: every prompt, session start, and host CLI command calls
 * `autoUpdateTick`, whose hot path is one stat of a throttle stamp. When the
 * stamp is stale, the tick launches a detached `<harn> autoupdate run
 * --background`, which exits early unless the upstream branch moved, a
 * watched path outside Git changed, the daily check is due, or the last run
 * failed. Only then does it run the host's configured steps.
 */

/** `.harnery/config.jsonc` `autoUpdate` section, after lenient parsing. */
export interface AutoUpdateConfig {
  enabled: boolean;
  /** Minimum minutes between remote checks. Default 15, range 1..1440. */
  checkMinutes: number;
  /** Argv arrays run in order from the project root when an update is needed; first failure stops. */
  steps: string[][];
  /** Argv arrays run at most once per 24h even when current (e.g. a doctor). */
  dailySteps: string[][];
  /**
   * Paths outside Git whose change forces a run (managed tools, generated
   * hook configs). `~/` and `$VAR` expand; relative paths resolve from the
   * project root. A directory is fingerprinted shallowly (its own mtime plus
   * each direct child's mtime and size).
   */
  watch: string[];
  /** Per-step timeout in minutes. Default 20. */
  timeoutMinutes: number;
  /** Run `artifacts clean --yes` (expired only) at most once per day after a successful run. Default true. */
  cleanup: boolean;
}

export const AUTOUPDATE_DEFAULTS = {
  checkMinutes: 15,
  timeoutMinutes: 20,
  /** After a failed run, wait at least this long before the next attempt. */
  failureBackoffMinutes: 60,
  dailyHours: 24,
} as const;

/**
 * Step output protocol. A line `harnery-notice: <text>` (stdout or stderr)
 * becomes a notice for the agents in this checkout. Exit code 75 means the
 * step finished what it could but needs a person (outcome `blocked`), which
 * is not retried as a failure.
 */
export const NOTICE_PREFIX = "harnery-notice:";
export const EXIT_NEEDS_PERSON = 75;

export type CheckReason =
  | "disabled"
  | "behind" // upstream has a commit HEAD does not contain
  | "drift" // a watched path changed since the last converged run
  | "daily" // daily steps are due
  | "retry" // last run failed and the backoff elapsed
  | "forced"
  | "current" // nothing to do
  | "no-upstream" // detached or untracked branch and no drift
  | "offline"; // ls-remote failed

export interface CheckDecision {
  needed: boolean;
  reason: CheckReason;
  head: string | null;
  upstream: string | null; // e.g. "origin/main"
  remoteSha: string | null;
  fingerprint: string;
  /** True when only daily steps should run (repo already current). */
  dailyOnly: boolean;
  detail?: string;
}

export type NoticeKind = "instructions" | "hooks" | "person" | "failure" | "info";

export interface AutoUpdateNotice {
  id: string;
  at: string;
  kind: NoticeKind;
  text: string;
}

export interface StepRecord {
  argv: string[];
  exitCode: number | null;
  ms: number;
  timedOut?: boolean;
}

export type RunOutcome =
  | "current"
  | "updated"
  | "blocked"
  | "failed"
  | "skipped-locked"
  | "offline";

export interface RunRecord {
  startedAt: string;
  finishedAt: string;
  outcome: RunOutcome;
  reason: CheckReason;
  fromHead: string | null;
  toHead: string | null;
  steps: StepRecord[];
  error?: string;
}

/** `.harnery/private/autoupdate/state.json`. */
export interface AutoUpdateState {
  schema: 1;
  converged?: { head: string; remoteSha: string | null; fingerprint: string; at: string };
  lastRun?: RunRecord;
  dailyAt?: string;
  cleanupAt?: string;
  notices: AutoUpdateNotice[];
  /** Per session key (agent instance id), the `at` of the newest notice already delivered. */
  delivered: Record<string, string>;
}

export interface TickResult {
  action: "disabled" | "throttled" | "locked" | "launched" | "error";
  detail?: string;
}

/** Files under `.harnery/private/autoupdate/` (except `log`, see below). */
export const AUTOUPDATE_FILES = {
  dir: ".harnery/private/autoupdate",
  /** Throttle stamp; only its mtime matters. */
  stamp: "checked-at",
  state: "state.json",
  lock: "run.lock",
  /** Run log lives at .harnery/logs/autoupdate.log (not in this dir). */
  log: "autoupdate.log",
} as const;
