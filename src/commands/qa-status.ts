// `qa-status [path]`: report where a qa-run stands from its on-disk state:
// live (launching, queued, running), dead (non-terminal status document with
// a dead PID), or terminal (result document written; the state is the run's
// verdict). Classification is fail-closed: liveness is proven by the PID,
// never assumed from the status document, and the result document is
// authoritative over the status document once it exists. `--wait` reconnects
// to a detached run and exits with its verdict; `--queue` shows the
// machine-wide admission queue instead of any one run.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { latestManagedQaRun, resolveQaRepoRoot } from "../core/qa-artifacts.ts";
import {
  type AdmissionEntry,
  admissionBaseDir,
  admissionStatus,
  pidAlive as defaultPidAlive,
  listAdmissionResources,
} from "../lib/admission.ts";
import {
  QA_RUN_LATEST_FILENAME,
  QA_RUN_RESULT_FILENAME,
  QA_RUN_STATUS_FILENAME,
} from "../lib/browser/qa-run.ts";
import {
  QA_RUN_STAGES,
  type QaRunStage,
  type QaRunVerdict,
} from "../lib/browser/qa-run-contracts.ts";
import { QA_ADMISSION_RESOURCE } from "./qa-run.ts";

/** A running state whose heartbeat is older than this earns a staleness
 * warning, but stays "running" while the PID is alive. */
export const QA_STATUS_HEARTBEAT_STALE_MS = 120_000;

/** Log file `qa-run --detach` leaves in the run directory. */
const RUNNER_LOG_FILENAME = "runner.log";

const POLL_MS = 2_000;
const DEFAULT_WAIT_TIMEOUT_MINUTES = 60;

const STATUS_DOC_STATES = new Set(["launching", "queued", "running", "completed"]);

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonRead = { ok: true; value: unknown } | { ok: false; error: string };

