import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { coordEnv } from "../../lib/env.ts";
import { createStorageCatalog } from "../storage/catalog.ts";
import type { HarneryLogRecordV1 } from "../storage/jsonl.ts";
import { parseLogRecord } from "../storage/jsonl.ts";
import { familyLogDirectory, readSegmentManifest } from "../storage/segments.ts";
import type {
  GovernorServiceConfig,
  GovernorServiceRuntime,
  GovernorServiceStatus,
  GovernorServiceStatusRecord,
} from "./service.ts";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_LOG_RECORDS = 10_000;
const MAX_GOALS = 100;
const FOREIGN_STATUS_STALE_MS = 30_000;

export function readGovernorServiceConfig(coordRootRaw: string): GovernorServiceConfig {
  const coordRoot = resolve(coordRootRaw);
  const config = readBoundedJson<GovernorServiceConfig>(
    join(serviceDir(coordRoot), "config.json"),
    "governor service configuration",
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
    throw new Error("governor service configuration has an unsupported schema");
  }
  return config;
}

export function readGovernorServiceRuntime(
  coordRootRaw: string,
): GovernorServiceRuntime | undefined {
  const coordRoot = resolve(coordRootRaw);
  const path = join(serviceDir(coordRoot), "runtime.json");
  if (!existsSync(path)) return undefined;
  const runtime = readBoundedJson<GovernorServiceRuntime>(path, "governor service runtime");
  if (
    runtime.schema_version !== 1 ||
    !validTimestamp(runtime.config_created_at) ||
    !validTimestamp(runtime.updated_at) ||
    !runtime.goals ||
    typeof runtime.goals !== "object" ||
    Array.isArray(runtime.goals)
  ) {
    throw new Error("governor service runtime has an unsupported schema");
  }
  return runtime;
}

export function readGovernorServiceStatus(coordRootRaw: string): GovernorServiceStatus {
  const coordRoot = resolve(coordRootRaw);
  const record = readStatusRecord(coordRoot);
  let config: GovernorServiceConfig | undefined;
  let runtime: GovernorServiceRuntime | undefined;
  try {
    config = readGovernorServiceConfig(coordRoot);
  } catch {
    // Unconfigured or corrupt service state is represented without throwing.
  }
  try {
    runtime = readGovernorServiceRuntime(coordRoot);
  } catch {
    // Runtime is recoverable and must not make the dashboard unreadable.
  }
  if (!record) return { running: false, stale: false, config, runtime };
  const running = statusOwnerIsLive(record);
  return { running, stale: !running && record.state !== "stopped", record, config, runtime };
}

export function governorServiceLogPath(coordRoot: string): string {
  const root = resolve(coordRoot);
  const legacy = join(serviceDir(root), "service.log");
  if (coordEnv("SHARED_LOGS") === "0") return legacy;
  try {
    const family = createStorageCatalog({ coord_root: root }).require("governor-service-log");
    const directory = familyLogDirectory(family);
    readSegmentManifest(directory, family);
    const active = join(directory, "active.jsonl");
    return existsSync(active) || !existsSync(legacy) ? active : legacy;
  } catch {
    return legacy;
  }
}

export interface GovernorServiceLogReadOptions {
  max_bytes?: number;
  max_records?: number;
}

export interface GovernorServiceLogReadResult {
  lines: readonly string[];
  bytes_read: number;
  records_examined: number;
  truncated: boolean;
}

interface GovernorLogEntry {
  identity: string;
  line: string;
  timestamp?: string;
}

interface GovernorLogRead {
  entries: GovernorLogEntry[];
  bytes: number;
  records: number;
  truncated: boolean;
}

