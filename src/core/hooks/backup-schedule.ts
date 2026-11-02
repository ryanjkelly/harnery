import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseBackupDuration, readHostSnapshotCache } from "../backup/host-snapshot.ts";
import { harnCliEntry } from "../cli-entry.ts";
import { backupConfig } from "../config.ts";
import {
  SCHEDULED_BACKUP_WORKER_FLAG,
  SCHEDULED_BACKUP_WORKER_PATH,
  type ScheduledBackupWorkerSpec,
} from "./backup-schedule-worker.ts";

export interface ScheduledBackupInvocation {
  /** The harn CLI entry script the worker runs with `process.execPath`. */
  cliEntry: string;
  ifStale: string;
  tags: readonly string[];
  logFile: string;
  statusFile: string;
}

export interface ScheduledBackupStatus {
  exitCode: number;
  finishedAt: string;
}

export interface ScheduledBackupPlan {
  /** `disabled`: no schedule; `fresh`: local cache proves this host is current; `launch`: run the snapshot. */
  action: "disabled" | "fresh" | "launch";
  /** One line for the session context when the previous scheduled run failed. */
  cue: string | null;
  invocation: ScheduledBackupInvocation | null;
}

export function scheduledBackupInvocation(
  coordRoot: string,
  cliEntry: string = harnCliEntry(),
): ScheduledBackupInvocation | null {
  const schedule = backupConfig(coordRoot).schedule;
  if (!schedule) return null;
  const logsDir = join(resolve(coordRoot), ".harnery", "logs");
  return {
    cliEntry,
    ifStale: schedule.ifStale,
    tags: schedule.tags,
    logFile: join(logsDir, "backup-schedule.log"),
    statusFile: join(logsDir, "backup-schedule.status.json"),
  };
}

export function readScheduledBackupStatus(statusFile: string): ScheduledBackupStatus | null {
  if (!existsSync(statusFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statusFile, "utf8")) as {
      exit_code?: unknown;
      finished_at?: unknown;
    };
    if (typeof parsed.exit_code !== "number" || typeof parsed.finished_at !== "string") {
      return null;
    }
    return { exitCode: parsed.exit_code, finishedAt: parsed.finished_at };
  } catch {
    return null;
  }
}

/**
 * Decide what session start should do. The local host cache written by
 * `harn backup snapshot` is only an optimisation: when it is missing, stale,
 * or from another host, the launched command still asks restic. A failed
 * previous run always relaunches so a transient error heals on the next
 * session instead of waiting out the freshness window.
 */
export function planScheduledBackup(
  coordRoot: string,
  now = Date.now(),
  cliEntry?: string,
): ScheduledBackupPlan {
  const invocation = scheduledBackupInvocation(coordRoot, cliEntry);
  if (!invocation) return { action: "disabled", cue: null, invocation: null };
  const status = readScheduledBackupStatus(invocation.statusFile);
  const failed = status !== null && status.exitCode !== 0;
  const cue = failed
    ? `harnery backup: the last scheduled snapshot failed (exit ${status.exitCode} at ${status.finishedAt}); see ${invocation.logFile}. Fix the cause or run \`harn backup snapshot --if-stale ${invocation.ifStale}\` to retry.`
    : null;
  const staleMs = parseBackupDuration(invocation.ifStale);
  const cache = readHostSnapshotCache(join(resolve(coordRoot), ".harnery"));
  const fresh =
    !failed &&
    staleMs !== null &&
    cache !== null &&
    cache.host === hostname() &&
    now - cache.snapshotAt < staleMs;
  return { action: fresh ? "fresh" : "launch", cue, invocation };
}

/**
 * Launch the configured SessionStart snapshot without extending hook latency.
 * `options.cliEntry` replaces the harn CLI entry the worker runs.
 */
export function scheduleBackupSnapshot(
  coordRoot: string,
  options: { cliEntry?: string } = {},
): {
  launched: boolean;
  cue: string | null;
} {
  const plan = planScheduledBackup(coordRoot, Date.now(), options.cliEntry);
  if (plan.cue) process.stderr.write(`${plan.cue}\n`);
  if (plan.action !== "launch" || !plan.invocation) return { launched: false, cue: plan.cue };
  const invocation = plan.invocation;
  mkdirSync(dirname(invocation.logFile), { recursive: true });
  const spec: ScheduledBackupWorkerSpec = {
    cliEntry: invocation.cliEntry,
    ifStale: invocation.ifStale,
    tags: invocation.tags,
    logFile: invocation.logFile,
    statusFile: invocation.statusFile,
  };
  // The worker runs on this process's own runtime, so the launch needs no
  // shell and works the same on Windows, macOS and Linux.
  const child = spawn(
    process.execPath,
    [SCHEDULED_BACKUP_WORKER_PATH, SCHEDULED_BACKUP_WORKER_FLAG, JSON.stringify(spec)],
    {
      cwd: resolve(coordRoot),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  child.once("error", () => {
    process.stderr.write(
      `harnery backup: scheduled snapshot could not start; see ${invocation.logFile}\n`,
    );
  });
  child.unref();
  return { launched: true, cue: plan.cue };
}
