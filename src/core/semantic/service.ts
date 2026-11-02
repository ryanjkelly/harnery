import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coordEnv } from "../../lib/env.ts";
import {
  type CodeChangeWatch,
  type CodeIdentityRecord,
  codeChangeMessage,
  codeIdentityReplacementNeeded,
  currentCodeIdentity,
  watchCodeIdentity,
} from "../code-identity.ts";
import {
  type ReadLedgerV3SinceResult,
  readEventV3ControlState,
  readLedgerV3Since,
} from "../events/v3/index.ts";
import { eventV3ActiveWatchPath } from "../events/v3/reader.ts";
import {
  closeProcessLoggers,
  encodeBoundedLogObjectArray,
  legacyLogFields,
  processLogger,
} from "../storage/logger.ts";
import { stateDirMode, stateFileMode } from "../storage/modes.ts";
import type { SemanticHarness } from "./contract.ts";
import { runSemanticOnce, type SemanticOnceReport } from "./once.ts";
import { semanticPendingPassDue } from "./scheduler.ts";
import {
  readSemanticServiceStatus,
  SEMANTIC_SERVICE_STATUS_SCHEMA_VERSION,
  type SemanticServiceErrorCode,
  type SemanticServiceStatus,
  type SemanticServiceStatusRecord,
} from "./service-status.ts";
import { semanticSoakReadings } from "./soak.ts";
import {
  listSemanticAgentDocuments,
  readSemanticManifest,
  semanticPaths,
  writeSemanticManifest,
} from "./storage.ts";
import {
  aggregateSemanticUsage,
  emptySemanticUsageAggregate,
  mergeSemanticUsageAggregates,
} from "./usage.ts";

export {
  readSemanticServiceStatus,
  SEMANTIC_SERVICE_STATUS_SCHEMA_VERSION,
  type SemanticServiceErrorCode,
  type SemanticServiceState,
  type SemanticServiceStatus,
  type SemanticServiceStatusRecord,
} from "./service-status.ts";

export const SEMANTIC_SERVICE_DEFAULT_DEBOUNCE_MS = 5_000;
export const SEMANTIC_SERVICE_DEFAULT_WAKE_MS = 1_000;
export const SEMANTIC_SERVICE_DEFAULT_HEARTBEAT_MS = 5_000;
// Ceiling for the wake timer while sweeps find nothing. The timer is only the fallback
// behind fs.watch on the active ledger, so backing it off delays nothing that writes an
// event; it stops an idle daemon from re-reading the manifest and agent documents once a
// second all night. Observed 2026-09-06: 142,637 sweeps in 70 h, 10,291 of them passes.
export const SEMANTIC_SERVICE_DEFAULT_IDLE_WAKE_MAX_MS = 30_000;
const FOREIGN_STATUS_STALE_MS = 2 * 60_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LOG_BYTES = 512 * 1024;
const REPEATED_ERROR_LOG_INTERVAL_MS = 60_000;
const SEMANTIC_READINGS_FIELD_MAX_BYTES = 4_096;
const SEMANTIC_READING_FIELDS = [
  "subject_id",
  "generated_at",
  "source_harness",
  "configured_model",
  "resolved_model_id",
  "model_attestation",
  "origin",
  "phase",
  "phase_confidence",
  "expression_cue",
  "expression_confidence",
] as const;

interface SemanticServiceLease {
  pid: number;
  host: string;
  nonce: string;
  created_at: string;
}

export interface RunSemanticServiceDaemonInput {
  coordRoot: string;
  callsPerHour?: number;
  debounceMs?: number;
  wakeIntervalMs?: number;
  idleWakeMaxMs?: number;
  heartbeatIntervalMs?: number;
  maxSweeps?: number;
  now?: () => Date;
  readSince?: typeof readLedgerV3Since;
  runOnce?: (input: {
    coordRoot: string;
    callsPerHour?: number;
    debounceMs: number;
    shouldStop: () => boolean;
  }) => Promise<SemanticOnceReport>;
  waitForWake?: (milliseconds: number) => Promise<void>;
  /** Detects a change to the installed code; the default checks every 30 s. */
  codeWatch?: CodeChangeWatch;
  /**
   * Starts the replacement after a code change, once this daemon has released
   * its lease. The detached daemon entrypoint passes the real launcher; left
   * out, the daemon only exits.
   */
  relaunch?: () => Promise<unknown>;
}