/** Read shared generations plus untouched legacy history under one aggregate budget. */
export function readGovernorServiceLogs(
  coordRootRaw: string,
  options: GovernorServiceLogReadOptions = {},
): GovernorServiceLogReadResult {
  const coordRoot = resolve(coordRootRaw);
  const maxBytes = options.max_bytes ?? MAX_FILE_BYTES;
  const maxRecords = options.max_records ?? MAX_LOG_RECORDS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("governor service log byte budget must be a positive integer");
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) {
    throw new Error("governor service log record budget must be a positive integer");
  }

  let bytes = 0;
  let records = 0;
  let truncated = false;
  const reads: GovernorLogEntry[][] = [];
  if (coordEnv("SHARED_LOGS") !== "0") {
    try {
      const shared = readSharedGovernorLogs(coordRoot, maxBytes, maxRecords);
      reads.push(shared.entries);
      bytes += shared.bytes;
      records += shared.records;
      truncated ||= shared.truncated;
    } catch {
      // A corrupt or racing shared generation fails closed into bounded legacy history.
      truncated = true;
    }
  }
  for (const legacy of [
    { path: join(serviceDir(coordRoot), "events.jsonl"), structured: true },
    { path: join(serviceDir(coordRoot), "service.log"), structured: false },
  ]) {
    const remainingBytes = maxBytes - bytes;
    const remainingRecords = maxRecords - records;
    if (remainingBytes <= 0 || remainingRecords <= 0) {
      if (existsSync(legacy.path)) truncated = true;
      continue;
    }
    const read = readLegacyGovernorLog(
      legacy.path,
      legacy.structured,
      remainingBytes,
      remainingRecords,
    );
    reads.push(read.entries);
    bytes += read.bytes;
    records += read.records;
    truncated ||= read.truncated;
  }

  const merged = new Map<string, GovernorLogEntry>();
  for (const entries of reads) {
    for (const entry of entries) if (!merged.has(entry.identity)) merged.set(entry.identity, entry);
  }
  const lines = [...merged.values()]
    .sort(
      (left, right) =>
        (left.timestamp ?? "").localeCompare(right.timestamp ?? "") ||
        left.identity.localeCompare(right.identity),
    )
    .map(({ line }) => line);
  return { lines, bytes_read: bytes, records_examined: records, truncated };
}

function readSharedGovernorLogs(
  coordRoot: string,
  maxBytes: number,
  maxRecords: number,
): GovernorLogRead {
  const family = createStorageCatalog({ coord_root: coordRoot }).require("governor-service-log");
  const directory = familyLogDirectory(family);
  let totalBytes = 0;
  let totalRecords = 0;
  let raced = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remainingBytes = maxBytes - totalBytes;
    const remainingRecords = maxRecords - totalRecords;
    if (remainingBytes <= 0 || remainingRecords <= 0) break;
    const manifest = readSegmentManifest(directory, family);
    const generation = manifestGeneration(manifest);
    const sources = [
      ...manifest.segments.map((segment) => ({ path: join(directory, segment.file), gzip: true })),
      { path: join(directory, "active.jsonl"), gzip: false },
    ];
    const read = readSharedSources(sources, remainingBytes, remainingRecords);
    totalBytes += read.bytes;
    totalRecords += read.records;
    const after = readSegmentManifest(directory, family);
    if (manifestGeneration(after) === generation) {
      return {
        entries: read.entries,
        bytes: totalBytes,
        records: totalRecords,
        truncated: raced || read.truncated,
      };
    }
    raced = true;
  }
  return { entries: [], bytes: totalBytes, records: totalRecords, truncated: raced };
}

function readSharedSources(
  sources: readonly { path: string; gzip: boolean }[],
  maxBytes: number,
  maxRecords: number,
): GovernorLogRead {
  const entries: GovernorLogEntry[] = [];
  let bytes = 0;
  let records = 0;
  let truncated = false;
  for (const source of sources) {
    if (!existsSync(source.path)) continue;
    if (bytes >= maxBytes || records >= maxRecords) {
      truncated = true;
      break;
    }
    const body = readBoundedSource(source.path, source.gzip, maxBytes - bytes, false);
    bytes += body.bytes;
    truncated ||= body.truncated;
    for (const line of completeLines(body.body, false)) {
      if (records >= maxRecords) {
        truncated = true;
        break;
      }
      records += 1;
      try {
        entries.push(normalizeSharedGovernorRecord(parseLogRecord(line)));
      } catch {
        // Malformed rows count against the source budget but cannot poison the readable tail.
      }
    }
  }
  return { entries, bytes, records, truncated };
}

