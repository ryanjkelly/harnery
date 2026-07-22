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
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type NormalizedPolicy, normalizePolicy, type PolicyIsolation } from "../policy/index.ts";
import type { RunWorkItemInput } from "../work/index.ts";
import { runSupervisor, type SupervisorRunReport, type SupervisorStopReason } from "./runner.ts";
import { readSupervisor, type SupervisorRecord } from "./state.ts";

export const SUPERVISOR_SERVICE_CONFIG_SCHEMA_VERSION = 1 as const;
export const SUPERVISOR_SERVICE_RUNTIME_SCHEMA_VERSION = 1 as const;
export const SUPERVISOR_SERVICE_STATUS_SCHEMA_VERSION = 1 as const;

const MAX_FILE_BYTES = 512 * 1024;
const MAX_GOALS = 100;
const MAX_ERROR = 2_000;
const FOREIGN_STATUS_STALE_MS = 30_000;

export interface SupervisorServiceEngineConfig {
  default_harness?: string;
  cwd?: string;
  subscription_only: boolean;
  allow_api_billing: boolean;
  policy?: NormalizedPolicy;
  isolation?: PolicyIsolation;
  approval_addressee?: string;
}

export interface SupervisorServiceConfig {
  schema_version: typeof SUPERVISOR_SERVICE_CONFIG_SCHEMA_VERSION;
  goal_ids: string[];
  wake_interval_ms: number;
  heartbeat_interval_ms: number;
  error_backoff_base_ms: number;
  error_backoff_max_ms: number;
  engine: SupervisorServiceEngineConfig;
  created_at: string;
}

export interface ConfigureSupervisorServiceInput {
  coordRoot: string;
  goalIds: readonly string[];
  wakeIntervalMs?: number;
  heartbeatIntervalMs?: number;
  errorBackoffBaseMs?: number;
  errorBackoffMaxMs?: number;
  engine?: Partial<SupervisorServiceEngineConfig>;
}

export type SupervisorServiceGoalState = "idle" | "backoff" | "awaiting_change";

export interface SupervisorServiceGoalRuntime {
  state: SupervisorServiceGoalState;
  consecutive_errors: number;
  observed_fingerprint?: string;
  next_wake_at?: string;
  last_tick_at?: string;
  last_stop_reason?: SupervisorStopReason;
  last_error?: string;
}

export interface SupervisorServiceRuntime {
  schema_version: typeof SUPERVISOR_SERVICE_RUNTIME_SCHEMA_VERSION;
  config_created_at: string;
  updated_at: string;
  goals: Record<string, SupervisorServiceGoalRuntime>;
}

export type SupervisorServiceProcessState = "starting" | "running" | "stopping" | "stopped";

export interface SupervisorServiceStatusRecord {
  schema_version: typeof SUPERVISOR_SERVICE_STATUS_SCHEMA_VERSION;
  pid: number;
  host: string;
  nonce: string;
  state: SupervisorServiceProcessState;
  started_at: string;
  heartbeat_at: string;
  config_created_at: string;
  sweep_count: number;
  active_goal_id?: string;
  last_sweep_at?: string;
  next_wake_at?: string;
  last_error?: string;
  stopped_at?: string;
}

export interface SupervisorServiceStatus {
  running: boolean;
  stale: boolean;
  record?: SupervisorServiceStatusRecord;
  config?: SupervisorServiceConfig;
  runtime?: SupervisorServiceRuntime;
}

export interface SupervisorServiceSweepOutcome {
  goal_id: string;
  action: "tick" | "skip" | "backoff";
  reason: string;
  stop_reason?: SupervisorStopReason;
  next_wake_at?: string;
}

export interface SupervisorServiceSweepReport {
  started_at: string;
  ended_at: string;
  outcomes: SupervisorServiceSweepOutcome[];
}

export interface RunSupervisorServiceSweepInput {
  coordRoot: string;
  config: SupervisorServiceConfig;
  engine?: Omit<RunWorkItemInput["engine"], "maxAgents" | "concurrency" | "specialists">;
  actor?: string;
  now?: () => number;
  readGoal?: (coordRoot: string, goalId: string) => SupervisorRecord;
  runGoal?: (goalId: string) => Promise<SupervisorRunReport>;
  onGoalStart?: (goalId: string) => void;
}