export type EnsureSemanticServiceState =
  | "running"
  | "started"
  | "replaced"
  | "paused"
  | "inactive"
  | "unavailable";

export interface EnsureSemanticServiceResult {
  state: EnsureSemanticServiceState;
  status?: SemanticServiceStatus;
  error?: string;
}

export interface EnsureSemanticServiceDependencies {
  readStatus: (coordRoot: string) => SemanticServiceStatus;
  start: (coordRoot: string) => Promise<SemanticServiceStatus>;
  isPaused: (coordRoot: string) => boolean;
  isActive: (coordRoot: string) => boolean;
  currentCode: () => CodeIdentityRecord;
  /** Stop a stale daemon for replacement; resolves to whether it stopped. */
  stopForReplacement: (coordRoot: string) => Promise<boolean>;
}

const REPLACEMENT_STOP_TIMEOUT_MS = 10_000;

export async function spawnSemanticService(
  coordRootRaw: string,
  options: { callsPerHour?: number } = {},
): Promise<SemanticServiceStatus> {
  const coordRoot = resolve(coordRootRaw);
  const current = readSemanticServiceStatus(coordRoot);
  if (current.running) {
    throw new Error(`semantic service is already running under pid ${current.record?.pid}`);
  }
  const paths = semanticPaths(coordRoot);
  mkdirSync(paths.root, { recursive: true, mode: stateDirMode() });
  const sharedLogs = coordEnv("SHARED_LOGS") !== "0";
  const logFd = sharedLogs ? undefined : openSync(paths.log, "a", stateFileMode());
  if (logFd !== undefined) chmodSync(paths.log, stateFileMode());
  const harnBin = fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../../cli.ts" : "../../cli.js", import.meta.url),
  );
  if (!existsSync(harnBin)) {
    if (logFd !== undefined) closeSync(logFd);
    throw new Error(`cannot find harn executable at ${harnBin}`);
  }
  const args = ["semantic", "service", "daemon", "--root", coordRoot];
  if (options.callsPerHour !== undefined) {
    args.push("--calls-per-hour", String(options.callsPerHour));
  }
  let spawnError: Error | undefined;
  const child = spawn(process.execPath, [harnBin, ...args], {
    windowsHide: true,
    cwd: coordRoot,
    detached: true,
    stdio: logFd === undefined ? ["ignore", "ignore", "ignore"] : ["ignore", logFd, logFd],
    env: {
      ...process.env,
      HARNERY_COORD_ROOT_OVERRIDE: coordRoot,
      HARNERY_OUTPUT_SESSION_TEE: "0",
    },
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  if (logFd !== undefined) closeSync(logFd);
  child.unref();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await delay(50);
    if (spawnError) throw spawnError;
    const status = readSemanticServiceStatus(coordRoot);
    if (status.running && status.record?.pid === child.pid) return status;
    if (child.exitCode !== null) break;
  }
  const diagnosticPath = sharedLogs
    ? join(coordRoot, ".harnery", "logs", "semantic-service", "active.jsonl")
    : paths.log;
  throw new Error(`semantic service failed to start; inspect ${diagnosticPath}`);
}

/**
 * Start semantic reading when V3 is active, unless an operator paused it.
 *
 * Dashboard hosts call this before launching their web process. A failed
 * semantic launch is reported as data instead of throwing so the read-only
 * dashboard remains available. A live daemon on this host that loaded older
 * code than this installation is stopped and started again (ADR 0232).
 */
