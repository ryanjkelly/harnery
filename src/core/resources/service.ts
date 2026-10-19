import { existsSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { processStartToken } from "../agents/state/proc-start.ts";
import {
  acquireServiceLease,
  requestServiceStop,
  type ServiceLiveness,
  type ServiceProcessDependencies,
  type ServiceStopFields,
  serviceStartRefusal,
} from "../agents/state/service-process.ts";
import { resolveBinName } from "../config.ts";
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

export interface RunResourceServiceInput {
  coordRoot: string;
  intervalMs?: number;
  maxSamples?: number;
  now?: () => Date;
  sample?: typeof sampleResources;
  wait?: (milliseconds: number) => Promise<void>;
}

export type ResourceServiceStopResult = ResourceServiceStatus & ServiceStopFields;

export function requestResourceServiceStop(
  coordRootRaw: string,
  dependencies: ServiceProcessDependencies = {},
): ResourceServiceStopResult {
  const coordRoot = resolve(coordRootRaw);
  const read = () => readResourceServiceStatus(coordRoot, Date.now(), dependencies);
  return requestServiceStop(read(), read, resourcePaths(coordRoot).stop, dependencies);
}

export async function runResourceService(
  input: RunResourceServiceInput,
): Promise<ResourceServiceStatusRecord> {
  const coordRoot = resolve(input.coordRoot);
  const current = readResourceServiceStatus(coordRoot);
  if (current.liveness !== "stopped") throw startRefusal(current.record?.pid, current.liveness);
  const paths = resourcePaths(coordRoot);
  const intervalMs = normalizeInterval(input.intervalMs);
  const now = input.now ?? (() => new Date());
  const sample = input.sample ?? sampleResources;
  const wait = input.wait ?? delay;
  const lease = acquireServiceLease(paths.lease, startRefusal);
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
      lease.release();
    }
  }
  return status;
}

function startRefusal(pid: number | undefined, liveness: ServiceLiveness): Error {
  return serviceStartRefusal(
    "resource observer",
    `${resolveBinName()} supervisor stop`,
    pid,
    liveness,
  );
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