function readJsonFile(path: string): JsonRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: unknown) {
    return { ok: false, error: `cannot read ${path}: ${describeError(err)}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err: unknown) {
    return { ok: false, error: `${path} is not valid JSON: ${describeError(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export type RunDirResolution = { ok: true; runDir: string } | { ok: false; error: string };

function hasRunFiles(dir: string): boolean {
  return (
    existsSync(join(dir, QA_RUN_STATUS_FILENAME)) || existsSync(join(dir, QA_RUN_RESULT_FILENAME))
  );
}

/** Best-effort started_at for one run directory: the status document's
 * `started_at`, falling back to the result document's `run.started_at`. */
function startedAtOf(dir: string): string | undefined {
  const statusPath = join(dir, QA_RUN_STATUS_FILENAME);
  if (existsSync(statusPath)) {
    const read = readJsonFile(statusPath);
    if (read.ok && isRecord(read.value) && typeof read.value.started_at === "string") {
      return read.value.started_at;
    }
  }
  const resultPath = join(dir, QA_RUN_RESULT_FILENAME);
  if (existsSync(resultPath)) {
    const read = readJsonFile(resultPath);
    if (read.ok && isRecord(read.value) && isRecord(read.value.run)) {
      const startedAt = read.value.run.started_at;
      if (typeof startedAt === "string") return startedAt;
    }
  }
  return undefined;
}

/**
 * Resolve `[path]` to a run directory. A file is a result document (its
 * directory is the run directory); a directory carrying a status or result
 * document is the run directory itself; any other directory is treated as a
 * run PARENT: its `run-*` children are scanned and the one with the newest
 * started_at wins, falling back to the `latest.json` pointer when no child
 * carries a status or result. Without a path, the newest managed QA artifact
 * under the repository's `.harnery/artifacts/` store is used.
 */
export function resolveRunDir(inputPath?: string, repoRoot?: string): RunDirResolution {
  if (inputPath === undefined) {
    const latest = latestManagedQaRun(repoRoot ?? resolveQaRepoRoot());
    if (!latest) {
      return {
        ok: false,
        error: "no managed qa-run or qa-record output exists under .harnery/artifacts",
      };
    }
    return { ok: true, runDir: latest };
  }
  const abs = resolve(inputPath);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(abs);
  } catch (err: unknown) {
    return { ok: false, error: `cannot access ${abs}: ${describeError(err)}` };
  }
  if (stats.isFile()) return { ok: true, runDir: dirname(abs) };
  if (!stats.isDirectory()) {
    return { ok: false, error: `${abs} is neither a file nor a directory` };
  }
  if (hasRunFiles(abs)) return { ok: true, runDir: abs };

  // Run parent: newest run-*/ child by started_at.
  let childNames: string[] = [];
  try {
    childNames = readdirSync(abs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    childNames = [];
  }
  let best: { dir: string; startedAtMs: number } | undefined;
  for (const name of childNames) {
    const child = join(abs, name);
    if (!hasRunFiles(child)) continue;
    const startedAt = startedAtOf(child);
    const startedAtMs = startedAt !== undefined ? Date.parse(startedAt) : Number.NaN;
    if (Number.isNaN(startedAtMs)) continue;
    if (!best || startedAtMs > best.startedAtMs) best = { dir: child, startedAtMs };
  }
  if (best) return { ok: true, runDir: best.dir };

  const pointerPath = join(abs, QA_RUN_LATEST_FILENAME);
  if (existsSync(pointerPath)) {
    const pointer = readJsonFile(pointerPath);
    if (!pointer.ok) return pointer;
    if (isRecord(pointer.value)) {
      const record = pointer.value;
      let rel: string | undefined;
      if (typeof record.dir === "string" && record.dir.length > 0) rel = record.dir;
      else if (typeof record.result === "string" && record.result.length > 0) {
        rel = dirname(record.result);
      }
      if (rel !== undefined) return { ok: true, runDir: resolve(abs, rel) };
    }
    return { ok: false, error: `${pointerPath} carries no run directory to follow` };
  }
  return {
    ok: false,
    error:
      `${abs} carries no ${QA_RUN_STATUS_FILENAME} or ${QA_RUN_RESULT_FILENAME}, no run-*/ ` +
      `child with either, and no ${QA_RUN_LATEST_FILENAME} pointer`,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type QaStatusState = QaRunVerdict | "launching" | "queued" | "running" | "dead";

export interface QaStatusReport {
  state: QaStatusState;
  /** The result document exists; state is the run's final verdict. */
  terminal: boolean;
  /** 0 completed-passed · 2 completed-failed · 4 completed-incomplete or
   * dead · 5 still in progress. */
  exit: 0 | 2 | 4 | 5;
  run_id: string | null;
  pid: number | null;
  stage: QaRunStage | null;
  started_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  /** now minus the status document's updated_at; null without a heartbeat. */
  heartbeat_age_ms: number | null;
  verdict?: QaRunVerdict;
  result_path?: string;
  log_path?: string;
  queue?: { resource: string; waiting_since: string };
  wall_time_ms?: Record<string, number>;
  warnings: string[];
}

export interface QaStatusDeps {
  /** PID liveness probe (injectable for tests). Default: process.kill(pid, 0). */
  pidAlive?: (pid: number) => boolean;
  /** Evaluation instant in epoch milliseconds. Default: Date.now(). */
  now?: () => number;
}

export type QaStatusClassification =
  | { ok: true; report: QaStatusReport }
  | { ok: false; error: string };

function exitForVerdict(verdict: QaRunVerdict): 0 | 2 | 4 {
  if (verdict === "passed") return 0;
  if (verdict === "failed") return 2;
  return 4;
}

/**
 * Classify one run directory, fail-closed. The result document is terminal
 * and authoritative when it exists; otherwise the status document plus a PID
 * liveness probe decides between a live state and "dead". Neither file is a
 * usage error, not a state.
 */
export function classifyRun(runDir: string, deps: QaStatusDeps = {}): QaStatusClassification {
  const isAlive = deps.pidAlive ?? defaultPidAlive;
  const nowMs = deps.now ? deps.now() : Date.now();
  const abs = resolve(runDir);
  const resultPath = join(abs, QA_RUN_RESULT_FILENAME);
  const statusPath = join(abs, QA_RUN_STATUS_FILENAME);
  const logPath = join(abs, RUNNER_LOG_FILENAME);
  const logExists = existsSync(logPath);
  const resultExists = existsSync(resultPath);

  // The status document supplies pid/stage/heartbeat even for terminal runs,
  // so read it best-effort first; a broken status only matters when it is
  // the sole evidence.
  let status: Record<string, unknown> | undefined;
  if (existsSync(statusPath)) {
    const read = readJsonFile(statusPath);
    if (read.ok && isRecord(read.value)) status = read.value;
    else if (!resultExists) {
      return { ok: false, error: read.ok ? `${statusPath} is not a status object` : read.error };
    }
  }

  let heartbeatAgeMs: number | null = null;
  if (status && typeof status.updated_at === "string") {
    const updatedMs = Date.parse(status.updated_at);
    if (!Number.isNaN(updatedMs)) heartbeatAgeMs = Math.max(0, nowMs - updatedMs);
  }

  if (resultExists) {
    const read = readJsonFile(resultPath);
    if (!read.ok) return read;
    if (!isRecord(read.value)) {
      return { ok: false, error: `${resultPath} is not a result object` };
    }
    const result = read.value;
    const verdict = result.verdict;
    if (verdict !== "passed" && verdict !== "failed" && verdict !== "incomplete") {
      return { ok: false, error: `${resultPath} carries no recognizable verdict` };
    }
    const run = isRecord(result.run) ? result.run : {};
    const statusRunId = typeof status?.run_id === "string" ? status.run_id : null;
    return {
      ok: true,
      report: {
        state: verdict,
        terminal: true,
        exit: exitForVerdict(verdict),
        run_id: typeof run.run_id === "string" ? run.run_id : statusRunId,
        pid: typeof status?.pid === "number" ? status.pid : null,
        stage: null,
        started_at: typeof run.started_at === "string" ? run.started_at : null,
        updated_at: typeof status?.updated_at === "string" ? status.updated_at : null,
        completed_at: typeof run.completed_at === "string" ? run.completed_at : null,
        heartbeat_age_ms: heartbeatAgeMs,
        verdict,
        result_path: resultPath,
        ...(logExists ? { log_path: logPath } : {}),
        ...(isRecord(result.wall_time_ms)
          ? { wall_time_ms: result.wall_time_ms as Record<string, number> }
          : {}),
        warnings: [],
      },
    };
  }

  if (!status) {
    return {
      ok: false,
      error:
        `${abs} carries neither ${QA_RUN_RESULT_FILENAME} nor ${QA_RUN_STATUS_FILENAME}: ` +
        "not a qa-run directory",
    };
  }

  const docState = typeof status.state === "string" ? status.state : "";
  if (!STATUS_DOC_STATES.has(docState)) {
    return {
      ok: false,
      error: `${statusPath} carries unrecognized state ${JSON.stringify(status.state)}`,
    };
  }
  const pid = typeof status.pid === "number" ? status.pid : 0;
  const runId = typeof status.run_id === "string" ? status.run_id : null;
  const stage =
    typeof status.stage === "string" && (QA_RUN_STAGES as readonly string[]).includes(status.stage)
      ? (status.stage as QaRunStage)
      : null;
  const startedAt = typeof status.started_at === "string" ? status.started_at : null;
  const updatedAt = typeof status.updated_at === "string" ? status.updated_at : null;

  const alive = pid > 0 && isAlive(pid);
  if (!alive) {
    return {
      ok: true,
      report: {
        state: "dead",
        terminal: false,
        exit: 4,
        run_id: runId,
        pid: pid > 0 ? pid : null,
        stage,
        started_at: startedAt,
        updated_at: updatedAt,
        completed_at: null,
        heartbeat_age_ms: heartbeatAgeMs,
        log_path: logPath,
        warnings: [],
      },
    };
  }

  const warnings: string[] = [];
  let state: QaStatusState;
  if (docState === "completed") {
    // The status document claims completion but no result document exists.
    // The PID is alive, so the runner may still be writing; stay "running"
    // and say so rather than inventing a verdict.
    state = "running";
    warnings.push(
      `${QA_RUN_STATUS_FILENAME} says completed but no ${QA_RUN_RESULT_FILENAME} exists yet; ` +
        "treating as running while the PID is alive",
    );
  } else {
    state = docState as "launching" | "queued" | "running";
  }
  if (
    state === "running" &&
    heartbeatAgeMs !== null &&
    heartbeatAgeMs > QA_STATUS_HEARTBEAT_STALE_MS
  ) {
    warnings.push(
      `heartbeat stale: last update ${Math.round(heartbeatAgeMs / 1000)}s ago ` +
        `(threshold ${QA_STATUS_HEARTBEAT_STALE_MS / 1000}s), but pid ${pid} is alive`,
    );
  }
  const queueValue = status.queue;
  const queue =
    isRecord(queueValue) &&
    typeof queueValue.resource === "string" &&
    typeof queueValue.waiting_since === "string"
      ? { resource: queueValue.resource, waiting_since: queueValue.waiting_since }
      : undefined;

  return {
    ok: true,
    report: {
      state,
      terminal: false,
      exit: 5,
      run_id: runId,
      pid,
      stage,
      started_at: startedAt,
      updated_at: updatedAt,
      completed_at: null,
      heartbeat_age_ms: heartbeatAgeMs,
      ...(queue ? { queue } : {}),
      ...(logExists ? { log_path: logPath } : {}),
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function formatAge(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function renderReport(emit: EmitContext, report: QaStatusReport): void {
  const runId = report.run_id ?? "(no run id)";
  if (report.terminal) {
    const completed = report.completed_at ? `, completed ${report.completed_at}` : "";
    emit.log(
      `run ${runId}: verdict ${report.verdict}${completed} (${report.result_path})`,
      report.state === "passed" ? "info" : "warn",
    );
    if (report.wall_time_ms) {
      const total = report.wall_time_ms.total;
      const queueMs = report.wall_time_ms.queue;
      const totalPart = total !== undefined ? `total ${total}ms` : "total unknown";
      const queuePart = queueMs !== undefined ? `, queue wait ${queueMs}ms` : "";
      emit.log(`wall time: ${totalPart}${queuePart}`, "info");
    }
  } else if (report.state === "dead") {
    const bits = [
      `pid ${report.pid ?? "unknown"} not running`,
      ...(report.stage !== null ? [`last stage ${report.stage}`] : []),
      ...(report.heartbeat_age_ms !== null
        ? [`last heartbeat ${formatAge(report.heartbeat_age_ms)} ago`]
        : []),
    ];
    emit.log(`run ${runId}: dead, ${bits.join(", ")}`, "warn");
    if (report.log_path !== undefined) emit.log(`log: ${report.log_path}`, "warn");
  } else {
    const bits = [
      ...(report.stage !== null ? [`stage ${report.stage}`] : []),
      `pid ${report.pid ?? "unknown"}`,
      ...(report.heartbeat_age_ms !== null
        ? [`heartbeat ${formatAge(report.heartbeat_age_ms)} ago`]
        : []),
    ];
    emit.log(`run ${runId}: ${report.state}, ${bits.join(", ")}`, "info");
    if (report.queue) {
      emit.log(`queued for ${report.queue.resource} since ${report.queue.waiting_since}`, "info");
    }
  }
  for (const warning of report.warnings) emit.log(`warning: ${warning}`, "warn");
}

function describeAdmissionEntry(
  entry: AdmissionEntry,
  nowMs: number,
  verb: "acquired" | "queued",
): string {
  const stamp = verb === "acquired" ? (entry.acquired_at ?? entry.created_at) : entry.created_at;
  const ageMs = nowMs - Date.parse(stamp);
  const age = Number.isNaN(ageMs) ? `${verb} at unknown time` : `${verb} ${formatAge(ageMs)} ago`;
  return `${entry.label || "(no label)"} (pid ${entry.pid}), ${age}`;
}

function runQueueAction(emit: EmitContext, json: boolean): void {
  const dir = admissionBaseDir();
  const nowMs = Date.now();
  const names = new Set(listAdmissionResources(dir));
  names.add(QA_ADMISSION_RESOURCE);
  // browser-qa first, everything else alphabetical.
  const ordered = [...names].sort((a, b) => {
    if (a === QA_ADMISSION_RESOURCE) return -1;
    if (b === QA_ADMISSION_RESOURCE) return 1;
    return a.localeCompare(b);
  });
  const resources = ordered.map((resource) => admissionStatus({ dir, resource }));
  if (json) {
    emit.data({ dir, resources });
    return;
  }
  for (const entry of resources) {
    const holders = entry.holders.length;
    const waiters = entry.waiters.length;
    emit.log(
      `${entry.resource}: ${holders} holder${holders === 1 ? "" : "s"}, ${waiters} waiting`,
      "info",
    );
    for (const holder of entry.holders) {
      emit.log(`  holding: ${describeAdmissionEntry(holder, nowMs, "acquired")}`, "info");
    }
    for (const waiter of entry.waiters) {
      emit.log(`  waiting: ${describeAdmissionEntry(waiter, nowMs, "queued")}`, "info");
    }
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

interface QaStatusOpts {
  json?: boolean;
  wait?: boolean;
  waitTimeout?: string;
  queue?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function registerQaStatusCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  program
    .command("qa-status [path]")
    .description(
      "Report where a qa-run stands from its on-disk state: live (launching, queued, " +
        "running), dead (non-terminal status with a dead PID), or terminal (result " +
        "document written; the state is the verdict). Fail-closed: liveness is proven " +
        "by the PID, never assumed from the status document.",
    )
    .option("--json", "Print the status envelope as JSON.")
    .option("--wait", "Poll every 2s until the run reaches a terminal verdict or is dead.")
    .option(
      "--wait-timeout <minutes>",
      `Maximum --wait duration in minutes (default ${DEFAULT_WAIT_TIMEOUT_MINUTES}).`,
    )
    .option(
      "--queue",
      "Ignore [path] and print the machine-wide admission queue instead: holders and " +
        "waiters per resource, dead entries pruned on the way.",
    )
    .addHelpText(
      "after",
      `\n[path] may be a ${QA_RUN_RESULT_FILENAME} file, a run directory (containing ` +
        `${QA_RUN_STATUS_FILENAME} or ${QA_RUN_RESULT_FILENAME}), or a run parent directory ` +
        `(newest run-*/ child by started_at, falling back to the ${QA_RUN_LATEST_FILENAME} ` +
        `pointer). Without [path], the newest managed run under .harnery/artifacts is used.` +
        "\n\nExit codes: 0 completed passed · 1 usage or unreadable state · " +
        "2 completed failed · 4 completed incomplete or dead · " +
        "5 still in progress (or --wait timeout).",
    )
    .action(async (path: string | undefined, opts: QaStatusOpts) => {
      if (opts.queue) {
        runQueueAction(emit, opts.json === true);
        return;
      }

      let waitTimeoutMinutes = DEFAULT_WAIT_TIMEOUT_MINUTES;
      if (opts.waitTimeout !== undefined) {
        const minutes = Number.parseInt(opts.waitTimeout, 10);
        if (!Number.isInteger(minutes) || minutes < 1) {
          emit.error({
            code: "qa_status_invalid_wait_timeout",
            message: "--wait-timeout must be a positive integer number of minutes",
          });
          process.exitCode = 1;
          return;
        }
        waitTimeoutMinutes = minutes;
      }

      const resolved = resolveRunDir(path, resolveQaRepoRoot(context));
      if (!resolved.ok) {
        emit.error({ code: "qa_status_unresolvable_path", message: resolved.error });
        process.exitCode = 1;
        return;
      }
      const runDir = resolved.runDir;

      const deadline = Date.now() + waitTimeoutMinutes * 60_000;
      let lastProgressLine = "";
      while (true) {
        const outcome = classifyRun(runDir);
        if (!outcome.ok) {
          emit.error({ code: "qa_status_unreadable", message: outcome.error });
          process.exitCode = 1;
          return;
        }
        const report = outcome.report;
        const settled = report.terminal || report.state === "dead";
        if (settled || !opts.wait) {
          if (opts.json) emit.data(report);
          renderReport(emit, report);
          if (!settled && !opts.wait) {
            emit.log("still in progress; rerun with --wait to block until the run settles", "info");
          }
          if (report.exit !== 0) process.exitCode = report.exit;
          return;
        }
        const progressLine =
          `run ${report.run_id ?? "(no run id)"}: ${report.state}` +
          `${report.stage !== null ? `, stage ${report.stage}` : ""}`;
        if (progressLine !== lastProgressLine) {
          lastProgressLine = progressLine;
          emit.log(progressLine, "info");
        }
        if (Date.now() >= deadline) {
          if (opts.json) emit.data(report);
          emit.log(
            `wait timed out after ${waitTimeoutMinutes}m; run is still ${report.state}`,
            "warn",
          );
          process.exitCode = 5;
          return;
        }
        await sleep(POLL_MS);
      }
    });
}
