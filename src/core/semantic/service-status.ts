import { existsSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { readSemanticManifest, semanticPaths } from "./storage.ts";

export const SEMANTIC_SERVICE_STATUS_SCHEMA_VERSION = 1 as const;
const FOREIGN_STATUS_STALE_MS = 2 * 60_000;
const MAX_FILE_BYTES = 512 * 1024;

export type SemanticServiceState = "starting" | "running" | "stopping" | "stopped";
export type SemanticServiceErrorCode = "ledger_unavailable" | "semantic_pass_failed";

export interface SemanticServiceStatusRecord {
  schema_version: typeof SEMANTIC_SERVICE_STATUS_SCHEMA_VERSION;
  pid: number;
  host: string;
  nonce: string;
  state: SemanticServiceState;
  started_at: string;
  heartbeat_at: string;
  calls_per_hour?: number;
  sweep_count: number;
  pass_count: number;
  model_calls: number;
  cache_hits: number;
  last_sweep_at?: string;
  last_pass_at?: string;
  last_error_code?: SemanticServiceErrorCode;
  stopped_at?: string;
}

export interface SemanticServiceStatus {
  running: boolean;
  stale: boolean;
  record?: SemanticServiceStatusRecord;
  newest_successful_pass?: string;
  pending_count: number;
}

/** Read-only service health. This module cannot spawn, signal, or write. */
export function readSemanticServiceStatus(coordRootRaw: string): SemanticServiceStatus {
  const coordRoot = resolve(coordRootRaw);
  const record = readStatusRecord(coordRoot);
  const manifest = safeManifest(coordRoot);
  if (!record) {
    return {
      running: false,
      stale: false,
      newest_successful_pass: manifest?.newest_successful_pass,
      pending_count: manifest?.pending.length ?? 0,
    };
  }
  const running = statusOwnerIsLive(record);
  return {
    running,
    stale: !running && record.state !== "stopped",
    record,
    newest_successful_pass: manifest?.newest_successful_pass,
    pending_count: manifest?.pending.length ?? 0,
  };
}

function safeManifest(coordRoot: string) {
  try {
    return readSemanticManifest(coordRoot);
  } catch {
    return undefined;
  }
}

function readStatusRecord(coordRoot: string): SemanticServiceStatusRecord | undefined {
  const path = semanticPaths(coordRoot).service;
  if (!existsSync(path)) return undefined;
  try {
    const value = readBoundedJson<SemanticServiceStatusRecord>(path, "semantic service status");
    if (
      value.schema_version !== SEMANTIC_SERVICE_STATUS_SCHEMA_VERSION ||
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

function statusOwnerIsLive(record: SemanticServiceStatusRecord): boolean {
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

function readBoundedJson<T>(path: string, label: string): T {
  const size = statSync(path).size;
  if (size <= 0 || size > MAX_FILE_BYTES) throw new Error(`${label} has invalid size ${size}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
