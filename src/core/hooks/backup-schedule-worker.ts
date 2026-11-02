/**
 * Detached worker for the scheduled SessionStart snapshot. Session start
 * launches this module with the running runtime (`process.execPath`), so the
 * schedule needs no shell: a `bash` on PATH may be a different system (WSL on
 * Windows) that cannot run the native CLI path, and a host may have no shell at
 * all.
 *
 * The worker owns no inherited stdio: a hook that hands its stderr pipe to a
 * background child keeps the harness waiting until restic and the remote
 * provider finish, which is the delay the schedule exists to avoid. Output goes
 * to the log; the exit code goes to the status file the next session start
 * reads.
 *
 * This module imports only `node:*` so the detached process starts quickly.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The flag that selects the worker when this module is run as a script. */
export const SCHEDULED_BACKUP_WORKER_FLAG = "--run-scheduled-backup";

/** This module's own file, which the launcher runs with `process.execPath`. */
export const SCHEDULED_BACKUP_WORKER_PATH = fileURLToPath(import.meta.url);

/** Rotate the log once it passes this size... */
export const SCHEDULED_BACKUP_LOG_MAX_BYTES = 262_144;
/** ...keeping only its most recent bytes. */
export const SCHEDULED_BACKUP_LOG_KEEP_BYTES = 65_536;

/** Exit code recorded when the CLI cannot be started, as a shell reports it. */
const START_FAILURE_EXIT = 127;

export interface ScheduledBackupWorkerSpec {
  /** The harn CLI entry script, run with `runtime`. */
  cliEntry: string;
  ifStale: string;
  tags: readonly string[];
  logFile: string;
  statusFile: string;
  /** The runtime that runs `cliEntry`; defaults to this process's own. */
  runtime?: string;
}

/** Run the scheduled snapshot once and record its output and exit code. Resolves to the exit code. */
export async function runScheduledBackupWorker(spec: ScheduledBackupWorkerSpec): Promise<number> {
  rotateLog(spec.logFile);
  appendFileSync(spec.logFile, `${stamp()} scheduled snapshot start (if-stale ${spec.ifStale})\n`);
  const status = await runSnapshot(spec);
  appendFileSync(spec.logFile, `${stamp()} scheduled snapshot exit ${status}\n`);
  const tmp = `${spec.statusFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ exit_code: status, finished_at: stamp() })}\n`);
  renameSync(tmp, spec.statusFile);
  return status;
}

function runSnapshot(spec: ScheduledBackupWorkerSpec): Promise<number> {
  if (!existsSync(spec.cliEntry)) {
    appendFileSync(spec.logFile, `harn CLI entry not found: ${spec.cliEntry}\n`);
    return Promise.resolve(START_FAILURE_EXIT);
  }
  const args = [
    spec.cliEntry,
    "backup",
    "snapshot",
    "--if-stale",
    spec.ifStale,
    ...spec.tags.flatMap((tag) => ["--tag", tag]),
  ];
  // The CLI writes straight to the log, so its output lands in order and
  // survives even if this worker is killed first.
  const fd = openSync(spec.logFile, "a");
  let child: ChildProcess;
  try {
    child = spawn(spec.runtime ?? process.execPath, args, {
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
  } catch (error) {
    closeSync(fd);
    appendFileSync(spec.logFile, `${errorMessage(error)}\n`);
    return Promise.resolve(START_FAILURE_EXIT);
  }
  closeSync(fd);
  return new Promise<number>((resolveExit) => {
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      resolveExit(code);
    };
    child.once("error", (error) => {
      appendFileSync(spec.logFile, `${error.message}\n`);
      settle(START_FAILURE_EXIT);
    });
    child.once("exit", (code, signal) => settle(exitStatus(code, signal)));
  });
}

/** A shell's status for a finished child: its code, or 128 + the signal number. */
function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal ? constants.signals[signal] : undefined;
  return typeof number === "number" ? 128 + number : 1;
}

function rotateLog(logFile: string): void {
  if (!existsSync(logFile)) return;
  const size = statSync(logFile).size;
  if (size <= SCHEDULED_BACKUP_LOG_MAX_BYTES) return;
  const keep = Buffer.alloc(SCHEDULED_BACKUP_LOG_KEEP_BYTES);
  const fd = openSync(logFile, "r");
  let read = 0;
  try {
    read = readSync(fd, keep, 0, keep.length, size - keep.length);
  } finally {
    closeSync(fd);
  }
  const rotating = `${logFile}.rotating`;
  writeFileSync(rotating, keep.subarray(0, read));
  renameSync(rotating, logFile);
}

/** UTC to the second, `2026-01-02T12:00:00Z`. */
function stamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseSpec(raw: string | undefined): ScheduledBackupWorkerSpec {
  const parsed = JSON.parse(raw ?? "null") as Partial<ScheduledBackupWorkerSpec> | null;
  if (
    !parsed ||
    typeof parsed.cliEntry !== "string" ||
    typeof parsed.ifStale !== "string" ||
    !Array.isArray(parsed.tags) ||
    !parsed.tags.every((tag) => typeof tag === "string") ||
    typeof parsed.logFile !== "string" ||
    typeof parsed.statusFile !== "string" ||
    (parsed.runtime !== undefined && typeof parsed.runtime !== "string")
  ) {
    throw new Error("invalid scheduled backup worker specification");
  }
  return parsed as ScheduledBackupWorkerSpec;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (
  invokedPath === resolve(SCHEDULED_BACKUP_WORKER_PATH) &&
  process.argv[2] === SCHEDULED_BACKUP_WORKER_FLAG
) {
  void Promise.resolve()
    .then(() => runScheduledBackupWorker(parseSpec(process.argv[3])))
    .then(
      (status) => {
        process.exitCode = status;
      },
      (error) => {
        process.stderr.write(`${errorMessage(error)}\n`);
        process.exitCode = 1;
      },
    );
}
