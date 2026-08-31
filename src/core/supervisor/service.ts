import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { collectCoordinationHealthSnapshot } from "../agents/health.ts";
import { checkPidToken, processStartToken } from "../agents/state/proc-start.ts";
import type { ResourceSamplerState } from "../resources/contract.ts";
import { sampleResources } from "../resources/sampler.ts";
import { requestResourceServiceStop } from "../resources/service.ts";
import { readResourceServiceStatus } from "../resources/service-status.ts";
import { resourcePaths } from "../resources/storage.ts";
import { writePrivateJsonAtomic } from "../storage/atomic-json.ts";
import { closeProcessLoggers, legacyLogFields, processLogger } from "../storage/logger.ts";
import {
  SUPERVISOR_SNAPSHOT_SCHEMA_VERSION,
  SUPERVISOR_STATUS_SCHEMA_VERSION,
  type SupervisorServiceStatusRecord,
  type SupervisorSnapshot,
  type SupervisorStatus,
} from "./contract.ts";
import { explainSupervisorFinding } from "./explanations.ts";
import { updateSupervisorFindings } from "./findings.ts";
import { updateSupervisorHistory } from "./history.ts";
import { collectHookHealth } from "./hooks.ts";
import { SupervisorLogCollector } from "./log-feed.ts";
import { collectServiceHealth } from "./services.ts";
import { readSupervisorStatus } from "./status.ts";
import { readSupervisorFindings, readSupervisorHistory, supervisorPaths } from "./storage.ts";
import { buildSupervisorTimeline } from "./timeline.ts";

export const SUPERVISOR_DEFAULT_INTERVAL_MS = 2_000;
export const SUPERVISOR_DEFAULT_IDLE_EXIT_MS = 2 * 60_000;
const SUPERVISOR_MIN_INTERVAL_MS = 500;
const SUPERVISOR_MAX_INTERVAL_MS = 60_000;
const SUPERVISOR_MIN_IDLE_EXIT_MS = 5_000;
const SUPERVISOR_MAX_IDLE_EXIT_MS = 24 * 60 * 60_000;

interface SupervisorLease {
  pid: number;
  start_token?: string;
  host: string;
  nonce: string;
  created_at: string;
}

export interface RunSupervisorInput {
  coordRoot: string;
  intervalMs?: number;
  idleExitMs?: number;
  keepAlive?: boolean;
  maxCycles?: number;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
}

export type EnsureSupervisorResult =
  | { state: "running" | "started"; status: SupervisorStatus }
  | { state: "unavailable"; status: SupervisorStatus; error: string };

export async function spawnSupervisor(
  coordRootRaw: string,
  options: { intervalMs?: number; idleExitMs?: number; keepAlive?: boolean } = {},
): Promise<SupervisorStatus> {
  const coordRoot = resolve(coordRootRaw);
  const current = readSupervisorStatus(coordRoot);
  if (current.running) {
    throw new Error(`local supervisor is already running under pid ${current.record?.pid}`);
  }
  await stopLegacyResourceObserver(coordRoot);
  const intervalMs = normalizeInterval(options.intervalMs);
  const idleExitMs = normalizeIdleExit(options.idleExitMs);
  const paths = supervisorPaths(coordRoot);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  rmSync(paths.stop, { force: true });
  const harnBin = new URL("../../../bin/harn", import.meta.url).pathname;
  if (!existsSync(harnBin)) throw new Error(`cannot find harn executable at ${harnBin}`);
  let spawnError: Error | undefined;
  const child = spawn(
    harnBin,
    [
      "supervisor",
      "daemon",
      "--root",
      coordRoot,
      "--interval-ms",
      String(intervalMs),
      "--idle-exit-ms",
      String(idleExitMs),
      ...(options.keepAlive ? ["--keep-alive"] : []),
    ],
    {
      cwd: coordRoot,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        HARNERY_COORD_ROOT_OVERRIDE: coordRoot,
        HARNERY_OUTPUT_SESSION_TEE: "0",
      },
    },
  );
  child.once("error", (error) => {
    spawnError = error;
  });
  child.unref();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await delay(50);
    if (spawnError) throw spawnError;
    const status = readSupervisorStatus(coordRoot);
    if (status.running && status.record?.pid === child.pid) return status;
    if (child.exitCode !== null) break;
  }
  throw new Error(`local supervisor failed to start; inspect ${paths.service}`);
}

