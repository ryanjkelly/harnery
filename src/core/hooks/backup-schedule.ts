import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backupConfig } from "../config.ts";

const RUNNER = `
harn_bin="$1"
if_stale="$2"
log_file="$3"
shift 3
"$harn_bin" backup snapshot --if-stale "$if_stale" "$@" >>"$log_file" 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  printf 'harnery backup: scheduled snapshot failed; see %s\\n' "$log_file" >&2
fi
exit "$status"
`.trim();

export interface ScheduledBackupInvocation {
  harnBin: string;
  ifStale: string;
  tags: readonly string[];
  logFile: string;
}

export function scheduledBackupInvocation(coordRoot: string): ScheduledBackupInvocation | null {
  const schedule = backupConfig(coordRoot).schedule;
  if (!schedule) return null;
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  return {
    harnBin: join(packageRoot, "bin", "harn"),
    ifStale: schedule.ifStale,
    tags: schedule.tags,
    logFile: join(resolve(coordRoot), ".harnery", "logs", "backup-schedule.log"),
  };
}

/** Launch the configured SessionStart snapshot without extending hook latency. */
export function scheduleBackupSnapshot(coordRoot: string): boolean {
  const invocation = scheduledBackupInvocation(coordRoot);
  if (!invocation) return false;
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
      ...tagArgs,
    ],
    {
      cwd: resolve(coordRoot),
      detached: true,
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  child.once("error", () => {
    process.stderr.write(
      `harnery backup: scheduled snapshot could not start; see ${invocation.logFile}\n`,
    );
  });
  child.unref();
  return true;
}
