import { existsSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

import type { SemanticHarness } from "./contract.ts";
import { SEMANTIC_READER_ROUTES } from "./routes.ts";
import {
  activeSemanticCallHistory,
  SEMANTIC_HARD_CALLS_PER_HOUR,
  semanticRateCap,
} from "./scheduler.ts";
import { readSemanticManifest, type SemanticReaderResolution, semanticPaths } from "./storage.ts";
import {
  aggregateSemanticUsage,
  emptySemanticUsageAggregate,
  type SemanticUsageAggregate,
} from "./usage.ts";

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
  process_usage?: SemanticUsageAggregate;
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
  rolling_calls?: {
    used: number;
    limit: number;
    available: number;
    eligible_after?: string;
  };
  routes?: Array<{
    harness: keyof typeof SEMANTIC_READER_ROUTES;
    configured_model: string;
    invocation_model_id: string;
    resolved_model_id?: string;
    model_attestation?: "verified" | "requested-only";
    available?: boolean;
    reason_code?: string;
  }>;
  rolling_usage?: SemanticUsageAggregate;
  process_usage?: SemanticUsageAggregate;
}

/** Read-only service health. This module cannot spawn, signal, or write. */
export function readSemanticServiceStatus(coordRootRaw: string): SemanticServiceStatus {
  const coordRoot = resolve(coordRootRaw);
  const record = readStatusRecord(coordRoot);
  const manifest = safeManifest(coordRoot);
  const now = Date.now();
  const history = activeSemanticCallHistory(manifest?.call_history ?? [], now);
  const limit = Math.min(
    SEMANTIC_HARD_CALLS_PER_HOUR,
    Math.max(1, Math.floor(record?.calls_per_hour ?? SEMANTIC_HARD_CALLS_PER_HOUR)),
  );
  const cap = semanticRateCap(history, now, limit);
  const rollingUsage = aggregateSemanticUsage(
    history.map((call) => ({
      source_harness: call.source_harness,
      configured_model: call.configured_model,
      resolved_model_id: call.resolved_model_id,
      model_attestation: call.model_attestation,
      action: call.outcome,
      model_call: true,
      usage: call.usage,
      invalid_reason_codes: call.invalid_reason_codes,
    })),
  );
  const processUsage = record?.process_usage ?? legacyProcessUsage(record?.model_calls ?? 0);
  const shared = {
    ...(manifest?.newest_successful_pass
      ? { newest_successful_pass: manifest.newest_successful_pass }
      : {}),
    pending_count: manifest?.pending.length ?? 0,
    rolling_calls: {
      used: history.length,
      limit,
      available: cap.available,
      ...(cap.eligible_after ? { eligible_after: cap.eligible_after } : {}),
    },
    routes: semanticStatusRoutes(manifest?.adapter_resolutions),
    rolling_usage: rollingUsage,
    process_usage: processUsage,
  };
  if (!record) {
    return {
      running: false,
      stale: false,
      ...shared,
    };
  }
  const running = statusOwnerIsLive(record);
  return {
    running,
    stale: !running && record.state !== "stopped",
    record,
    ...shared,
  };
}

function semanticStatusRoutes(
  resolutions: Partial<Record<SemanticHarness, SemanticReaderResolution>> | undefined,
): NonNullable<SemanticServiceStatus["routes"]> {
  return (Object.keys(SEMANTIC_READER_ROUTES) as Array<keyof typeof SEMANTIC_READER_ROUTES>).map(
    (harness) => {
      const route = SEMANTIC_READER_ROUTES[harness];
      const resolution = resolutions?.[harness];
      return {
        harness,
        configured_model: route.configured_model,
        invocation_model_id: route.invocation_model_id,
        ...(resolution?.resolved_model_id
          ? { resolved_model_id: resolution.resolved_model_id }
          : {}),
        ...(resolution?.model_attestation
          ? { model_attestation: resolution.model_attestation }
          : {}),
        ...(resolution ? { available: resolution.available } : {}),
        ...(resolution?.reason_code ? { reason_code: resolution.reason_code } : {}),
      };
    },
  );
}

function legacyProcessUsage(modelCalls: number): SemanticUsageAggregate {
  const aggregate = emptySemanticUsageAggregate();
  aggregate.call_count = modelCalls;
  aggregate.unreported_calls = modelCalls;
  return aggregate;
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
