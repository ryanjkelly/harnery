import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, platform } from "node:os";
import { resolve } from "node:path";
import { checkPidToken, processStartToken } from "../agents/state/proc-start.ts";
import { closeProcessLoggers, legacyLogFields, processLogger } from "../storage/logger.ts";
import {
  RESOURCE_SERVICE_STATUS_SCHEMA_VERSION,
  type ResourceSamplerState,
  type ResourceServiceStatus,
  type ResourceServiceStatusRecord,
} from "./contract.ts";
import { sampleResources } from "./sampler.ts";
import { readResourceServiceStatus } from "./service-status.ts";
import { resourcePaths, writePrivateJsonAtomic } from "./storage.ts";

export const RESOURCE_SERVICE_DEFAULT_INTERVAL_MS = 2_000;
const RESOURCE_SERVICE_MIN_INTERVAL_MS = 500;
const RESOURCE_SERVICE_MAX_INTERVAL_MS = 60_000;

interface ResourceServiceLease {
  pid: number;
  start_token?: string;
  host: string;
  nonce: string;
  created_at: string;
}

export interface RunResourceServiceInput {
  coordRoot: string;
  intervalMs?: number;
  maxSamples?: number;
  now?: () => Date;
  sample?: typeof sampleResources;
  wait?: (milliseconds: number) => Promise<void>;
}

export type EnsureResourceServiceResult =
  | { state: "running" | "started"; status: ResourceServiceStatus }
  | { state: "unsupported" | "unavailable"; status: ResourceServiceStatus; error: string };

export async function spawnResourceService(
  coordRootRaw: string,
  options: { intervalMs?: number } = {},
): Promise<ResourceServiceStatus> {
  const coordRoot = resolve(coordRootRaw);
  const current = readResourceServiceStatus(coordRoot);
  if (current.running) {
    throw new Error(`resource observer is already running under pid ${current.record?.pid}`);
  }
  const intervalMs = normalizeInterval(options.intervalMs);
  const paths = resourcePaths(coordRoot);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  rmSync(paths.stop, { force: true });
  const harnBin = new URL("../../../bin/harn", import.meta.url).pathname;
  if (!existsSync(harnBin)) throw new Error(`cannot find harn executable at ${harnBin}`);
  let spawnError: Error | undefined;
  const child = spawn(
    harnBin,
    ["resources", "service", "daemon", "--root", coordRoot, "--interval-ms", String(intervalMs)],
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
    const status = readResourceServiceStatus(coordRoot);
    if (status.running && status.record?.pid === child.pid) return status;
    if (child.exitCode !== null) break;
  }
  throw new Error(`resource observer failed to start; inspect ${paths.service}`);
}