export interface RunSupervisorServiceDaemonInput {
  coordRoot: string;
  engine: Omit<RunWorkItemInput["engine"], "maxAgents" | "concurrency" | "specialists">;
  actor?: string;
  maxSweeps?: number;
  onLog?: (line: string) => void;
}

interface ServiceLease {
  pid: number;
  host: string;
  nonce: string;
  created_at: string;
}

export function configureSupervisorService(
  input: ConfigureSupervisorServiceInput,
): SupervisorServiceConfig {
  const coordRoot = resolve(input.coordRoot);
  const active = readStatusRecord(coordRoot);
  if (active && statusOwnerIsLive(active)) {
    throw new Error(`stop supervisor service pid ${active.pid} before changing its configuration`);
  }
  const goalIds = unique(input.goalIds.map((value) => value.trim()).filter(Boolean));
  if (goalIds.length < 1 || goalIds.length > MAX_GOALS) {
    throw new Error(`supervisor service requires from 1 to ${MAX_GOALS} unique goal ids`);
  }
  for (const goalId of goalIds) readSupervisor(coordRoot, goalId);
  const wakeIntervalMs = positive(
    input.wakeIntervalMs ?? 5_000,
    "service wake_interval_ms",
    60 * 60 * 1_000,
  );
  const heartbeatIntervalMs = positive(
    input.heartbeatIntervalMs ?? 2_000,
    "service heartbeat_interval_ms",
    60_000,
  );
  const errorBackoffBaseMs = positive(
    input.errorBackoffBaseMs ?? 2_000,
    "service error_backoff_base_ms",
    60 * 60 * 1_000,
  );
  const errorBackoffMaxMs = positive(
    input.errorBackoffMaxMs ?? 5 * 60_000,
    "service error_backoff_max_ms",
    24 * 60 * 60 * 1_000,
  );
  if (errorBackoffMaxMs < errorBackoffBaseMs) {
    throw new Error("service error_backoff_max_ms must be at least error_backoff_base_ms");
  }
  const config: SupervisorServiceConfig = {
    schema_version: SUPERVISOR_SERVICE_CONFIG_SCHEMA_VERSION,
    goal_ids: goalIds,
    wake_interval_ms: wakeIntervalMs,
    heartbeat_interval_ms: heartbeatIntervalMs,
    error_backoff_base_ms: errorBackoffBaseMs,
    error_backoff_max_ms: errorBackoffMaxMs,
    engine: normalizeEngineConfig(coordRoot, input.engine),
    created_at: new Date().toISOString(),
  };
  const dir = serviceDir(coordRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writePrivateJsonAtomic(serviceConfigPath(coordRoot), config);
  return readSupervisorServiceConfig(coordRoot);
}

export function readSupervisorServiceConfig(coordRootRaw: string): SupervisorServiceConfig {
  const coordRoot = resolve(coordRootRaw);
  const config = readBoundedJson<SupervisorServiceConfig>(
    serviceConfigPath(coordRoot),
    "supervisor service configuration",
  );
  validateConfig(coordRoot, config);
  return config;
}

export function readSupervisorServiceRuntime(
  coordRootRaw: string,
): SupervisorServiceRuntime | undefined {
  const coordRoot = resolve(coordRootRaw);
  if (!existsSync(serviceRuntimePath(coordRoot))) return undefined;
  const runtime = readBoundedJson<SupervisorServiceRuntime>(
    serviceRuntimePath(coordRoot),
    "supervisor service runtime",
  );
  if (
    runtime.schema_version !== SUPERVISOR_SERVICE_RUNTIME_SCHEMA_VERSION ||
    !validTimestamp(runtime.config_created_at) ||
    !validTimestamp(runtime.updated_at) ||
    !runtime.goals ||
    typeof runtime.goals !== "object" ||
    Array.isArray(runtime.goals)
  ) {
    throw new Error("supervisor service runtime has an unsupported schema");
  }
  return runtime;
}

export function readSupervisorServiceStatus(coordRootRaw: string): SupervisorServiceStatus {
  const coordRoot = resolve(coordRootRaw);
  const record = readStatusRecord(coordRoot);
  let config: SupervisorServiceConfig | undefined;
  let runtime: SupervisorServiceRuntime | undefined;
  try {
    config = readSupervisorServiceConfig(coordRoot);
  } catch {
    // A service has no usable configuration until explicitly configured.
  }
  try {
    runtime = readSupervisorServiceRuntime(coordRoot);
  } catch {
    // Status remains readable when recoverable runtime state is corrupt.
  }
  if (!record) return { running: false, stale: false, config, runtime };
  const running = statusOwnerIsLive(record);
  return { running, stale: !running && record.state !== "stopped", record, config, runtime };
}

export async function spawnSupervisorService(
  coordRootRaw: string,
): Promise<SupervisorServiceStatus> {
  const coordRoot = resolve(coordRootRaw);
  readSupervisorServiceConfig(coordRoot);
  const current = readSupervisorServiceStatus(coordRoot);
  if (current.running) {
    throw new Error(`supervisor service is already running under pid ${current.record?.pid}`);
  }
  mkdirSync(serviceDir(coordRoot), { recursive: true, mode: 0o700 });
  const logFd = openSync(serviceLogPath(coordRoot), "a", 0o600);
  chmodSync(serviceLogPath(coordRoot), 0o600);
  const harnBin = new URL("../../../bin/harn", import.meta.url).pathname;
  if (!existsSync(harnBin)) {
    closeSync(logFd);
    throw new Error(`cannot find harn executable at ${harnBin}`);
  }
  let spawnError: Error | undefined;
  const child = spawn(harnBin, ["supervisor", "service", "daemon"], {
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
    const status = readSupervisorServiceStatus(coordRoot);
    if (status.running && status.record?.pid === child.pid) return status;
    if (child.exitCode !== null) break;
  }
  throw new Error(`supervisor service failed to start; inspect ${serviceLogPath(coordRoot)}`);
}

export function requestSupervisorServiceStop(coordRootRaw: string): SupervisorServiceStatus {
  const coordRoot = resolve(coordRootRaw);
  const status = readSupervisorServiceStatus(coordRoot);
  if (!status.running || !status.record) return status;
  writePrivateJsonAtomic(serviceStopPath(coordRoot), {
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
  return readSupervisorServiceStatus(coordRoot);
}

export async function runSupervisorServiceSweep(
  input: RunSupervisorServiceSweepInput,
): Promise<SupervisorServiceSweepReport> {
  const coordRoot = resolve(input.coordRoot);
  const now = input.now ?? Date.now;
  const readGoal = input.readGoal ?? readSupervisor;
  const runtime = runtimeForConfig(coordRoot, input.config, now());
  const startedAt = new Date(now()).toISOString();
  const outcomes: SupervisorServiceSweepOutcome[] = [];
  const runGoal =
    input.runGoal ??
    (async (goalId: string) => {
      if (!input.engine) throw new Error("supervisor service sweep requires an engine");
      return await runSupervisor({
        coordRoot,
        goalId,
        mode: "tick",
        actor: input.actor ?? "supervisor-service",
        engine: input.engine,
      });
    });

  for (const goalId of input.config.goal_ids) {
    const timestamp = now();
    const record = readGoal(coordRoot, goalId);
    const fingerprint = goalFingerprint(record);
    const previous = runtime.goals[goalId] ?? emptyGoalRuntime();
    const changed =
      previous.observed_fingerprint !== undefined && previous.observed_fingerprint !== fingerprint;
    if (previous.state === "backoff" && !changed && !wakeDue(previous.next_wake_at, timestamp)) {
      outcomes.push({
        goal_id: goalId,
        action: "skip",
        reason: "service error backoff has not elapsed",
        next_wake_at: previous.next_wake_at,
      });
      continue;
    }
    if (previous.state === "awaiting_change" && !changed) {
      outcomes.push({
        goal_id: goalId,
        action: "skip",
        reason: "durable goal state has not changed",
      });
      continue;
    }
    if (record.projection.state !== "ready") {
      runtime.goals[goalId] = {
        ...previous,
        state: "awaiting_change",
        consecutive_errors: 0,
        observed_fingerprint: fingerprint,
        next_wake_at: undefined,
        last_error: undefined,
      };
      outcomes.push({
        goal_id: goalId,
        action: "skip",
        reason: `goal is ${record.projection.state}: ${record.projection.reason}`,
      });
      persistRuntime(coordRoot, runtime, timestamp);
      continue;
    }

    input.onGoalStart?.(goalId);
    try {
      const report = await runGoal(goalId);
      const completedAt = now();
      const awaitingChange = report.projection.state !== "ready";
      runtime.goals[goalId] = {
        state: awaitingChange ? "awaiting_change" : "idle",
        consecutive_errors: 0,
        observed_fingerprint: projectionFingerprint(report.projection),
        next_wake_at: awaitingChange ? undefined : new Date(completedAt).toISOString(),
        last_tick_at: new Date(completedAt).toISOString(),
        last_stop_reason: report.stop_reason,
      };
      outcomes.push({
        goal_id: goalId,
        action: "tick",
        reason: report.reason,
        stop_reason: report.stop_reason,
        next_wake_at: runtime.goals[goalId]?.next_wake_at,
      });
      appendServiceEvent(coordRoot, {
        event: "goal.tick",
        goal_id: goalId,
        stop_reason: report.stop_reason,
        reason: boundedError(report.reason),
        cycles: report.cycles,
        dispatches: report.dispatches,
        acceptances: report.acceptances,
        replans: report.replans,
      });
      persistRuntime(coordRoot, runtime, completedAt);
    } catch (error) {
      const failedAt = now();
      const consecutiveErrors = previous.consecutive_errors + 1;
      const backoff = Math.min(
        input.config.error_backoff_max_ms,
        input.config.error_backoff_base_ms * 2 ** Math.min(consecutiveErrors - 1, 20),
      );
      let observed = fingerprint;
      try {
        observed = goalFingerprint(readGoal(coordRoot, goalId));
      } catch {
        // Preserve the pre-attempt fingerprint when reread also fails.
      }
      const nextWakeAt = new Date(failedAt + backoff).toISOString();
      const message = boundedError((error as Error).message);
      runtime.goals[goalId] = {
        ...previous,
        state: "backoff",
        consecutive_errors: consecutiveErrors,
        observed_fingerprint: observed,
        next_wake_at: nextWakeAt,
        last_tick_at: new Date(failedAt).toISOString(),
        last_error: message,
      };
      outcomes.push({
        goal_id: goalId,
        action: "backoff",
        reason: message,
        next_wake_at: nextWakeAt,
      });
      appendServiceEvent(coordRoot, {
        event: "goal.error",
        goal_id: goalId,
        error: message,
        consecutive_errors: consecutiveErrors,
        next_wake_at: nextWakeAt,
      });
      persistRuntime(coordRoot, runtime, failedAt);
    }
  }
  const endedAt = new Date(now()).toISOString();
  persistRuntime(coordRoot, runtime, Date.parse(endedAt));
  return { started_at: startedAt, ended_at: endedAt, outcomes };
}

export async function runSupervisorServiceDaemon(
  input: RunSupervisorServiceDaemonInput,
): Promise<SupervisorServiceStatusRecord> {
  const coordRoot = resolve(input.coordRoot);
  const config = readSupervisorServiceConfig(coordRoot);
  const release = acquireServiceLease(coordRoot);
  rmSync(serviceStopPath(coordRoot), { force: true });
  const now = new Date().toISOString();
  const status: SupervisorServiceStatusRecord = {
    schema_version: SUPERVISOR_SERVICE_STATUS_SCHEMA_VERSION,
    pid: process.pid,
    host: hostname(),
    nonce: randomUUID(),
    state: "starting",
    started_at: now,
    heartbeat_at: now,
    config_created_at: config.created_at,
    sweep_count: 0,
  };
  let stopRequested = false;
  const log = input.onLog ?? (() => undefined);
  const writeStatus = (): void => {
    status.heartbeat_at = new Date().toISOString();
    writePrivateJsonAtomic(serviceStatusPath(coordRoot), status);
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
  appendServiceEvent(coordRoot, {
    event: "service.started",
    pid: process.pid,
    goals: config.goal_ids,
    config_created_at: config.created_at,
  });
  log(`supervisor service started for ${config.goal_ids.length} goal(s)`);
  const heartbeat = setInterval(() => {
    try {
      writeStatus();
    } catch (error) {
      log(`supervisor service heartbeat error: ${boundedError((error as Error).message)}`);
    }
  }, config.heartbeat_interval_ms);
  try {
    while (!stopRequested && !existsSync(serviceStopPath(coordRoot))) {
      let sleepMs = config.wake_interval_ms;
      try {
        const report = await runSupervisorServiceSweep({
          coordRoot,
          config,
          engine: input.engine,
          actor: input.actor,
          onGoalStart: (goalId) => {
            status.active_goal_id = goalId;
            writeStatus();
          },
        });
        status.sweep_count++;
        status.active_goal_id = undefined;
        status.last_sweep_at = report.ended_at;
        status.last_error = undefined;
        status.next_wake_at = new Date(Date.now() + config.wake_interval_ms).toISOString();
        writeStatus();
        const summary = renderSweepLog(report);
        if (summary) log(summary);
      } catch (error) {
        sleepMs = config.error_backoff_max_ms;
        status.active_goal_id = undefined;
        status.last_error = boundedError((error as Error).message);
        status.next_wake_at = new Date(Date.now() + config.error_backoff_max_ms).toISOString();
        writeStatus();
        appendServiceEvent(coordRoot, {
          event: "service.sweep_error",
          error: status.last_error,
        });
        log(`supervisor service sweep error: ${status.last_error}`);
      }
      if (input.maxSweeps !== undefined && status.sweep_count >= input.maxSweeps) break;
      if (!stopRequested && !existsSync(serviceStopPath(coordRoot))) {
        await interruptibleDelay(
          sleepMs,
          () => stopRequested || existsSync(serviceStopPath(coordRoot)),
        );
      }
    }
  } finally {
    clearInterval(heartbeat);
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    status.state = "stopped";
    status.active_goal_id = undefined;
    status.stopped_at = new Date().toISOString();
    writeStatus();
    appendServiceEvent(coordRoot, {
      event: "service.stopped",
      pid: process.pid,
      sweeps: status.sweep_count,
    });
    rmSync(serviceStopPath(coordRoot), { force: true });
    release();
  }
  return status;
}

export function supervisorServiceLogPath(coordRoot: string): string {
  return serviceLogPath(resolve(coordRoot));
}

function runtimeForConfig(
  coordRoot: string,
  config: SupervisorServiceConfig,
  timestamp: number,
): SupervisorServiceRuntime {
  let existing: SupervisorServiceRuntime | undefined;
  try {
    existing = readSupervisorServiceRuntime(coordRoot);
  } catch {
    // Runtime is a recoverable scheduling hint; durable goal state remains authoritative.
  }
  if (existing?.config_created_at === config.created_at) {
    const goals = Object.fromEntries(
      config.goal_ids.map((goalId) => [goalId, existing.goals[goalId] ?? emptyGoalRuntime()]),
    );
    return { ...existing, goals };
  }
  return {
    schema_version: SUPERVISOR_SERVICE_RUNTIME_SCHEMA_VERSION,
    config_created_at: config.created_at,
    updated_at: new Date(timestamp).toISOString(),
    goals: Object.fromEntries(config.goal_ids.map((goalId) => [goalId, emptyGoalRuntime()])),
  };
}

function emptyGoalRuntime(): SupervisorServiceGoalRuntime {
  return { state: "idle", consecutive_errors: 0 };
}

function persistRuntime(
  coordRoot: string,
  runtime: SupervisorServiceRuntime,
  timestamp: number,
): void {
  runtime.updated_at = new Date(timestamp).toISOString();
  writePrivateJsonAtomic(serviceRuntimePath(coordRoot), runtime);
}

function goalFingerprint(record: SupervisorRecord): string {
  return projectionFingerprint(record.projection);
}

function projectionFingerprint(projection: SupervisorRecord["projection"]): string {
  return JSON.stringify([
    projection.state,
    projection.next_action,
    projection.attempts_used,
    projection.attempts_remaining,
    projection.root_work_id,
    projection.root_materialized,
    projection.plan_generation,
    projection.replans_used,
    projection.replans_remaining,
    projection.milestones_completed,
    projection.milestones_remaining,
    projection.pending_plan_id,
    projection.latest_plan_status,
    projection.ready_work,
    projection.resumable_work,
    projection.retryable_work,
    projection.attention_work,
  ]);
}

function wakeDue(value: string | undefined, now: number): boolean {
  return !value || Date.parse(value) <= now;
}

function normalizeEngineConfig(
  coordRoot: string,
  input: Partial<SupervisorServiceEngineConfig> | undefined,
): SupervisorServiceEngineConfig {
  return {
    default_harness: optionalBounded(input?.default_harness, "default_harness", 100),
    cwd: input?.cwd ? resolve(input.cwd) : coordRoot,
    subscription_only: bool(input?.subscription_only ?? false, "subscription_only"),
    allow_api_billing: bool(input?.allow_api_billing ?? false, "allow_api_billing"),
    policy: input?.policy ? normalizePolicy(input.policy) : undefined,
    isolation: normalizeIsolation(input?.isolation),
    approval_addressee: optionalBounded(input?.approval_addressee, "approval_addressee", 200),
  };
}

function validateConfig(coordRoot: string, config: SupervisorServiceConfig): void {
  if (
    config.schema_version !== SUPERVISOR_SERVICE_CONFIG_SCHEMA_VERSION ||
    !validTimestamp(config.created_at) ||
    !Array.isArray(config.goal_ids)
  ) {
    throw new Error("supervisor service configuration has an unsupported schema");
  }
  const normalized: SupervisorServiceConfig = {
    schema_version: SUPERVISOR_SERVICE_CONFIG_SCHEMA_VERSION,
    goal_ids: unique(config.goal_ids.map((goalId) => goalId.trim()).filter(Boolean)),
    wake_interval_ms: positive(
      config.wake_interval_ms,
      "service wake_interval_ms",
      60 * 60 * 1_000,
    ),
    heartbeat_interval_ms: positive(
      config.heartbeat_interval_ms,
      "service heartbeat_interval_ms",
      60_000,
    ),
    error_backoff_base_ms: positive(
      config.error_backoff_base_ms,
      "service error_backoff_base_ms",
      60 * 60 * 1_000,
    ),
    error_backoff_max_ms: positive(
      config.error_backoff_max_ms,
      "service error_backoff_max_ms",
      24 * 60 * 60 * 1_000,
    ),
    engine: normalizeEngineConfig(coordRoot, config.engine),
    created_at: config.created_at,
  };
  if (
    normalized.goal_ids.length < 1 ||
    normalized.goal_ids.length > MAX_GOALS ||
    normalized.error_backoff_max_ms < normalized.error_backoff_base_ms ||
    JSON.stringify(normalized) !== JSON.stringify(config)
  ) {
    throw new Error("supervisor service configuration is not canonical");
  }
}

function normalizeIsolation(value: unknown): PolicyIsolation | undefined {
  if (value === undefined) return undefined;
  if (value === "shared" || value === "worktree" || value === "sandbox" || value === "remote") {
    return value;
  }
  throw new Error("service isolation must be shared, worktree, sandbox, or remote");
}

function acquireServiceLease(coordRoot: string): () => void {
  const path = serviceLeasePath(coordRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const owner: ServiceLease = {
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
      throw new Error(`supervisor service is already running under pid ${existing.pid}`);
    }
    unlinkSync(path);
    if (!acquire()) throw new Error("supervisor service lease raced with another process");
  }
  return () => {
    try {
      const existing = readLease(path);
      if (existing?.nonce === owner.nonce) unlinkSync(path);
    } catch {
      // A stale lease is recoverable by the next explicit service start.
    }
  };
}

function readLease(path: string): ServiceLease | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ServiceLease>;
    return Number.isSafeInteger(value.pid) &&
      (value.pid ?? 0) > 0 &&
      typeof value.host === "string" &&
      typeof value.nonce === "string" &&
      typeof value.created_at === "string"
      ? (value as ServiceLease)
      : null;
  } catch {
    return null;
  }
}

function leaseOwnerIsLive(lease: ServiceLease): boolean {
  if (lease.host !== hostname()) {
    const age = Date.now() - Date.parse(lease.created_at);
    return Number.isFinite(age) && age < FOREIGN_STATUS_STALE_MS;
  }
  return pidAlive(lease.pid);
}

function readStatusRecord(coordRoot: string): SupervisorServiceStatusRecord | undefined {
  if (!existsSync(serviceStatusPath(coordRoot))) return undefined;
  try {
    const value = readBoundedJson<SupervisorServiceStatusRecord>(
      serviceStatusPath(coordRoot),
      "supervisor service status",
    );
    if (
      value.schema_version !== SUPERVISOR_SERVICE_STATUS_SCHEMA_VERSION ||
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      typeof value.host !== "string" ||
      typeof value.nonce !== "string" ||
      !validTimestamp(value.started_at) ||
      !validTimestamp(value.heartbeat_at)
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function statusOwnerIsLive(record: SupervisorServiceStatusRecord): boolean {
  if (record.state === "stopped") return false;
  if (record.host === hostname()) return pidAlive(record.pid);
  const age = Date.now() - Date.parse(record.heartbeat_at);
  return Number.isFinite(age) && age < FOREIGN_STATUS_STALE_MS;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function appendServiceEvent(coordRoot: string, data: Record<string, unknown>): void {
  const path = serviceEventsPath(coordRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(
    path,
    `${JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), ...data })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

function renderSweepLog(report: SupervisorServiceSweepReport): string | undefined {
  const counts = report.outcomes.reduce<Record<string, number>>((acc, outcome) => {
    acc[outcome.action] = (acc[outcome.action] ?? 0) + 1;
    return acc;
  }, {});
  if (!counts.tick && !counts.backoff) return undefined;
  return `supervisor service sweep: ${counts.tick ?? 0} tick, ${counts.skip ?? 0} skip, ${counts.backoff ?? 0} backoff`;
}

function readBoundedJson<T>(path: string, label: string): T {
  if (!existsSync(path)) throw new Error(`${label} does not exist`);
  const size = statSync(path).size;
  if (size <= 0 || size > MAX_FILE_BYTES) throw new Error(`${label} has invalid size ${size}`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`cannot parse ${label}: ${(error as Error).message}`);
  }
}

function writePrivateJsonAtomic(path: string, value: unknown): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_FILE_BYTES) {
    throw new Error(`supervisor service file exceeds ${MAX_FILE_BYTES} bytes`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function serviceDir(coordRoot: string): string {
  return join(resolve(coordRoot), ".harnery", "supervisor-service");
}

function serviceConfigPath(coordRoot: string): string {
  return join(serviceDir(coordRoot), "config.json");
}

function serviceRuntimePath(coordRoot: string): string {
  return join(serviceDir(coordRoot), "runtime.json");
}

function serviceStatusPath(coordRoot: string): string {
  return join(serviceDir(coordRoot), "status.json");
}

function serviceLeasePath(coordRoot: string): string {
  return join(serviceDir(coordRoot), "lease.json");
}

function serviceStopPath(coordRoot: string): string {
  return join(serviceDir(coordRoot), "stop.json");
}

function serviceLogPath(coordRoot: string): string {
  return join(serviceDir(coordRoot), "service.log");
}

function serviceEventsPath(coordRoot: string): string {
  return join(serviceDir(coordRoot), "events.jsonl");
}

function positive(value: unknown, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`${field} must be an integer from 1 to ${max}`);
  }
  return value as number;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`service ${field} must be boolean`);
  return value;
}

function optionalBounded(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`service ${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`service ${field} must not be empty`);
  if (normalized.length > max) throw new Error(`service ${field} exceeds ${max} characters`);
  return normalized;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function boundedError(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim() || "unknown service error";
  return normalized.length > MAX_ERROR ? `${normalized.slice(0, MAX_ERROR - 1)}…` : normalized;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function interruptibleDelay(ms: number, interrupted: () => boolean): Promise<void> {
  const deadline = Date.now() + ms;
  while (!interrupted()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await delay(Math.min(remaining, 100));
  }
}
