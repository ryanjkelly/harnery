import {
  HOOK_HEALTH_EVENT,
  HOOK_HEALTH_RECEIPT_VERSION,
  type HookHealthOutcome,
} from "../hooks/health.ts";
import type { HarneryLogRecordV1 } from "../storage/jsonl.ts";
import type { SupervisorLogFeed } from "./contract.ts";

export const SUPERVISOR_HOOK_HEALTH_SCHEMA_VERSION = 1 as const;
export const SUPERVISOR_HOOK_HEALTH_RECENT_LIMIT = 50;
export const SUPERVISOR_HOOK_HEALTH_AGGREGATE_LIMIT = 40;
export const SUPERVISOR_SLOW_COMPLETED_HOOK_MS = 30_000;
export const SUPERVISOR_HIGH_COMPLETED_HOOK_RSS_BYTES = 512 * 1024 * 1024;
export const SUPERVISOR_HOOK_RETRY_CLUSTER_COUNT = 3;
export const SUPERVISOR_HOOK_RETRY_CLUSTER_WINDOW_MS = 5 * 60_000;

export interface CompletedHookHealth {
  id: string;
  observed_at: string;
  hook_name: string;
  adapter: "claude-code" | "codex" | "cursor" | "unknown";
  outcome: HookHealthOutcome;
  duration_ms: number;
  rss_start_bytes: number;
  rss_end_bytes: number;
  rss_delta_bytes: number;
  retry_worker: boolean;
  error_count: number;
  error_phases: readonly string[];
  payload_bytes: number;
  pid: number;
  owner_id?: string;
  skipped_reason?: string;
  v3_state?: string;
}

export interface HookHealthAggregate {
  key: string;
  hook_name: string;
  adapter: CompletedHookHealth["adapter"];
  invocation_count: number;
  completed_count: number;
  skipped_count: number;
  degraded_count: number;
  faulted_count: number;
  retry_count: number;
  duration_p50_ms: number;
  duration_p95_ms: number;
  duration_max_ms: number;
  rss_end_max_bytes: number;
  rss_delta_max_bytes: number;
  latest_observed_at: string;
  owner_ids: readonly string[];
}

export interface SupervisorHookHealth {
  schema_version: typeof SUPERVISOR_HOOK_HEALTH_SCHEMA_VERSION;
  captured_at: string;
  capability: {
    source_kind: "hook.terminal-log";
    state: "supported" | "partial" | "unavailable";
    reason?: string;
  };
  source_record_count: number;
  malformed_record_count: number;
  truncated: boolean;
  summary: {
    invocation_count: number;
    degraded_count: number;
    faulted_count: number;
    slow_count: number;
    high_memory_count: number;
    retry_count: number;
  };
  aggregates: readonly HookHealthAggregate[];
  recent: readonly CompletedHookHealth[];
}

export function projectHookHealth(feed: SupervisorLogFeed, now = new Date()): SupervisorHookHealth {
  const lane = feed.lanes.find((candidate) => candidate.family_id === "agent-hook-debug-log");
  if (!lane) return unavailable(now, "hook-log-family-not-visible");
  if (lane.error) return unavailable(now, "hook-log-family-unavailable");

  const parsed: CompletedHookHealth[] = [];
  let malformed = 0;
  for (const record of lane.records) {
    if (record.event !== HOOK_HEALTH_EVENT) continue;
    const receipt = parseCompletedHookHealth(record);
    if (receipt) parsed.push(receipt);
    else malformed += 1;
  }
  parsed.sort((left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at));
  const recent = parsed.slice(0, SUPERVISOR_HOOK_HEALTH_RECENT_LIMIT);
  const aggregates = aggregateHookHealth(parsed).slice(0, SUPERVISOR_HOOK_HEALTH_AGGREGATE_LIMIT);
  const retryCutoff = now.getTime() - SUPERVISOR_HOOK_RETRY_CLUSTER_WINDOW_MS;
  return {
    schema_version: SUPERVISOR_HOOK_HEALTH_SCHEMA_VERSION,
    captured_at: now.toISOString(),
    capability: {
      source_kind: "hook.terminal-log",
      state: lane.truncated || malformed > 0 ? "partial" : "supported",
      ...(lane.truncated
        ? { reason: "bounded-log-window-truncated" }
        : malformed > 0
          ? { reason: "malformed-terminal-records-ignored" }
          : {}),
    },
    source_record_count: parsed.length,
    malformed_record_count: malformed,
    truncated: lane.truncated || parsed.length > SUPERVISOR_HOOK_HEALTH_RECENT_LIMIT,
    summary: {
      invocation_count: parsed.length,
      degraded_count: parsed.filter((receipt) => receipt.outcome === "degraded").length,
      faulted_count: parsed.filter((receipt) => receipt.outcome === "faulted").length,
      slow_count: parsed.filter(
        (receipt) => receipt.duration_ms >= SUPERVISOR_SLOW_COMPLETED_HOOK_MS,
      ).length,
      high_memory_count: parsed.filter(
        (receipt) => receipt.rss_end_bytes >= SUPERVISOR_HIGH_COMPLETED_HOOK_RSS_BYTES,
      ).length,
      retry_count: parsed.filter(
        (receipt) => receipt.retry_worker && Date.parse(receipt.observed_at) >= retryCutoff,
      ).length,
    },
    aggregates,
    recent,
  };
}

