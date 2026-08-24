import type { Adapter } from "../../adapter.ts";
import {
  type AdapterSignalV3,
  adapterSignalSupportV3,
  type CapabilitySupportV3,
} from "./capabilities.ts";
import type { TurnHarnessV3, TurnInferenceV3, TurnUsageV3 } from "./contract.ts";

export type TelemetryObservationV3<T> =
  | {
      state: "observed";
      value: T;
      attestation: "native" | "derived" | "inferred";
      confidence: "exact" | "high" | "medium" | "low";
    }
  | { state: "unsupported"; capability: string }
  | { state: "expected_but_missing"; capability: string; reason: string };

interface ContextMeasurementClockV3 {
  measured_at: string;
  method: string;
}

export type ContextMeasurementV3 = ContextMeasurementClockV3 &
  (
    | {
        used_tokens: number;
        limit_tokens: number;
        remaining_tokens?: number;
      }
    | {
        used_percent: number;
        remaining_percent?: number;
      }
  );

export interface TurnTelemetryV3 {
  usage: TelemetryObservationV3<TurnUsageV3>;
  inference: TelemetryObservationV3<TurnInferenceV3>;
  context: TelemetryObservationV3<ContextMeasurementV3>;
  /** Private producer metadata; the context event persists only its safe fields. */
  context_provenance?: ContextTelemetryProvenanceV3;
}

export interface ContextTelemetryProvenanceV3 {
  source_event: string;
  source_witness?: string;
  runtime_version?: string;
  attestation: "native" | "derived" | "inferred";
  confidence: "exact" | "high" | "medium" | "low";
}

export type TurnTelemetryCapabilitySupportV3 = Partial<
  Pick<
    Record<AdapterSignalV3, CapabilitySupportV3>,
    "model_usage" | "inference_timing" | "context_usage"
  >
>;

export interface HarnessTimingAccumulatorV3 {
  hook_time_ms: number;
  hook_count: number;
  slowest_hook?: string;
  slowest_hook_ms: number;
}

/** Extract only telemetry explicitly reported by a hook/status payload. */
export function extractTurnTelemetryV3(
  adapter: Adapter,
  payload: Record<string, unknown>,
  observedAt = new Date().toISOString(),
  support: TurnTelemetryCapabilitySupportV3 = {},
): TurnTelemetryV3 {
  const context =
    record(payload.context_window) ??
    record(payload.model_context_window) ??
    record(payload.context_usage);
  const usage =
    record(payload.usage) ??
    record(payload.token_usage) ??
    record(context?.current_usage) ??
    undefined;
  const input = number(usage?.input_tokens);
  const output = number(usage?.output_tokens);
  const cacheRead = number(usage?.cache_read_tokens) ?? number(usage?.cache_read_input_tokens);
  const cacheWrite =
    number(usage?.cache_write_tokens) ?? number(usage?.cache_creation_input_tokens);
  const usageObservation =
    input !== undefined && output !== undefined
      ? ({
          state: "observed",
          value: {
            input_tokens: input,
            output_tokens: output,
            ...(cacheRead !== undefined ? { cache_read_tokens: cacheRead } : {}),
            ...(cacheWrite !== undefined ? { cache_write_tokens: cacheWrite } : {}),
            method: `${adapter.replaceAll("-", "_")}_hook`,
          },
          attestation: "native",
          confidence: "exact",
        } as const)
      : missing(adapter, "model_usage", support.model_usage);

  const inferenceMs =
    number(payload.api_time_ms) ??
    number(payload.inference_time_ms) ??
    number(record(payload.timing)?.api_time_ms) ??
    number(usage?.api_time_ms);
  const requestCount =
    number(payload.request_count) ?? number(record(payload.timing)?.request_count) ?? 1;
  const inferenceObservation =
    inferenceMs !== undefined
      ? ({
          state: "observed",
          value: { api_time_ms: inferenceMs, request_count: requestCount },
          attestation: "native",
          confidence: "exact",
        } as const)
      : missing(adapter, "inference_timing", support.inference_timing);

  const usedTokens =
    number(context?.used_tokens) ??
    number(context?.context_tokens) ??
    number(context?.input_tokens) ??
    number(context?.total_tokens) ??
    number(payload.used_tokens) ??
    number(payload.context_tokens) ??
    number(payload.total_input_tokens) ??
    number(usage?.total_tokens) ??
    number(usage?.prompt_tokens) ??
    (usage
      ? sumDefined([
          number(usage.input_tokens),
          number(usage.cache_read_input_tokens),
          number(usage.cache_creation_input_tokens),
        ])
      : undefined);
  const limitTokens =
    number(context?.context_window_size) ??
    number(context?.window_tokens) ??
    number(context?.context_window_tokens) ??
    number(context?.max_tokens) ??
    number(payload.context_window_size) ??
    number(payload.context_window_tokens) ??
    (typeof payload.context_window === "number" ? number(payload.context_window) : undefined);
  const usedPercent =
    finiteNumber(context?.context_usage_percent) ??
    finiteNumber(context?.used_percent) ??
    finiteNumber(context?.used_percentage) ??
    finiteNumber(payload.context_usage_percent) ??
    finiteNumber(payload.used_percent);
  const contextMeasurement = contextObservation(
    adapter,
    usedTokens,
    limitTokens,
    usedPercent,
    observedAt,
    support.context_usage,
  );

  return { usage: usageObservation, inference: inferenceObservation, context: contextMeasurement };
}