export async function ensureResourceServiceRunning(
  coordRoot: string,
): Promise<EnsureResourceServiceResult> {
  const status = readResourceServiceStatus(coordRoot);
  if (status.running) return { state: "running", status };
  if (platform() !== "linux") {
    return {
      state: "unsupported",
      status,
      error: `resource observer does not yet support ${platform()}`,
    };
  }
  try {
    const started = await spawnResourceService(coordRoot);
    return { state: "started", status: started };
  } catch (error) {
    return {
      state: "unavailable",
      status: readResourceServiceStatus(coordRoot),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function requestResourceServiceStop(coordRootRaw: string): ResourceServiceStatus {
  const coordRoot = resolve(coordRootRaw);
  const paths = resourcePaths(coordRoot);
  const status = readResourceServiceStatus(coordRoot);
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
  return readResourceServiceStatus(coordRoot);
}

export async function runResourceService(
  input: RunResourceServiceInput,
): Promise<ResourceServiceStatusRecord> {
  const coordRoot = resolve(input.coordRoot);
  const paths = resourcePaths(coordRoot);
  const intervalMs = normalizeInterval(input.intervalMs);
  const now = input.now ?? (() => new Date());
  const sample = input.sample ?? sampleResources;
  const wait = input.wait ?? delay;
  const lease = acquireLease(coordRoot, now());
  rmSync(paths.stop, { force: true });
  const startedAt = now().toISOString();
  const daemonStartToken = processStartToken(process.pid);
  const status: ResourceServiceStatusRecord = {
    schema_version: RESOURCE_SERVICE_STATUS_SCHEMA_VERSION,
    pid: process.pid,
    ...(daemonStartToken ? { start_token: daemonStartToken } : {}),
    host: hostname(),
    nonce: lease.nonce,
    state: "starting",
    started_at: startedAt,
    heartbeat_at: startedAt,
    interval_ms: intervalMs,
    sample_count: 0,
  };
  let stopping = false;
  let previous: ResourceSamplerState | undefined;
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
  log(coordRoot, "resource_observer.started", { pid: process.pid, interval_ms: intervalMs });
  try {
    while (!stopping && !existsSync(paths.stop)) {
      const cycleStarted = Date.now();
      try {
        const result = sample(coordRoot, previous);
        previous = result.state;
        writePrivateJsonAtomic(paths.snapshot, result.snapshot);
        status.sample_count += 1;
        status.last_sample_at = result.snapshot.sampled_at;
        status.last_error_code = undefined;
        log(coordRoot, "resource_observer.sample", {
          sample_count: status.sample_count,
          cpu_percent: result.snapshot.machine.cpu_percent ?? -1,
          memory_percent: result.snapshot.machine.memory_percent ?? -1,
          visible_processes: result.snapshot.visible_process_count,
          unattributed_processes: result.snapshot.unattributed_process_count,
          duration_ms: result.snapshot.sample_duration_ms,
          collector_cpu_ms: result.snapshot.collector_cpu_ms,
        });
      } catch (error) {
        status.last_error_code = resourceErrorCode(error);
        status.state = "error";
        log(
          coordRoot,
          "resource_observer.sample_error",
          { reason_code: status.last_error_code },
          error,
        );
      }
      if (status.state === "error") status.state = "running";
      writeStatus();
      if (input.maxSamples !== undefined && status.sample_count >= input.maxSamples) break;
      const remaining = Math.max(0, intervalMs - (Date.now() - cycleStarted));
      if (!stopping && !existsSync(paths.stop)) await wait(remaining);
    }
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    status.state = "stopped";
    status.stopped_at = now().toISOString();
    writeStatus();
    log(coordRoot, "resource_observer.stopped", { sample_count: status.sample_count });
    try {
      await closeProcessLoggers();
    } finally {
      releaseLease(paths.lease, lease.nonce);
    }
  }
  return status;
}

function acquireLease(coordRoot: string, now: Date): ResourceServiceLease {
  const paths = resourcePaths(coordRoot);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    const daemonStartToken = processStartToken(process.pid);
    const lease: ResourceServiceLease = {
      pid: process.pid,
      ...(daemonStartToken ? { start_token: daemonStartToken } : {}),
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
        throw new Error(`resource observer lease is held by pid ${existing.pid}`);
      }
      try {
        unlinkSync(paths.lease);
      } catch {
        // A concurrent starter may have replaced or removed the stale lease.
      }
    }
  }
  throw new Error("resource observer could not acquire its singleton lease");
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

function readLease(path: string): ResourceServiceLease | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ResourceServiceLease;
    return value && Number.isInteger(value.pid) && typeof value.nonce === "string"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function leaseIsLive(lease: ResourceServiceLease): boolean {
  if (lease.host !== hostname()) return true;
  try {
    process.kill(lease.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return checkPidToken(lease.pid, lease.start_token) !== "mismatch";
}

function log(
  coordRoot: string,
  event: string,
  fields: Record<string, unknown>,
  error?: unknown,
): void {
  try {
    const logger = processLogger(coordRoot, "resource-observer");
    if (error) logger.error(event, legacyLogFields(fields), error);
    else logger.info(event, legacyLogFields(fields));
  } catch {
    // Observability must never break the observer loop.
  }
}

function resourceErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/procfs|\/proc\//i.test(message)) return "procfs_read_failed";
  if (/permission|EACCES|EPERM/i.test(message)) return "permission_denied";
  return "sample_failed";
}

function normalizeInterval(value: number | undefined): number {
  const interval = value ?? RESOURCE_SERVICE_DEFAULT_INTERVAL_MS;
  if (
    !Number.isFinite(interval) ||
    interval < RESOURCE_SERVICE_MIN_INTERVAL_MS ||
    interval > RESOURCE_SERVICE_MAX_INTERVAL_MS
  ) {
    throw new Error(
      `resource observer interval must be ${RESOURCE_SERVICE_MIN_INTERVAL_MS}-${RESOURCE_SERVICE_MAX_INTERVAL_MS} ms`,
    );
  }
  return Math.round(interval);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
