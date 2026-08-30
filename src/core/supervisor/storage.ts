import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  SupervisorAnomalies,
  SupervisorConsumerRecord,
  SupervisorHistory,
  SupervisorLogFeed,
  SupervisorServiceStatusRecord,
  SupervisorSnapshot,
} from "./contract.ts";

export interface SupervisorPaths {
  root: string;
  service: string;
  lease: string;
  stop: string;
  snapshot: string;
  history: string;
  anomalies: string;
  log_feed: string;
  consumers: string;
}

export function supervisorPaths(coordRootRaw: string): SupervisorPaths {
  const root = join(resolve(coordRootRaw), ".harnery", "supervisor");
  return {
    root,
    service: join(root, "service.json"),
    lease: join(root, "service.lease.json"),
    stop: join(root, "stop.json"),
    snapshot: join(root, "snapshot.json"),
    history: join(root, "history.json"),
    anomalies: join(root, "anomalies.json"),
    log_feed: join(root, "log-feed.json"),
    consumers: join(root, "consumers"),
  };
}

export function supervisorConsumerPath(coordRoot: string, id: string): string {
  return join(supervisorPaths(coordRoot).consumers, `${safeId(id)}.json`);
}

export function readSupervisorServiceRecord(
  coordRoot: string,
): SupervisorServiceStatusRecord | undefined {
  return readJson<SupervisorServiceStatusRecord>(supervisorPaths(coordRoot).service);
}

export function readSupervisorSnapshot(coordRoot: string): SupervisorSnapshot | undefined {
  return readJson<SupervisorSnapshot>(supervisorPaths(coordRoot).snapshot);
}

export function readSupervisorHistory(coordRoot: string): SupervisorHistory | undefined {
  return readJson<SupervisorHistory>(supervisorPaths(coordRoot).history);
}

export function readSupervisorAnomalies(coordRoot: string): SupervisorAnomalies | undefined {
  return readJson<SupervisorAnomalies>(supervisorPaths(coordRoot).anomalies);
}

export function readSupervisorLogFeed(coordRoot: string): SupervisorLogFeed | undefined {
  return readJson<SupervisorLogFeed>(supervisorPaths(coordRoot).log_feed);
}

export function readSupervisorConsumer(path: string): SupervisorConsumerRecord | undefined {
  return readJson<SupervisorConsumerRecord>(path);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

function safeId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("supervisor consumer id must contain a letter or number");
  return normalized.slice(0, 80);
}
