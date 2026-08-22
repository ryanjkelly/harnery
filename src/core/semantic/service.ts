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
import { dirname, resolve } from "node:path";
import { type ReadLedgerV3SinceResult, readLedgerV3Since } from "../events/v3/index.ts";
import { eventV3ActiveWatchPath } from "../events/v3/reader.ts";
import { runSemanticOnce, type SemanticOnceReport } from "./once.ts";
import {
  readSemanticServiceStatus,
  SEMANTIC_SERVICE_STATUS_SCHEMA_VERSION,
  type SemanticServiceErrorCode,
  type SemanticServiceStatus,
  type SemanticServiceStatusRecord,
} from "./service-status.ts";
import { readSemanticManifest, semanticPaths, writeSemanticManifest } from "./storage.ts";

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
const FOREIGN_STATUS_STALE_MS = 2 * 60_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LOG_BYTES = 512 * 1024;

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
  heartbeatIntervalMs?: number;
  maxSweeps?: number;
  now?: () => Date;
  readSince?: typeof readLedgerV3Since;
  runOnce?: (input: {
    coordRoot: string;
    callsPerHour?: number;
    debounceMs: number;
  }) => Promise<SemanticOnceReport>;
  waitForWake?: (milliseconds: number) => Promise<void>;
}

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
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const logFd = openSync(paths.log, "a", 0o600);
  chmodSync(paths.log, 0o600);
  const harnBin = new URL("../../../bin/harn", import.meta.url).pathname;
  if (!existsSync(harnBin)) {
    closeSync(logFd);
    throw new Error(`cannot find harn executable at ${harnBin}`);
  }
  const args = ["semantic", "service", "daemon", "--root", coordRoot];
  if (options.callsPerHour !== undefined) {
    args.push("--calls-per-hour", String(options.callsPerHour));
  }
  let spawnError: Error | undefined;
  const child = spawn(harnBin, args, {
    cwd: coordRoot,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      HARNERY_COORD_ROOT_OVERRIDE: coordRoot,
      HARNERY_OUTPUT_SESSION_TEE: "0",
    },
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  closeSync(logFd);
  child.unref();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await delay(50);
    if (spawnError) throw spawnError;
    const status = readSemanticServiceStatus(coordRoot);
    if (status.running && status.record?.pid === child.pid) return status;
    if (child.exitCode !== null) break;
  }
  throw new Error(`semantic service failed to start; inspect ${paths.log}`);
}