export function parseCompletedHookHealth(
  record: HarneryLogRecordV1,
): CompletedHookHealth | undefined {
  if (
    record.kind !== "record" ||
    record.component_id !== "agent-hook" ||
    record.event !== HOOK_HEALTH_EVENT ||
    record.fields.receipt_version !== HOOK_HEALTH_RECEIPT_VERSION ||
    record.fields.exit_contract !== "always-zero" ||
    record.fields.exit_code !== 0
  ) {
    return undefined;
  }
  const hookName = token(record.fields.hook_name);
  const adapter = adapterValue(record.fields.adapter);
  const outcome = outcomeValue(record.fields.outcome);
  const duration = integer(record.fields.duration_ms);
  const rssStart = integer(record.fields.rss_start_bytes);
  const rssEnd = integer(record.fields.rss_end_bytes);
  const rssDelta = signedInteger(record.fields.rss_delta_bytes);
  const payloadBytes = integer(record.fields.payload_bytes);
  const pid = integer(record.fields.pid);
  const errorCount = integer(record.fields.error_count);
  const retryWorker = record.fields.retry_worker;
  const errorPhases = tokenArray(record.fields.error_phases);
  if (
    !hookName ||
    !adapter ||
    !outcome ||
    duration === undefined ||
    rssStart === undefined ||
    rssEnd === undefined ||
    rssDelta === undefined ||
    payloadBytes === undefined ||
    pid === undefined ||
    errorCount === undefined ||
    typeof retryWorker !== "boolean" ||
    !errorPhases ||
    !Number.isFinite(Date.parse(record.emitted_at))
  ) {
    return undefined;
  }
  return {
    id: `${record.writer_id}:${record.writer_seq}`,
    observed_at: record.emitted_at,
    hook_name: hookName,
    adapter,
    outcome,
    duration_ms: duration,
    rss_start_bytes: rssStart,
    rss_end_bytes: rssEnd,
    rss_delta_bytes: rssDelta,
    retry_worker: retryWorker,
    error_count: errorCount,
    error_phases: errorPhases,
    payload_bytes: payloadBytes,
    pid,
    ...optionalToken("owner_id", record.fields.owner_id),
    ...optionalToken("skipped_reason", record.fields.skipped_reason),
    ...optionalToken("v3_state", record.fields.v3_state),
  };
}

function aggregateHookHealth(receipts: readonly CompletedHookHealth[]): HookHealthAggregate[] {
  const grouped = new Map<string, CompletedHookHealth[]>();
  for (const receipt of receipts) {
    const key = `${receipt.adapter}:${receipt.hook_name}`;
    const group = grouped.get(key) ?? [];
    group.push(receipt);
    grouped.set(key, group);
  }
  return [...grouped.entries()]
    .map(([key, group]) => {
      const durations = group.map((receipt) => receipt.duration_ms).sort((a, b) => a - b);
      return {
        key,
        hook_name: group[0]!.hook_name,
        adapter: group[0]!.adapter,
        invocation_count: group.length,
        completed_count: countOutcome(group, "completed"),
        skipped_count: countOutcome(group, "skipped"),
        degraded_count: countOutcome(group, "degraded"),
        faulted_count: countOutcome(group, "faulted"),
        retry_count: group.filter((receipt) => receipt.retry_worker).length,
        duration_p50_ms: percentile(durations, 0.5),
        duration_p95_ms: percentile(durations, 0.95),
        duration_max_ms: durations.at(-1) ?? 0,
        rss_end_max_bytes: Math.max(...group.map((receipt) => receipt.rss_end_bytes)),
        rss_delta_max_bytes: Math.max(...group.map((receipt) => receipt.rss_delta_bytes)),
        latest_observed_at: group[0]!.observed_at,
        owner_ids: [...new Set(group.flatMap((receipt) => receipt.owner_id ?? []))].slice(0, 8),
      };
    })
    .sort(
      (left, right) =>
        Date.parse(right.latest_observed_at) - Date.parse(left.latest_observed_at) ||
        left.key.localeCompare(right.key),
    );
}

function countOutcome(
  receipts: readonly CompletedHookHealth[],
  outcome: HookHealthOutcome,
): number {
  return receipts.filter((receipt) => receipt.outcome === outcome).length;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

function unavailable(now: Date, reason: string): SupervisorHookHealth {
  return {
    schema_version: SUPERVISOR_HOOK_HEALTH_SCHEMA_VERSION,
    captured_at: now.toISOString(),
    capability: { source_kind: "hook.terminal-log", state: "unavailable", reason },
    source_record_count: 0,
    malformed_record_count: 0,
    truncated: false,
    summary: {
      invocation_count: 0,
      degraded_count: 0,
      faulted_count: 0,
      slow_count: 0,
      high_memory_count: 0,
      retry_count: 0,
    },
    aggregates: [],
    recent: [],
  };
}

function token(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(value)
    ? value
    : undefined;
}

function adapterValue(value: unknown): CompletedHookHealth["adapter"] | undefined {
  return value === "claude-code" || value === "codex" || value === "cursor" || value === "unknown"
    ? value
    : undefined;
}

function outcomeValue(value: unknown): HookHealthOutcome | undefined {
  return value === "completed" || value === "skipped" || value === "degraded" || value === "faulted"
    ? value
    : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function signedInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function tokenArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.length <= 8 && value.every((item) => token(item))
    ? (value as string[])
    : undefined;
}

function optionalToken<Key extends "owner_id" | "skipped_reason" | "v3_state">(
  key: Key,
  value: unknown,
): Partial<Record<Key, string>> {
  const parsed = token(value);
  return parsed ? ({ [key]: parsed } as Partial<Record<Key, string>>) : {};
}