export async function ensureSemanticServiceRunning(
  coordRootRaw: string,
  overrides: Partial<EnsureSemanticServiceDependencies> = {},
): Promise<EnsureSemanticServiceResult> {
  const coordRoot = resolve(coordRootRaw);
  const dependencies: EnsureSemanticServiceDependencies = {
    readStatus: readSemanticServiceStatus,
    start: spawnSemanticService,
    isPaused: (root) => existsSync(semanticPaths(root).stop),
    isActive: (root) => readEventV3ControlState(root).state === "active",
    currentCode: currentCodeIdentity,
    stopForReplacement: stopSemanticServiceForReplacement,
    ...overrides,
  };
  const status = dependencies.readStatus(coordRoot);
  let replacing = false;
  if (status.running) {
    const local = status.record?.host === hostname();
    if (!local || !codeIdentityReplacementNeeded(status.record?.code, dependencies.currentCode())) {
      return { state: "running", status };
    }
    // A daemon still inside a model call keeps it; it relaunches itself when
    // it exits, so a slow stop is reported as still running.
    if (!(await dependencies.stopForReplacement(coordRoot))) {
      return { state: "running", status: dependencies.readStatus(coordRoot) };
    }
    replacing = true;
  } else if (dependencies.isPaused(coordRoot)) return { state: "paused", status };
  if (!dependencies.isActive(coordRoot)) return { state: "inactive", status };
  try {
    return {
      state: replacing ? "replaced" : "started",
      status: await dependencies.start(coordRoot),
    };
  } catch (error) {
    const after = dependencies.readStatus(coordRoot);
    // The stopped daemon relaunched itself first; that is the replacement.
    if (replacing && after.running) return { state: "replaced", status: after };
    return {
      state: "unavailable",
      status: after,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Signal a stale local daemon and wait briefly for it to go. This writes no
 * durable stop request: that file is also the operator's pause, and the
 * replacement must not read as paused.
 */
async function stopSemanticServiceForReplacement(coordRootRaw: string): Promise<boolean> {
  const coordRoot = resolve(coordRootRaw);
  const status = readSemanticServiceStatus(coordRoot);
  if (!status.running) return true;
  if (status.record?.host !== hostname()) return false;
  try {
    process.kill(status.record.pid, "SIGTERM");
  } catch {
    // An exited process is what the wait below looks for.
  }
  const deadline = Date.now() + REPLACEMENT_STOP_TIMEOUT_MS;
  while (readSemanticServiceStatus(coordRoot).running && Date.now() < deadline) await delay(100);
  return !readSemanticServiceStatus(coordRoot).running;
}

/**
 * The relaunch the detached daemon entrypoint uses after a code change:
 * start a daemon from the newly installed code with the same call ceiling,
 * unless something else already started one.
 */
export async function relaunchSemanticService(
  coordRoot: string,
  options: { callsPerHour?: number } = {},
): Promise<void> {
  if (readSemanticServiceStatus(coordRoot).running) return;
  await spawnSemanticService(coordRoot, options);
}

export function requestSemanticServiceStop(coordRootRaw: string): SemanticServiceStatus {
  const coordRoot = resolve(coordRootRaw);
  const status = readSemanticServiceStatus(coordRoot);
  mkdirSync(semanticPaths(coordRoot).root, { recursive: true, mode: stateDirMode() });
  writePrivateJsonAtomic(semanticPaths(coordRoot).stop, {
    requested_at: new Date().toISOString(),
    requested_by_pid: process.pid,
  });
  if (status.running && status.record?.host === hostname()) {
    try {
      process.kill(status.record.pid, "SIGTERM");
    } catch {
      // The durable stop request remains for a racing or restarted daemon.
    }
  }
  return readSemanticServiceStatus(coordRoot);
}

export async function runSemanticServiceDaemon(
  input: RunSemanticServiceDaemonInput,
): Promise<SemanticServiceStatusRecord> {
  const coordRoot = resolve(input.coordRoot);
  const paths = semanticPaths(coordRoot);
  const release = acquireSemanticServiceLease(coordRoot);
  rmSync(paths.stop, { force: true });
  const now = input.now ?? (() => new Date());
  const debounceMs = Math.max(0, input.debounceMs ?? SEMANTIC_SERVICE_DEFAULT_DEBOUNCE_MS);
  const wakeIntervalMs = positiveInterval(
    input.wakeIntervalMs ?? SEMANTIC_SERVICE_DEFAULT_WAKE_MS,
    "wake interval",
  );
  const heartbeatIntervalMs = positiveInterval(
    input.heartbeatIntervalMs ?? SEMANTIC_SERVICE_DEFAULT_HEARTBEAT_MS,
    "heartbeat interval",
  );
  const idleWakeMaxMs = Math.max(
    wakeIntervalMs,
    positiveInterval(
      input.idleWakeMaxMs ?? SEMANTIC_SERVICE_DEFAULT_IDLE_WAKE_MAX_MS,
      "idle wake ceiling",
    ),
  );
  const readSince = input.readSince ?? readLedgerV3Since;
  const codeWatch = input.codeWatch ?? watchCodeIdentity();
  let codeChanged = false;
  const codeChangeConfirmed = (): boolean => {
    if (codeChanged) return true;
    const change = codeWatch.poll();
    if (!change) return false;
    codeChanged = true;
    appendSemanticServiceDiagnostic(coordRoot, {
      event: "code_changed",
      message: codeChangeMessage(change),
      from_code: change.from,
      to_code: change.to,
    });
    return true;
  };
  const runOnce =
    input.runOnce ??
    (async (options) =>
      await runSemanticOnce({
        coordRoot: options.coordRoot,
        callsPerHour: options.callsPerHour,
        debounceMs: options.debounceMs,
        shouldStop: options.shouldStop,
      }));
  const startedAt = now().toISOString();
  const status: SemanticServiceStatusRecord = {
    schema_version: SEMANTIC_SERVICE_STATUS_SCHEMA_VERSION,
    pid: process.pid,
    host: hostname(),
    nonce: randomUUID(),
    state: "starting",
    started_at: startedAt,
    heartbeat_at: startedAt,
    ...(input.callsPerHour !== undefined ? { calls_per_hour: input.callsPerHour } : {}),
    sweep_count: 0,
    pass_count: 0,
    model_calls: 0,
    cache_hits: 0,
    process_usage: emptySemanticUsageAggregate(),
    code: codeWatch.initial,
  };
  let stopRequested = false;
  let dirtySince: number | undefined;
  let idleSweeps = 0;
  let wakeEarly: (() => void) | undefined;
  let lastLoggedErrorCode: string | undefined;
  let lastLoggedErrorAt = Number.NEGATIVE_INFINITY;
  const writeStatus = (): void => {
    status.heartbeat_at = now().toISOString();
    writePrivateJsonAtomic(paths.service, status);
  };
  const requestStop = (): void => {
    stopRequested = true;
    status.state = "stopping";
    writeStatus();
    // A backed-off wait must not hold a stop request for up to the idle ceiling.
    wakeEarly?.();
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  status.state = "running";
  writeStatus();
  appendSemanticServiceDiagnostic(coordRoot, { event: "service_started" });
  const heartbeat = setInterval(() => {
    try {
      writeStatus();
    } catch {
      // A later sweep or status read will expose the stopped or stale process.
    }
  }, heartbeatIntervalMs);
  try {
    while (!stopRequested && !existsSync(paths.stop) && !codeChangeConfirmed()) {
      const sweepAt = now();
      status.sweep_count += 1;
      let sawWork = false;
      try {
        const before = safeManifest(coordRoot);
        let read = readSince(coordRoot, before?.cursor, { authority: "active" });
        if (read.reset_required) {
          read = readSince(coordRoot, undefined, { authority: "active" });
        }
        requireCompleteLedger(read);
        if (read.events.length > 0) sawWork = true;
        if (read.events.length > 0 || !before?.cursor) {
          dirtySince ??= sweepAt.getTime();
        }
        const hasPendingPassDue = before
          ? semanticPendingPassDue({
              pending: before.pending,
              callHistory: before.call_history,
              nowMs: sweepAt.getTime(),
              debounceMs,
              ...(input.callsPerHour !== undefined ? { callsPerHour: input.callsPerHour } : {}),
            })
          : false;
        const hasEligibleDeferred = listSemanticAgentDocuments(coordRoot).some(
          (document) =>
            document.reader_outcome === "deferred" &&
            Date.parse(document.receipt.eligible_after) <= sweepAt.getTime(),
        );
        if (
          hasPendingPassDue ||
          hasEligibleDeferred ||
          (dirtySince !== undefined && sweepAt.getTime() - dirtySince >= debounceMs)
        ) {
          const report = await runOnce({
            coordRoot,
            ...(input.callsPerHour !== undefined ? { callsPerHour: input.callsPerHour } : {}),
            debounceMs,
            // A code change ends the pass after the current model call, the
            // same graceful point an operator stop uses.
            shouldStop: () => stopRequested || existsSync(paths.stop) || codeChangeConfirmed(),
          });
          status.pass_count += 1;
          sawWork = true;
          status.model_calls += report.model_calls;
          status.cache_hits += report.cache_hits;
          status.process_usage = mergeSemanticUsageAggregates(
            status.process_usage ?? emptySemanticUsageAggregate(),
            aggregateSemanticUsage(report.outcomes),
          );
          status.last_pass_at = report.completed_at;
          status.last_error_code = undefined;
          lastLoggedErrorCode = undefined;
          const after = safeManifest(coordRoot);
          if (after && read.cursor) {
            after.cursor = read.cursor;
            writeSemanticManifest(coordRoot, after);
          }
          dirtySince = undefined;
          const logEntry = {
            event: "pass",
            evidence_count: report.evidence_count,
            evidence_by_harness: report.evidence_by_harness,
            model_calls: report.model_calls,
            cache_hits: report.cache_hits,
            accepted: report.outcomes.filter((outcome) => outcome.action === "accepted").length,
            unavailable: report.outcomes.filter((outcome) => outcome.action === "unavailable")
              .length,
            invalid: report.outcomes.filter((outcome) => outcome.action === "invalid").length,
            deferred: report.outcomes.filter((outcome) => outcome.action === "deferred").length,
            harness_metrics: semanticHarnessMetrics(report),
            usage: aggregateSemanticUsage(report.outcomes),
            semantic_readings: semanticSoakReadings(coordRoot, report.outcomes),
          };
          if (report.model_calls > 0 || report.cache_hits > 0 || logEntry.unavailable > 0) {
            appendSemanticServiceDiagnostic(coordRoot, logEntry);
          }
        }
      } catch (error) {
        status.last_error_code = serviceErrorCode(error);
        if (
          status.last_error_code !== lastLoggedErrorCode ||
          sweepAt.getTime() - lastLoggedErrorAt >= REPEATED_ERROR_LOG_INTERVAL_MS
        ) {
          appendSemanticServiceDiagnostic(coordRoot, {
            event: "sweep_error",
            reason_code: status.last_error_code,
          });
          lastLoggedErrorCode = status.last_error_code;
          lastLoggedErrorAt = sweepAt.getTime();
        }
      }
      status.last_sweep_at = now().toISOString();
      writeStatus();
      idleSweeps = sawWork ? 0 : idleSweeps + 1;
      if (input.maxSweeps !== undefined && status.sweep_count >= input.maxSweeps) break;
      if (!stopRequested && !existsSync(paths.stop)) {
        // Double the fallback timer per idle sweep, up to the ceiling; any sweep that
        // sees events or runs a pass snaps it back to the configured interval.
        const waitMs = Math.min(idleWakeMaxMs, wakeIntervalMs * 2 ** Math.min(idleSweeps, 20));
        if (input.waitForWake) await input.waitForWake(waitMs);
        else {
          await waitForLedgerWake(eventV3ActiveWatchPath(coordRoot), waitMs, (wake) => {
            wakeEarly = wake;
          });
          wakeEarly = undefined;
        }
      }
    }
  } finally {
    clearInterval(heartbeat);
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    status.state = "stopped";
    status.stopped_at = now().toISOString();
    // An operator stop (the durable request) never relaunches. Otherwise the
    // daemon relaunches when it saw the code change itself, or when a
    // launcher stopped it to replace it with newer code.
    const relaunching =
      !existsSync(paths.stop) && (codeChanged || (stopRequested && codeWatch.checkNow() !== null));
    if (relaunching) status.exit_reason = "code_changed";
    writeStatus();
    appendSemanticServiceDiagnostic(coordRoot, {
      event: "service_stopped",
      sweeps: status.sweep_count,
      passes: status.pass_count,
      model_calls: status.model_calls,
      usage: status.process_usage,
      ...(relaunching ? { exit_reason: "code_changed" } : {}),
    });
    release();
    if (relaunching && input.relaunch) {
      try {
        await input.relaunch();
      } catch (error) {
        appendSemanticServiceDiagnostic(coordRoot, {
          event: "relaunch_error",
          message: error instanceof Error ? error.message.slice(0, 300) : String(error),
        });
      }
    }
    await closeProcessLoggers();
  }
  return status;
}

export function acquireSemanticServiceLease(coordRootRaw: string): () => void {
  const path = semanticPaths(coordRootRaw).lease;
  mkdirSync(dirname(path), { recursive: true, mode: stateDirMode() });
  const owner: SemanticServiceLease = {
    pid: process.pid,
    host: hostname(),
    nonce: randomUUID(),
    created_at: new Date().toISOString(),
  };
  const acquire = (): boolean => {
    try {
      const fd = openSync(path, "wx", stateFileMode());
      try {
        writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };
  if (!acquire()) {
    const existing = readLease(path);
    if (existing && leaseOwnerIsLive(existing)) {
      throw new Error(`semantic service is already running under pid ${existing.pid}`);
    }
    unlinkSync(path);
    if (!acquire()) throw new Error("semantic service lease raced with another process");
  }
  return () => {
    try {
      const existing = readLease(path);
      if (existing?.nonce === owner.nonce) unlinkSync(path);
    } catch {
      // A later explicit start can recover a stale private lease.
    }
  };
}

interface SemanticHarnessPassMetrics {
  evidence_count: number;
  model_calls: number;
  cache_hits: number;
  accepted: number;
  unavailable: number;
  invalid: number;
  deferred: number;
  duration_ms: number[];
  input_bytes: number[];
  output_bytes: number[];
}

function semanticHarnessMetrics(
  report: SemanticOnceReport,
): Record<SemanticHarness, SemanticHarnessPassMetrics> {
  const metrics: Record<SemanticHarness, SemanticHarnessPassMetrics> = {
    "claude-code": emptyHarnessMetrics(report.evidence_by_harness["claude-code"]),
    codex: emptyHarnessMetrics(report.evidence_by_harness.codex),
    cursor: emptyHarnessMetrics(report.evidence_by_harness.cursor),
  };
  for (const outcome of report.outcomes) {
    const harness = metrics[outcome.source_harness];
    if (outcome.model_call) harness.model_calls += 1;
    if (outcome.action === "cached") harness.cache_hits += 1;
    if (outcome.action === "accepted") harness.accepted += 1;
    if (outcome.action === "unavailable") harness.unavailable += 1;
    if (outcome.action === "invalid") harness.invalid += 1;
    if (outcome.action === "deferred") harness.deferred += 1;
    if (outcome.duration_ms !== undefined) harness.duration_ms.push(outcome.duration_ms);
    if (outcome.input_bytes !== undefined) harness.input_bytes.push(outcome.input_bytes);
    if (outcome.output_bytes !== undefined) harness.output_bytes.push(outcome.output_bytes);
  }
  return metrics;
}

function emptyHarnessMetrics(evidenceCount: number): SemanticHarnessPassMetrics {
  return {
    evidence_count: evidenceCount,
    model_calls: 0,
    cache_hits: 0,
    accepted: 0,
    unavailable: 0,
    invalid: 0,
    deferred: 0,
    duration_ms: [],
    input_bytes: [],
    output_bytes: [],
  };
}

function requireCompleteLedger(read: ReadLedgerV3SinceResult): void {
  if (!read.complete || read.diagnostics.length > 0) throw new Error("ledger_unavailable");
}

function serviceErrorCode(error: unknown): SemanticServiceErrorCode {
  return error instanceof Error && error.message === "ledger_unavailable"
    ? "ledger_unavailable"
    : "semantic_pass_failed";
}

function safeManifest(coordRoot: string) {
  try {
    return readSemanticManifest(coordRoot);
  } catch {
    return undefined;
  }
}

function readLease(path: string): SemanticServiceLease | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SemanticServiceLease>;
    if (
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) < 1 ||
      typeof value.host !== "string" ||
      typeof value.nonce !== "string" ||
      !validTimestamp(value.created_at)
    ) {
      return undefined;
    }
    return value as SemanticServiceLease;
  } catch {
    return undefined;
  }
}

function leaseOwnerIsLive(lease: SemanticServiceLease): boolean {
  if (lease.host !== hostname()) {
    const age = Date.now() - Date.parse(lease.created_at);
    return Number.isFinite(age) && age < FOREIGN_STATUS_STALE_MS;
  }
  return pidAlive(lease.pid);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForLedgerWake(
  path: string,
  milliseconds: number,
  onWait?: (wake: () => void) => void,
): Promise<void> {
  await new Promise<void>((done) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      done();
    };
    const timer = setTimeout(finish, milliseconds);
    try {
      watcher = watch(path, { persistent: false }, finish);
    } catch {
      // The timer is the polling fallback when the active file does not exist yet.
    }
    onWait?.(finish);
  });
}

export function appendSemanticServiceDiagnostic(
  coordRoot: string,
  entry: Record<string, unknown>,
): "shared" | "legacy" {
  const prepared = prepareSemanticServiceDiagnostic(entry);
  if (coordEnv("SHARED_LOGS") !== "0") {
    try {
      const logger = processLogger(coordRoot, "semantic-service");
      if (prepared.event.includes("error")) {
        logger.error(prepared.event, legacyLogFields(prepared.fields));
      } else logger.info(prepared.event, legacyLogFields(prepared.fields));
      return "shared";
    } catch {
      // Bootstrap failures retain the bounded legacy writer as the process fallback.
    }
  }
  appendSemanticServiceLegacyLog(coordRoot, prepared.legacyEntry);
  return "legacy";
}

function prepareSemanticServiceDiagnostic(entry: Record<string, unknown>): {
  event: string;
  fields: Record<string, unknown>;
  legacyEntry: Record<string, unknown>;
} {
  const event = typeof entry.event === "string" ? entry.event : "service_event";
  const fields = { ...entry };
  delete fields.event;
  const legacyEntry: Record<string, unknown> = { ...entry, event };
  const semanticReadings = fields.semantic_readings;
  if (semanticReadings === undefined) return { event, fields, legacyEntry };
  if (!Array.isArray(semanticReadings)) throw new Error("semantic_readings must be an array");
  const bounded = encodeBoundedLogObjectArray(semanticReadings, {
    max_bytes: SEMANTIC_READINGS_FIELD_MAX_BYTES,
    allowed_fields: SEMANTIC_READING_FIELDS,
  });
  fields.semantic_readings = bounded.json;
  fields.semantic_readings_count = bounded.included;
  legacyEntry.semantic_readings = JSON.parse(bounded.json) as unknown[];
  legacyEntry.semantic_readings_count = bounded.included;
  if (bounded.truncated) {
    fields.semantic_readings_truncated = true;
    fields.semantic_readings_omitted = bounded.omitted;
    legacyEntry.semantic_readings_truncated = true;
    legacyEntry.semantic_readings_omitted = bounded.omitted;
  }
  return { event, fields, legacyEntry };
}

function appendSemanticServiceLegacyLog(coordRoot: string, entry: Record<string, unknown>): void {
  const path = semanticPaths(coordRoot).log;
  mkdirSync(dirname(path), { recursive: true, mode: stateDirMode() });
  appendFileSync(
    path,
    `${JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), ...entry })}\n`,
    { encoding: "utf8", mode: stateFileMode() },
  );
  chmodSync(path, stateFileMode());
  if (statSync(path).size <= MAX_LOG_BYTES) return;
  const buffer = readFileSync(path);
  const tail = buffer.subarray(Math.max(0, buffer.length - Math.floor(MAX_LOG_BYTES / 2)));
  const newline = tail.indexOf(10);
  const body = newline >= 0 ? tail.subarray(newline + 1) : tail;
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, body, { flag: "wx", mode: stateFileMode() });
  renameSync(temporary, path);
}

function writePrivateJsonAtomic(path: string, value: unknown): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_FILE_BYTES) {
    throw new Error(`semantic service file exceeds ${MAX_FILE_BYTES} bytes`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: stateDirMode() });
  chmodSync(dirname(path), stateDirMode());
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: stateFileMode() });
  renameSync(temporary, path);
  chmodSync(path, stateFileMode());
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function positiveInterval(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 1) throw new Error(`${label} must be positive`);
  return Math.floor(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}
