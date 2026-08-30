import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { checkPidToken, processStartToken } from "../agents/state/proc-start.ts";
import { writePrivateJsonAtomic } from "../storage/atomic-json.ts";
import {
  type ObservedServiceHealth,
  SUPERVISOR_CONSUMER_SCHEMA_VERSION,
  type SupervisorConsumerRecord,
  type SupervisorServiceStatusRecord,
} from "./contract.ts";
import { readSupervisorConsumer, supervisorConsumerPath, supervisorPaths } from "./storage.ts";

export function registerSupervisorConsumer(
  coordRoot: string,
  input: { id: string; pid?: number },
): SupervisorConsumerRecord {
  const pid = input.pid ?? process.pid;
  const startToken = processStartToken(pid);
  const record: SupervisorConsumerRecord = {
    schema_version: SUPERVISOR_CONSUMER_SCHEMA_VERSION,
    id: input.id,
    pid,
    ...(startToken ? { start_token: startToken } : {}),
    registered_at: new Date().toISOString(),
  };
  writePrivateJsonAtomic(supervisorConsumerPath(coordRoot, input.id), record);
  return record;
}

export function unregisterSupervisorConsumer(coordRoot: string, id: string): void {
  rmSync(supervisorConsumerPath(coordRoot, id), { force: true });
}

export function collectServiceHealth(
  coordRoot: string,
  supervisor: SupervisorServiceStatusRecord,
): { services: ObservedServiceHealth[]; consumers: SupervisorConsumerRecord[] } {
  const consumers = readLiveConsumers(coordRoot);
  const semantic = readDetachedService(
    join(coordRoot, ".harnery", "semantic", "v2", "service.json"),
    "semantic-reader",
  );
  const governor = readDetachedService(
    join(coordRoot, ".harnery", "governor-service", "service.json"),
    "governor",
  );
  const relay = readPresenceRelay(join(coordRoot, ".harnery", "presence", "relay-daemon.json"));
  const dashboard = consumers.find((consumer) => consumer.id === "dashboard");
  const services: ObservedServiceHealth[] = [
    {
      id: "supervisor",
      state:
        supervisor.state === "running"
          ? "running"
          : supervisor.state === "error"
            ? "stale"
            : "stopped",
      pid: supervisor.pid,
      started_at: supervisor.started_at,
      heartbeat_at: supervisor.heartbeat_at,
    },
    semantic,
    governor,
    relay,
    dashboard
      ? {
          id: "dashboard",
          state: "running",
          pid: dashboard.pid,
          started_at: dashboard.registered_at,
        }
      : { id: "dashboard", state: "stopped" },
  ];
  return { services, consumers };
}

function readLiveConsumers(coordRoot: string): SupervisorConsumerRecord[] {
  const directory = supervisorPaths(coordRoot).consumers;
  if (!existsSync(directory)) return [];
  const live: SupervisorConsumerRecord[] = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    const path = `${directory}/${entry}`;
    const record = readSupervisorConsumer(path);
    if (!record || !consumerAlive(record)) {
      rmSync(path, { force: true });
      continue;
    }
    live.push(record);
  }
  return live.sort((left, right) => left.id.localeCompare(right.id));
}

function consumerAlive(record: SupervisorConsumerRecord): boolean {
  if (
    record.schema_version !== SUPERVISOR_CONSUMER_SCHEMA_VERSION ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.id !== "string"
  ) {
    return false;
  }
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return checkPidToken(record.pid, record.start_token) !== "mismatch";
}

interface DetachedServiceRecord {
  pid: number;
  host?: string;
  state?: string;
  started_at?: string;
  heartbeat_at?: string;
}

function readDetachedService(
  path: string,
  id: "semantic-reader" | "governor",
): ObservedServiceHealth {
  const record = readBoundedJson<DetachedServiceRecord>(path);
  if (!record || !Number.isSafeInteger(record.pid) || record.pid < 1) {
    return { id, state: "stopped" };
  }
  if (record.state === "stopped") {
    return projection(id, "stopped", record);
  }
  if (record.host && record.host !== hostname()) {
    const age = record.heartbeat_at
      ? Date.now() - Date.parse(record.heartbeat_at)
      : Number.POSITIVE_INFINITY;
    return projection(id, Number.isFinite(age) && age < 120_000 ? "running" : "stale", record);
  }
  return projection(id, pidAlive(record.pid) ? "running" : "stale", record);
}

function readPresenceRelay(path: string): ObservedServiceHealth {
  const record = readBoundedJson<{ pid: number; started_at?: string }>(path);
  if (!record || !Number.isSafeInteger(record.pid) || record.pid < 1) {
    return { id: "presence-relay", state: "stopped" };
  }
  return {
    id: "presence-relay",
    state: pidAlive(record.pid) ? "running" : "stale",
    pid: record.pid,
    ...(record.started_at ? { started_at: record.started_at } : {}),
  };
}

function projection(
  id: "semantic-reader" | "governor",
  state: ObservedServiceHealth["state"],
  record: DetachedServiceRecord,
): ObservedServiceHealth {
  return {
    id,
    state,
    pid: record.pid,
    ...(record.started_at ? { started_at: record.started_at } : {}),
    ...(record.heartbeat_at ? { heartbeat_at: record.heartbeat_at } : {}),
  };
}

function readBoundedJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const size = statSync(path).size;
    if (size < 2 || size > 512 * 1_024) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