function readLegacyGovernorLog(
  path: string,
  structured: boolean,
  maxBytes: number,
  maxRecords: number,
): GovernorLogRead {
  if (!existsSync(path)) return { entries: [], bytes: 0, records: 0, truncated: false };
  const source = readBoundedSource(path, false, maxBytes, true);
  const entries: GovernorLogEntry[] = [];
  let records = 0;
  let truncated = source.truncated;
  for (const line of completeLines(source.body, source.truncated)) {
    if (records >= maxRecords) {
      truncated = true;
      break;
    }
    records += 1;
    if (!structured) {
      entries.push({ identity: `text:${line}`, line });
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) entries.push(normalizeLegacyGovernorRecord(parsed));
    } catch {
      // Malformed legacy lines stay excluded while consuming their source budget.
    }
  }
  return { entries, bytes: source.bytes, records, truncated };
}

function readBoundedSource(
  path: string,
  gzip: boolean,
  maxBytes: number,
  tail: boolean,
): { body: string; bytes: number; truncated: boolean } {
  if (maxBytes <= 0) return { body: "", bytes: 0, truncated: true };
  const size = statSync(path).size;
  if (size <= 0) return { body: "", bytes: 0, truncated: false };
  if (gzip) {
    if (size > maxBytes) return { body: "", bytes: maxBytes, truncated: true };
    try {
      const output = gunzipSync(readFileSync(path), { maxOutputLength: maxBytes });
      return {
        body: output.toString("utf8"),
        bytes: Math.max(size, output.byteLength),
        truncated: false,
      };
    } catch {
      return { body: "", bytes: maxBytes, truncated: true };
    }
  }
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.allocUnsafe(length);
  const descriptor = openSync(path, "r");
  try {
    const bytes = readSync(descriptor, buffer, 0, length, tail ? size - length : 0);
    return {
      body: buffer.subarray(0, bytes).toString("utf8"),
      bytes,
      truncated: size > bytes,
    };
  } finally {
    closeSync(descriptor);
  }
}

function completeLines(body: string, truncatedPrefix: boolean): string[] {
  const start = truncatedPrefix ? body.indexOf("\n") + 1 : 0;
  const end = body.lastIndexOf("\n");
  if (start < 0 || end < start) return [];
  return body.slice(start, end).split("\n").filter(Boolean);
}

function normalizeSharedGovernorRecord(record: HarneryLogRecordV1): GovernorLogEntry {
  if (record.family_id !== "governor-service-log") throw new Error("wrong governor log family");
  const payload = {
    ...Object.fromEntries(
      Object.entries(record.fields).map(([key, value]) => [key, parseJsonField(value)]),
    ),
    ts: record.emitted_at,
    event: record.event,
  };
  return normalizedGovernorEntry(payload);
}

function normalizeLegacyGovernorRecord(record: Record<string, unknown>): GovernorLogEntry {
  const { schema_version: _schemaVersion, ...payload } = record;
  return normalizedGovernorEntry(payload);
}

function normalizedGovernorEntry(payload: Record<string, unknown>): GovernorLogEntry {
  const identity = stableJson(payload);
  return {
    identity,
    line: JSON.stringify(payload),
    ...(typeof payload.ts === "string" ? { timestamp: payload.ts } : {}),
  };
}

function parseJsonField(value: unknown): unknown {
  if (typeof value !== "string" || (!value.startsWith("[") && !value.startsWith("{"))) {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function manifestGeneration(manifest: {
  next_sequence: number;
  segments: readonly { file: string; sha256: string }[];
}): string {
  return JSON.stringify([
    manifest.next_sequence,
    manifest.segments.map((segment) => [segment.file, segment.sha256]),
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStatusRecord(coordRoot: string): GovernorServiceStatusRecord | undefined {
  const path = join(serviceDir(coordRoot), "status.json");
  if (!existsSync(path)) return undefined;
  try {
    const value = readBoundedJson<GovernorServiceStatusRecord>(path, "governor service status");
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

function statusOwnerIsLive(record: GovernorServiceStatusRecord): boolean {
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
  return join(coordRoot, ".harnery", "governor-service");
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}