export function requestSemanticServiceStop(coordRootRaw: string): SemanticServiceStatus {
  const coordRoot = resolve(coordRootRaw);
  const status = readSemanticServiceStatus(coordRoot);
  if (!status.running || !status.record) return status;
  writePrivateJsonAtomic(semanticPaths(coordRoot).stop, {
    requested_at: new Date().toISOString(),
    requested_by_pid: process.pid,
  });
  if (status.record.host === hostname()) {
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
  const readSince = input.readSince ?? readLedgerV3Since;
  const runOnce =
    input.runOnce ??
    (async (options) =>
      await runSemanticOnce({
        coordRoot: options.coordRoot,
        callsPerHour: options.callsPerHour,
        debounceMs: options.debounceMs,
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
  };
  let stopRequested = false;
  let dirtySince: number | undefined;
  const writeStatus = (): void => {
    status.heartbeat_at = now().toISOString();
    writePrivateJsonAtomic(paths.service, status);
  };
  const requestStop = (): void => {
    stopRequested = true;
    status.state = "stopping";
    writeStatus();
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  status.state = "running";
  writeStatus();
  appendSemanticServiceLog(coordRoot, { event: "service_started" });
  const heartbeat = setInterval(() => {
    try {
      writeStatus();
    } catch {
      // A later sweep or status read will expose the stopped or stale process.
    }
  }, heartbeatIntervalMs);
  try {
    while (!stopRequested && !existsSync(paths.stop)) {
      const sweepAt = now();
      status.sweep_count += 1;
      try {
        const before = safeManifest(coordRoot);
        const read = readSince(coordRoot, before?.cursor, { authority: "active" });
        requireCompleteLedger(read);
        if (read.reset_required || read.events.length > 0 || !before?.cursor) {
          dirtySince ??= sweepAt.getTime();
        }
        const hasPending = (before?.pending.length ?? 0) > 0;
        if (
          hasPending ||
          (dirtySince !== undefined && sweepAt.getTime() - dirtySince >= debounceMs)
        ) {
          const report = await runOnce({
            coordRoot,
            ...(input.callsPerHour !== undefined ? { callsPerHour: input.callsPerHour } : {}),
            debounceMs,
          });
          status.pass_count += 1;
          status.model_calls += report.model_calls;
          status.cache_hits += report.cache_hits;
          status.last_pass_at = report.completed_at;
          status.last_error_code = undefined;
          const after = safeManifest(coordRoot);
          if (after && read.cursor) {
            after.cursor = read.cursor;
            writeSemanticManifest(coordRoot, after);
          }
          dirtySince = undefined;
          appendSemanticServiceLog(coordRoot, {
            event: "pass",
            evidence_count: report.evidence_count,
            model_calls: report.model_calls,
            cache_hits: report.cache_hits,
            accepted: report.outcomes.filter((outcome) => outcome.action === "accepted").length,
            unavailable: report.outcomes.filter((outcome) => outcome.action === "unavailable")
              .length,
            invalid: report.outcomes.filter((outcome) => outcome.action === "invalid").length,
            deferred: report.outcomes.filter((outcome) => outcome.action === "deferred").length,
          });
        }
      } catch (error) {
        status.last_error_code = serviceErrorCode(error);
        appendSemanticServiceLog(coordRoot, {
          event: "sweep_error",
          reason_code: status.last_error_code,
        });
      }
      status.last_sweep_at = now().toISOString();
      writeStatus();
      if (input.maxSweeps !== undefined && status.sweep_count >= input.maxSweeps) break;
      if (!stopRequested && !existsSync(paths.stop)) {
        if (input.waitForWake) await input.waitForWake(wakeIntervalMs);
        else await waitForLedgerWake(eventV3ActiveWatchPath(coordRoot), wakeIntervalMs);
      }
    }
  } finally {
    clearInterval(heartbeat);
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    status.state = "stopped";
    status.stopped_at = now().toISOString();
    writeStatus();
    appendSemanticServiceLog(coordRoot, {
      event: "service_stopped",
      sweeps: status.sweep_count,
      passes: status.pass_count,
      model_calls: status.model_calls,
    });
    rmSync(paths.stop, { force: true });
    release();
  }
  return status;
}

export function acquireSemanticServiceLease(coordRootRaw: string): () => void {
  const path = semanticPaths(coordRootRaw).lease;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const owner: SemanticServiceLease = {
    pid: process.pid,
    host: hostname(),
    nonce: randomUUID(),
    created_at: new Date().toISOString(),
  };
  const acquire = (): boolean => {
    try {
      const fd = openSync(path, "wx", 0o600);
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

async function waitForLedgerWake(path: string, milliseconds: number): Promise<void> {
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
  });
}

function appendSemanticServiceLog(coordRoot: string, entry: Record<string, unknown>): void {
  const path = semanticPaths(coordRoot).log;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(
    path,
    `${JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), ...entry })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(path, 0o600);
  if (statSync(path).size <= MAX_LOG_BYTES) return;
  const buffer = readFileSync(path);
  const tail = buffer.subarray(Math.max(0, buffer.length - Math.floor(MAX_LOG_BYTES / 2)));
  const newline = tail.indexOf(10);
  const body = newline >= 0 ? tail.subarray(newline + 1) : tail;
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

function writePrivateJsonAtomic(path: string, value: unknown): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_FILE_BYTES) {
    throw new Error(`semantic service file exceeds ${MAX_FILE_BYTES} bytes`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
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