export async function ensureSupervisorRunning(coordRoot: string): Promise<EnsureSupervisorResult> {
  const status = readSupervisorStatus(coordRoot);
  if (status.running) return { state: "running", status };
  try {
    const started = await spawnSupervisor(coordRoot);
    return { state: "started", status: started };
  } catch (error) {
    return {
      state: "unavailable",
      status: readSupervisorStatus(coordRoot),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function requestSupervisorStop(coordRootRaw: string): SupervisorStatus {
  const coordRoot = resolve(coordRootRaw);
  const paths = supervisorPaths(coordRoot);
  const status = readSupervisorStatus(coordRoot);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  writePrivateJsonAtomic(paths.stop, {
    requested_at: new Date().toISOString(),
    requested_by_pid: process.pid,
  });
  if (status.running && status.record?.host === hostname()) {
    try {
      process.kill(status.record.pid, "SIGTERM");
    } catch {
      // The durable stop file handles a racing exit.
    }
  }
  return readSupervisorStatus(coordRoot);
}

export async function runSupervisor(
  input: RunSupervisorInput,
): Promise<SupervisorServiceStatusRecord> {
  const coordRoot = resolve(input.coordRoot);
  const paths = supervisorPaths(coordRoot);
  const intervalMs = normalizeInterval(input.intervalMs);
  const idleExitMs = normalizeIdleExit(input.idleExitMs);
  const keepAlive = input.keepAlive ?? false;
  const now = input.now ?? (() => new Date());
  const wait = input.wait ?? delay;
  const lease = acquireLease(coordRoot, now());
  rmSync(paths.stop, { force: true });
  const startedAt = now().toISOString();
  const startToken = processStartToken(process.pid);
  const status: SupervisorServiceStatusRecord = {
    schema_version: SUPERVISOR_STATUS_SCHEMA_VERSION,
    pid: process.pid,
    ...(startToken ? { start_token: startToken } : {}),
    host: hostname(),
    nonce: lease.nonce,
    state: "starting",
    started_at: startedAt,
    heartbeat_at: startedAt,
    interval_ms: intervalMs,
    keep_alive: keepAlive,
    idle_exit_ms: idleExitMs,
    cycle_count: 0,
  };
  let stopping = false;
  let previousResource: ResourceSamplerState | undefined;
  let history = readSupervisorHistory(coordRoot);
  let findings = readSupervisorFindings(coordRoot);
  let coordination = collectCoordinationHealthSnapshot(coordRoot, now());
  const logs = new SupervisorLogCollector(coordRoot);
  const writeStatus = () => {
    status.heartbeat_at = now().toISOString();
    writePrivateJsonAtomic(paths.service, status);
  };
  const requestStop = () => {
    stopping = true;
    status.state = "stopping";
    writeStatus();
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  status.state = "running";
  writeStatus();
  log(coordRoot, "supervisor.started", {
    pid: process.pid,
    interval_ms: intervalMs,
    idle_exit_ms: idleExitMs,
    keep_alive: keepAlive,
  });
  try {
    while (!stopping && !existsSync(paths.stop)) {
      const cycleStarted = performance.now();
      try {
        const resource = sampleResources(coordRoot, previousResource, {
          service: { pid: process.pid, id: "supervisor" },
        });
        previousResource = resource.state;
        writePrivateJsonAtomic(resourcePaths(coordRoot).snapshot, resource.snapshot);
        const logFeed = await logs.collect(now());
        writePrivateJsonAtomic(paths.log_feed, logFeed);
        const serviceHealth = collectServiceHealth(coordRoot, status);
        const hooks = collectHookHealth(resource.snapshot);
        const historyResult = updateSupervisorHistory(history, resource.snapshot);
        history = historyResult.history;
        if (historyResult.changed) writePrivateJsonAtomic(paths.history, history);
        if (historyResult.changed)
          coordination = collectCoordinationHealthSnapshot(coordRoot, now());
        writePrivateJsonAtomic(paths.coordination_health, coordination);
        const priorActiveFindingIds = new Set(findings?.active.map((finding) => finding.id) ?? []);
        const priorTransitionKeys = new Set(
          findings?.transitions.map((finding) => `${finding.id}:${finding.state}`) ?? [],
        );
        findings = updateSupervisorFindings({
          previous: findings,
          resource: resource.snapshot,
          services: serviceHealth.services,
          hooks,
          history,
          logFeed,
          coordination,
          now: now(),
        });
        writePrivateJsonAtomic(paths.findings, findings);
        mkdirSync(paths.timelines, { recursive: true, mode: 0o700 });
        mkdirSync(paths.explanations, { recursive: true, mode: 0o700 });
        const projectionUpdates = [
          ...findings.active.filter((finding) => !priorActiveFindingIds.has(finding.id)),
          ...findings.transitions.filter(
            (finding) => !priorTransitionKeys.has(`${finding.id}:${finding.state}`),
          ),
        ];
        for (const finding of projectionUpdates) {
          const relatedSources = coordination.recent_events.filter((source) => {
            const delta = Math.abs(
              Date.parse(source.observed_at) - Date.parse(finding.observed_at),
            );
            return Number.isFinite(delta) && delta <= 5 * 60_000;
          });
          writePrivateJsonAtomic(
            resolve(paths.timelines, `${finding.id}.json`),
            buildSupervisorTimeline(finding, relatedSources),
          );
          writePrivateJsonAtomic(
            resolve(paths.explanations, `${finding.id}.json`),
            explainSupervisorFinding(finding),
          );
        }
        const retainedFindingIds = new Set([
          ...findings.active.map((finding) => finding.id),
          ...findings.transitions.map((finding) => finding.id),
        ]);
        pruneProjectionDirectory(paths.timelines, retainedFindingIds);
        pruneProjectionDirectory(paths.explanations, retainedFindingIds);
        const attributedAgentCount = resource.snapshot.groups.filter(
          (group) => group.kind === "agent",
        ).length;
        const idle = serviceHealth.consumers.length === 0 && attributedAgentCount === 0;
        if (!keepAlive && idle) status.idle_since ??= now().toISOString();
        else status.idle_since = undefined;
        const snapshot: SupervisorSnapshot = {
          schema_version: SUPERVISOR_SNAPSHOT_SCHEMA_VERSION,
          sampled_at: resource.snapshot.sampled_at,
          sequence: status.cycle_count + 1,
          collector_duration_ms: round1(performance.now() - cycleStarted),
          resource_sample_duration_ms: resource.snapshot.sample_duration_ms,
          services: serviceHealth.services,
          hooks,
          active_finding_count: findings.active.length,
          history_point_count: history.points.length,
          log_record_count: logFeed.total_records,
          live_consumer_count: serviceHealth.consumers.length,
          attributed_agent_count: attributedAgentCount,
        };
        writePrivateJsonAtomic(paths.snapshot, snapshot);
        status.cycle_count += 1;
        status.last_cycle_at = snapshot.sampled_at;
        status.last_cycle_duration_ms = snapshot.collector_duration_ms;
        status.last_error_code = undefined;
        log(coordRoot, "supervisor.sample", {
          cycle_count: status.cycle_count,
          duration_ms: snapshot.collector_duration_ms,
          resource_cpu_ms: resource.snapshot.collector_cpu_ms,
          visible_processes: resource.snapshot.visible_process_count,
          services: serviceHealth.services.length,
          hooks: hooks.length,
          findings: findings.active.length,
          log_records: logFeed.total_records,
        });
        if (
          !keepAlive &&
          status.idle_since &&
          now().getTime() - Date.parse(status.idle_since) >= idleExitMs
        ) {
          log(coordRoot, "supervisor.idle_exit", { idle_exit_ms: idleExitMs });
          break;
        }
      } catch (error) {
        status.last_error_code = supervisorErrorCode(error);
        status.state = "error";
        log(coordRoot, "supervisor.sample_error", { reason_code: status.last_error_code }, error);
      }
      if (status.state === "error") status.state = "running";
      writeStatus();
      if (input.maxCycles !== undefined && status.cycle_count >= input.maxCycles) break;
      const remaining = Math.max(0, intervalMs - (performance.now() - cycleStarted));
      if (!stopping && !existsSync(paths.stop)) await wait(remaining);
    }
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    status.state = "stopped";
    status.stopped_at = now().toISOString();
    status.idle_since = undefined;
    writeStatus();
    log(coordRoot, "supervisor.stopped", { cycle_count: status.cycle_count });
    try {
      await closeProcessLoggers();
    } finally {
      releaseLease(paths.lease, lease.nonce);
    }
  }
  return status;
}

function acquireLease(coordRoot: string, now: Date): SupervisorLease {
  const paths = supervisorPaths(coordRoot);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    const startToken = processStartToken(process.pid);
    const lease: SupervisorLease = {
      pid: process.pid,
      ...(startToken ? { start_token: startToken } : {}),
      host: hostname(),
      nonce: randomUUID(),
      created_at: now.toISOString(),
    };
    try {
      const fd = openSync(paths.lease, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(lease)}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readLease(paths.lease);
      if (existing && leaseIsLive(existing)) {
        throw new Error(`local supervisor lease is held by pid ${existing.pid}`);
      }
      try {
        unlinkSync(paths.lease);
      } catch {
        // A concurrent starter may have replaced or removed the stale lease.
      }
    }
  }
  throw new Error("local supervisor could not acquire its singleton lease");
}

function pruneProjectionDirectory(
  directory: string,
  retainedFindingIds: ReadonlySet<string>,
): void {
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".json")) continue;
    const findingId = file.slice(0, -5);
    if (!retainedFindingIds.has(findingId)) rmSync(resolve(directory, file), { force: true });
  }
}

