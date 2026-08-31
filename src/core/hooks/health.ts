import type { Adapter } from "../adapter.ts";
import { processLogger } from "../storage/logger.ts";

export const HOOK_HEALTH_EVENT = "agent_hook.completed" as const;
export const HOOK_HEALTH_RECEIPT_VERSION = 1 as const;
export const HOOK_HEALTH_ERROR_PHASE_LIMIT = 8;

export type HookHealthOutcome = "completed" | "skipped" | "degraded" | "faulted";

export interface HookHealthState {
  readonly started_at_ms: number;
  readonly started_rss_bytes: number;
  readonly event_name: string | null;
  readonly adapter: Adapter | null;
  readonly payload_bytes: number;
  coord_root: string | null;
  owner_id?: string;
  skipped_reason?: string;
  v3_state?: string;
  error_phases: string[];
}

export interface HookHealthReceipt {
  receipt_version: typeof HOOK_HEALTH_RECEIPT_VERSION;
  hook_name: string;
  adapter: Adapter | "unknown";
  outcome: HookHealthOutcome;
  exit_contract: "always-zero";
  exit_code: 0;
  duration_ms: number;
  payload_bytes: number;
  pid: number;
  rss_start_bytes: number;
  rss_end_bytes: number;
  rss_delta_bytes: number;
  retry_worker: boolean;
  error_count: number;
  error_phases: readonly string[];
  owner_id?: string;
  skipped_reason?: string;
  v3_state?: string;
}

export function beginHookHealth(input: {
  started_at_ms: number;
  started_rss_bytes: number;
  event_name: string | null;
  adapter: Adapter | null;
  payload_bytes: number;
}): HookHealthState {
  return {
    ...input,
    coord_root: null,
    error_phases: [],
  };
}

export function observeHookDebug(
  state: HookHealthState | undefined,
  entry: Readonly<Record<string, unknown>>,
): void {
  if (!state) return;
  const skipped = safeToken(entry.skipped);
  if (skipped) state.skipped_reason = skipped;
  const v3State = safeToken(entry.event_v3_state);
  if (v3State) state.v3_state = v3State;
}

export function observeHookError(state: HookHealthState | undefined, phase: unknown): void {
  if (!state || state.error_phases.length >= HOOK_HEALTH_ERROR_PHASE_LIMIT) return;
  state.error_phases.push(safeToken(phase) ?? "unknown");
}

export function finalizeHookHealth(
  state: HookHealthState,
  input: {
    finished_at_ms: number;
    finished_rss_bytes: number;
    pid: number;
    faulted?: boolean;
  },
): HookHealthReceipt {
  const duration = Math.max(0, Math.floor(input.finished_at_ms - state.started_at_ms));
  const rssStart = boundedInteger(state.started_rss_bytes);
  const rssEnd = boundedInteger(input.finished_rss_bytes);
  const hookName = safeToken(state.event_name) ?? "unknown";
  return {
    receipt_version: HOOK_HEALTH_RECEIPT_VERSION,
    hook_name: hookName,
    adapter: state.adapter ?? "unknown",
    outcome: input.faulted
      ? "faulted"
      : state.error_phases.length > 0
        ? "degraded"
        : state.skipped_reason
          ? "skipped"
          : "completed",
    exit_contract: "always-zero",
    exit_code: 0,
    duration_ms: duration,
    payload_bytes: boundedInteger(state.payload_bytes),
    pid: boundedInteger(input.pid),
    rss_start_bytes: rssStart,
    rss_end_bytes: rssEnd,
    rss_delta_bytes: rssEnd - rssStart,
    retry_worker: hookName === "runtime-context-retry",
    error_count: state.error_phases.length,
    error_phases: [...state.error_phases],
    ...(state.owner_id ? { owner_id: state.owner_id } : {}),
    ...(state.skipped_reason ? { skipped_reason: state.skipped_reason } : {}),
    ...(state.v3_state ? { v3_state: state.v3_state } : {}),
  };
}

export function writeHookHealthCompletion(
  state: HookHealthState | undefined,
  input: {
    finished_at_ms: number;
    finished_rss_bytes: number;
    pid: number;
    faulted?: boolean;
  },
): HookHealthReceipt | undefined {
  if (!state?.coord_root) return undefined;
  const receipt = finalizeHookHealth(state, input);
  try {
    processLogger(state.coord_root, "agent-hook").info(HOOK_HEALTH_EVENT, { ...receipt });
  } catch {
    // Hook health is observer-only. Logging can never change adapter behavior.
  }
  return receipt;
}

function safeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .slice(0, 128)
    .replace(/[^a-zA-Z0-9._:/+-]+/g, "-");
  return /^[a-zA-Z0-9]/.test(normalized) ? normalized : undefined;
}

function boundedInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)));
}