function contextObservation(
  adapter: Adapter,
  usedTokens: number | undefined,
  limitTokens: number | undefined,
  usedPercent: number | undefined,
  observedAt: string,
  override: CapabilitySupportV3 | undefined,
): TelemetryObservationV3<ContextMeasurementV3> {
  if (usedTokens !== undefined && limitTokens !== undefined && limitTokens > 0) {
    return {
      state: "observed",
      value: {
        used_tokens: usedTokens,
        limit_tokens: limitTokens,
        remaining_tokens: Math.max(0, limitTokens - usedTokens),
        measured_at: observedAt,
        method: `${adapter.replaceAll("-", "_")}_hook`,
      },
      attestation: "native",
      confidence: "exact",
    };
  }

  if (usedPercent !== undefined && usedPercent >= 0 && usedPercent <= 100) {
    return {
      state: "observed",
      value: {
        used_percent: usedPercent,
        remaining_percent: Math.max(0, 100 - usedPercent),
        measured_at: observedAt,
        method: `${adapter.replaceAll("-", "_")}_hook`,
      },
      attestation: "native",
      confidence: "exact",
    };
  }

  if (usedPercent !== undefined) {
    return {
      state: "expected_but_missing",
      capability: "context_usage",
      reason: "context_usage_percent_invalid",
    };
  }

  if (usedTokens !== undefined || limitTokens !== undefined) {
    return {
      state: "expected_but_missing",
      capability: "context_usage",
      reason:
        usedTokens === undefined
          ? "context_used_tokens_not_reported"
          : limitTokens === undefined
            ? "context_limit_tokens_not_reported"
            : "context_limit_tokens_invalid",
    };
  }

  return missing(adapter, "context_usage", override);
}

export function emptyHarnessTimingV3(): HarnessTimingAccumulatorV3 {
  return { hook_time_ms: 0, hook_count: 0, slowest_hook_ms: 0 };
}

export function recordHarnessTimingV3(
  accumulator: HarnessTimingAccumulatorV3,
  hook: string,
  durationMs: number,
): HarnessTimingAccumulatorV3 {
  const duration = safeInteger(durationMs);
  if (duration === undefined) return accumulator;
  const name = safeToken(hook, "unknown_hook");
  return {
    hook_time_ms: accumulator.hook_time_ms + duration,
    hook_count: accumulator.hook_count + 1,
    slowest_hook: duration >= accumulator.slowest_hook_ms ? name : accumulator.slowest_hook,
    slowest_hook_ms: Math.max(duration, accumulator.slowest_hook_ms),
  };
}

export function harnessObservationV3(
  accumulator: HarnessTimingAccumulatorV3,
): TelemetryObservationV3<TurnHarnessV3> {
  return accumulator.hook_count > 0
    ? {
        state: "observed",
        value: {
          hook_time_ms: accumulator.hook_time_ms,
          hook_count: accumulator.hook_count,
          ...(accumulator.slowest_hook
            ? {
                slowest_hook: accumulator.slowest_hook,
                slowest_hook_ms: accumulator.slowest_hook_ms,
              }
            : {}),
        },
        attestation: "derived",
        confidence: "high",
      }
    : {
        state: "expected_but_missing",
        capability: "harness_timing",
        reason: "no_hook_timing_samples",
      };
}

function missing(
  adapter: Adapter,
  signal: "model_usage" | "inference_timing" | "context_usage",
  override: CapabilitySupportV3 | undefined,
) {
  const declared = override ?? adapterSignalSupportV3(adapter, signal);
  if (declared === "unsupported") return { state: "unsupported", capability: signal } as const;
  return {
    state: "expected_but_missing",
    capability: signal,
    reason:
      signal === "model_usage"
        ? "not_reported"
        : declared === "conditional"
          ? "conditional_signal_not_reported"
          : "promised_signal_not_reported",
  } as const;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? safeInteger(value) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeInteger(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  return values.some((value) => value !== undefined)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
    : undefined;
}

function safeToken(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFC")
    .replace(/[^a-zA-Z0-9._:/+-]/g, "_")
    .slice(0, 128);
  return /^[a-zA-Z0-9]/.test(normalized) ? normalized : fallback;
}