function releaseLease(path: string, nonce: string): void {
  const current = readLease(path);
  if (current?.nonce !== nonce) return;
  try {
    unlinkSync(path);
  } catch {
    // A missing lease is already released.
  }
}

function readLease(path: string): SupervisorLease | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as SupervisorLease;
    return value && Number.isSafeInteger(value.pid) && typeof value.nonce === "string"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function leaseIsLive(lease: SupervisorLease): boolean {
  if (lease.host !== hostname()) return true;
  try {
    process.kill(lease.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return checkPidToken(lease.pid, lease.start_token) !== "mismatch";
}

async function stopLegacyResourceObserver(coordRoot: string): Promise<void> {
  const legacy = readResourceServiceStatus(coordRoot);
  if (!legacy.running) return;
  requestResourceServiceStop(coordRoot);
  const deadline = Date.now() + 2_000;
  while (readResourceServiceStatus(coordRoot).running && Date.now() < deadline) await delay(50);
}

function log(
  coordRoot: string,
  event: string,
  fields: Record<string, unknown>,
  error?: unknown,
): void {
  try {
    const logger = processLogger(coordRoot, "supervisor");
    if (error) logger.error(event, legacyLogFields(fields), error);
    else logger.info(event, legacyLogFields(fields));
  } catch {
    // Observability must never break the supervisor loop.
  }
}

function supervisorErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/procfs|\/proc\//i.test(message)) return "procfs_read_failed";
  if (/permission|EACCES|EPERM/i.test(message)) return "permission_denied";
  if (/log/i.test(message)) return "log_collection_failed";
  return "collection_failed";
}

function normalizeInterval(value: number | undefined): number {
  const interval = value ?? SUPERVISOR_DEFAULT_INTERVAL_MS;
  if (
    !Number.isFinite(interval) ||
    interval < SUPERVISOR_MIN_INTERVAL_MS ||
    interval > SUPERVISOR_MAX_INTERVAL_MS
  ) {
    throw new Error(
      `supervisor interval must be ${SUPERVISOR_MIN_INTERVAL_MS}-${SUPERVISOR_MAX_INTERVAL_MS} ms`,
    );
  }
  return Math.round(interval);
}

function normalizeIdleExit(value: number | undefined): number {
  const idle = value ?? SUPERVISOR_DEFAULT_IDLE_EXIT_MS;
  if (
    !Number.isFinite(idle) ||
    idle < SUPERVISOR_MIN_IDLE_EXIT_MS ||
    idle > SUPERVISOR_MAX_IDLE_EXIT_MS
  ) {
    throw new Error(
      `supervisor idle exit must be ${SUPERVISOR_MIN_IDLE_EXIT_MS}-${SUPERVISOR_MAX_IDLE_EXIT_MS} ms`,
    );
  }
  return Math.round(idle);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
