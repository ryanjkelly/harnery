import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBackupDuration, readHostSnapshotCache } from "../backup/host-snapshot.ts";
import { backupConfig } from "../config.ts";

/**
 * Detached runner for the scheduled snapshot. It owns no inherited stdio: a
 * hook that hands its stderr pipe to a background child keeps the harness
 * waiting until restic and the remote provider finish, which is the delay the
 * schedule exists to avoid. Output goes to the log; the exit code goes to the
 * status file the next session start reads.
 */
const RUNNER = `
harn_bin="$1"
if_stale="$2"
log_file="$3"
status_file="$4"
shift 4
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
if [ -f "$log_file" ] && [ "$(wc -c <"$log_file")" -gt 262144 ]; then
  tail -c 65536 "$log_file" >"$log_file.rotating" && mv "$log_file.rotating" "$log_file"
fi
printf '%s scheduled snapshot start (if-stale %s)\\n' "$(stamp)" "$if_stale" >>"$log_file"
"$harn_bin" backup snapshot --if-stale "$if_stale" "$@" >>"$log_file" 2>&1
status=$?
printf '%s scheduled snapshot exit %s\\n' "$(stamp)" "$status" >>"$log_file"
printf '{"exit_code":%s,"finished_at":"%s"}\\n' "$status" "$(stamp)" >"$status_file.tmp" && mv "$status_file.tmp" "$status_file"
exit "$status"
`.trim();

export interface ScheduledBackupInvocation {
  harnBin: string;
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

export function scheduledBackupInvocation(coordRoot: string): ScheduledBackupInvocation | null {
  const schedule = backupConfig(coordRoot).schedule;
  if (!schedule) return null;
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const logsDir = join(resolve(coordRoot), ".harnery", "logs");
  return {
    harnBin: join(packageRoot, "bin", "harn"),
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
export function planScheduledBackup(coordRoot: string, now = Date.now()): ScheduledBackupPlan {
  const invocation = scheduledBackupInvocation(coordRoot);
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

/** Launch the configured SessionStart snapshot without extending hook latency. */
export function scheduleBackupSnapshot(coordRoot: string): {
  launched: boolean;
  cue: string | null;
} {
  const plan = planScheduledBackup(coordRoot);
  if (plan.cue) process.stderr.write(`${plan.cue}\n`);
  if (plan.action !== "launch" || !plan.invocation) return { launched: false, cue: plan.cue };
  const invocation = plan.invocation;
  mkdirSync(dirname(invocation.logFile), { recursive: true });
  const tagArgs = invocation.tags.flatMap((tag) => ["--tag", tag]);
  const child = spawn(
    "bash",
    [
      "-c",
      RUNNER,
      "harnery-backup",
      invocation.harnBin,
      invocation.ifStale,
      invocation.logFile,
      invocation.statusFile,
      ...tagArgs,
    ],
    {
      cwd: resolve(coordRoot),
      detached: true,
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
