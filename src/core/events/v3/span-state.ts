import { readFileSync } from "node:fs";
import type { SpanSummaryV3 } from "./contract.ts";

export interface SpanClockV3 {
  observed_at: string;
  monotonic_ns?: string;
}

export interface OpenSpanStateV3 {
  span_id: `span_${string}`;
  parent_span_id?: `span_${string}`;
  opened_at: string;
  boot_id: `boot_${string}`;
  opened_monotonic_ns?: string;
  open_event_id?: `evt_${string}`;
}

export interface OpenSpanV3Input {
  span_id: `span_${string}`;
  parent_span_id?: `span_${string}`;
  boot_id: `boot_${string}`;
  clock: SpanClockV3;
  open_event_id?: `evt_${string}`;
}

export interface CloseSpanV3Input {
  boot_id: `boot_${string}`;
  clock: SpanClockV3;
  recovery_reason?: string;
}

/** Capture a cross-process, boot-anchored monotonic reading where the host exposes one. */
export function captureSpanClockV3(
  options: { now?: Date; platform?: NodeJS.Platform; linux_uptime?: string } = {},
): SpanClockV3 {
  const observed_at = (options.now ?? new Date()).toISOString();
  if ((options.platform ?? process.platform) !== "linux") return { observed_at };
  try {
    const uptime = options.linux_uptime ?? readFileSync("/proc/uptime", "utf8");
    return { observed_at, monotonic_ns: linuxUptimeNanosecondsV3(uptime) };
  } catch {
    return { observed_at };
  }
}

/** Convert Linux's boot-relative `/proc/uptime` value without floating-point drift. */
export function linuxUptimeNanosecondsV3(value: string): string {
  const token = value.trim().split(/\s+/, 1)[0] ?? "";
  if (!/^\d+(?:\.\d+)?$/.test(token)) throw new Error("invalid Linux uptime value");
  const [whole = "0", fraction = ""] = token.split(".");
  const nanos = `${fraction}000000000`.slice(0, 9);
  return (BigInt(whole) * 1_000_000_000n + BigInt(nanos)).toString();
}

export function openSpanStateV3(input: OpenSpanV3Input): OpenSpanStateV3 {
  return {
    span_id: input.span_id,
    ...(input.parent_span_id ? { parent_span_id: input.parent_span_id } : {}),
    opened_at: input.clock.observed_at,
    boot_id: input.boot_id,
    ...(input.clock.monotonic_ns ? { opened_monotonic_ns: input.clock.monotonic_ns } : {}),
    ...(input.open_event_id ? { open_event_id: input.open_event_id } : {}),
  };
}

/**
 * Materialize a self-contained terminal summary.
 *
 * Same-boot monotonic readings are exact. Cross-boot or unsupported hosts
 * fall back to a high-confidence wall delta. Regressions and recovery remain
 * explicit missing/unknown observations; they are never coerced to zero.
 */
export function closeSpanStateV3(span: OpenSpanStateV3, input: CloseSpanV3Input): SpanSummaryV3 {
  const duration_ms = spanDurationV3(span, input);
  return {
    span_id: span.span_id,
    ...(span.parent_span_id ? { parent_span_id: span.parent_span_id } : {}),
    opened_at: span.opened_at,
    duration_ms,
    ...(span.open_event_id ? { open_event_id: span.open_event_id } : {}),
  };
}

function spanDurationV3(
  span: OpenSpanStateV3,
  input: CloseSpanV3Input,
): SpanSummaryV3["duration_ms"] {
  if (input.recovery_reason) return { state: "unknown", reason: input.recovery_reason };
  const openedAt = Date.parse(span.opened_at);
  const closedAt = Date.parse(input.clock.observed_at);
  if (!Number.isFinite(openedAt) || !Number.isFinite(closedAt)) {
    return {
      state: "expected_but_missing",
      capability: "span_duration",
      reason: "clock_unavailable",
    };
  }
  if (closedAt < openedAt) {
    return {
      state: "expected_but_missing",
      capability: "span_duration",
      reason: "clock_regressed",
    };
  }
  if (
    span.boot_id === input.boot_id &&
    span.opened_monotonic_ns !== undefined &&
    input.clock.monotonic_ns !== undefined
  ) {
    const openedMonotonic = monotonic(span.opened_monotonic_ns);
    const closedMonotonic = monotonic(input.clock.monotonic_ns);
    if (openedMonotonic === undefined || closedMonotonic === undefined) {
      return {
        state: "expected_but_missing",
        capability: "span_duration",
        reason: "clock_unavailable",
      };
    }
    if (closedMonotonic < openedMonotonic) {
      return {
        state: "expected_but_missing",
        capability: "span_duration",
        reason: "monotonic_clock_regressed",
      };
    }
    return {
      state: "observed",
      value: Number((closedMonotonic - openedMonotonic) / 1_000_000n),
      attestation: "native",
      confidence: "exact",
    };
  }
  return {
    state: "observed",
    value: closedAt - openedAt,
    attestation: "derived",
    confidence: "high",
  };
}

function monotonic(value: string): bigint | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}
