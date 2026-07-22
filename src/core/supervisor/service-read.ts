import { existsSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type {
  SupervisorServiceConfig,
  SupervisorServiceRuntime,
  SupervisorServiceStatus,
  SupervisorServiceStatusRecord,
} from "./service.ts";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_GOALS = 100;
const FOREIGN_STATUS_STALE_MS = 30_000;

export function readSupervisorServiceConfig(coordRootRaw: string): SupervisorServiceConfig {
  const coordRoot = resolve(coordRootRaw);
  const config = readBoundedJson<SupervisorServiceConfig>(
    join(serviceDir(coordRoot), "config.json"),
    "supervisor service configuration",
  );
  if (
    config.schema_version !== 1 ||
    !validTimestamp(config.created_at) ||
    !Array.isArray(config.goal_ids) ||
    config.goal_ids.length < 1 ||
    config.goal_ids.length > MAX_GOALS ||
    config.goal_ids.some((goalId) => typeof goalId !== "string" || !goalId.trim()) ||
    !positive(config.wake_interval_ms) ||
    !positive(config.heartbeat_interval_ms) ||
    !positive(config.error_backoff_base_ms) ||
    !positive(config.error_backoff_max_ms) ||
    config.error_backoff_max_ms < config.error_backoff_base_ms ||
    !config.engine ||
    typeof config.engine !== "object" ||
    typeof config.engine.subscription_only !== "boolean" ||
    typeof config.engine.allow_api_billing !== "boolean"
  ) {
    throw new Error("supervisor service configuration has an unsupported schema");
  }
  return config;
}

export function readSupervisorServiceRuntime(
  coordRootRaw: string,
): SupervisorServiceRuntime | undefined {
  const coordRoot = resolve(coordRootRaw);
  const path = join(serviceDir(coordRoot), "runtime.json");
  if (!existsSync(path)) return undefined;
  const runtime = readBoundedJson<SupervisorServiceRuntime>(path, "supervisor service runtime");
  if (
    runtime.schema_version !== 1 ||
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
    // Unconfigured or corrupt service state is represented without throwing.
  }
  try {
    runtime = readSupervisorServiceRuntime(coordRoot);
  } catch {
    // Runtime is recoverable and must not make the dashboard unreadable.
  }
  if (!record) return { running: false, stale: false, config, runtime };
  const running = statusOwnerIsLive(record);
  return { running, stale: !running && record.state !== "stopped", record, config, runtime };
}

export function supervisorServiceLogPath(coordRoot: string): string {
  return join(serviceDir(resolve(coordRoot)), "service.log");
}

function readStatusRecord(coordRoot: string): SupervisorServiceStatusRecord | undefined {
  const path = join(serviceDir(coordRoot), "status.json");
  if (!existsSync(path)) return undefined;
  try {
    const value = readBoundedJson<SupervisorServiceStatusRecord>(path, "supervisor service status");
    if (
      value.schema_version !== 1 ||
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
  if (record.host === hostname()) {
    try {
      process.kill(record.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
  const age = Date.now() - Date.parse(record.heartbeat_at);
  return Number.isFinite(age) && age < FOREIGN_STATUS_STALE_MS;
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

function serviceDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "supervisor-service");
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}
