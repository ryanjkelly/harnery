import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import type { EventV3Base } from "../base-contract.ts";
import type { EventOfTypeV3, EventTypeV3, SpanSummaryV3 } from "../contract.ts";
import { EVENT_V3_CONTRACT_MAJOR, EVENT_V3_CONTRACT_NAME } from "../contract.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "../generated.ts";
import {
  emptyHarnessTimingV3,
  extractTurnTelemetryV3,
  type HarnessTimingAccumulatorV3,
  harnessObservationV3,
  type TurnTelemetryV3,
} from "../turn-telemetry.ts";
import { assertEventV3 } from "../validate.ts";
import {
  type HookProducerContextV3Base,
  type HookSignalV3Base,
  normalizeHookEventV3Base,
} from "./hook-base.ts";

export interface HookProducerContextV3 extends HookProducerContextV3Base {
  /** Required for terminal events; captured when the corresponding span opens. */
  terminal_span?: SpanSummaryV3;
  /** Required by V3 delegation starts so the child span is anchored in its parent tree. */
  parent_span_id?: `span_${string}`;
  /** Optional recorder aggregate. An empty aggregate remains explicit missing evidence. */
  harness_timing?: HarnessTimingAccumulatorV3;
  /** Test/replay override for already-extracted telemetry. */
  turn_telemetry?: TurnTelemetryV3;
}

export type HookSignalV3 = HookSignalV3Base;

const TERMINAL_EVENT_TYPES = new Set([
  "session.ended",
  "turn.completed",
  "tool.completed",
  "agent.completed",
  "wait.ended",
]);

export type HookEventV3 = EventOfTypeV3<EventTypeV3>;

/**
 * Normalize one hook payload to the V3 contract.
 *
 * The V3 base normalizer owns privacy and scope. This adapter adds contract
 * identity, self-contained terminal spans, and economics. Returning null for an incomplete terminal prevents a producer
 * from writing a structurally valid-looking event without its load-bearing
 * self-contained span.
 */
export function normalizeHookEventV3(
  signal: HookSignalV3Base,
  payload: ParsedPayload,
  context: HookProducerContextV3,
): HookEventV3 | null {
  const base = normalizeHookEventV3Base(signal, payload, context);
  if (!base) return null;
  return upgradeHookEventV3(base, payload, context);
}

/** Upgrade recorder-synthesized hook events, including resolving wait terminals. */
export function upgradeHookEventV3(
  base: EventV3Base,
  source: ParsedPayload,
  context: HookProducerContextV3,
): HookEventV3 | null {
  if (TERMINAL_EVENT_TYPES.has(base.event_type) && !context.terminal_span) return null;
  if (base.event_type === "agent.started" && (!context.span_id || !context.parent_span_id)) {
    return null;
  }

  const event = {
    ...base,
    contract: {
      name: EVENT_V3_CONTRACT_NAME,
      major: EVENT_V3_CONTRACT_MAJOR,
      schema_digest: EVENT_V3_SCHEMA_DIGEST,
    },
    event_type: base.event_type,
    links: {
      ...(base.links as Record<string, unknown>),
      ...(context.span_id ? { span_id: context.span_id } : {}),
      ...(context.parent_span_id ? { parent_span_id: context.parent_span_id } : {}),
    },
    payload: terminalPayload(base.event_type, base.payload, source, context),
  };
  assertEventV3(event);
  return event as HookEventV3;
}

function terminalPayload(
  eventType: string,
  basePayload: object,
  source: ParsedPayload,
  context: HookProducerContextV3,
): object {
  if (!TERMINAL_EVENT_TYPES.has(eventType)) return basePayload;
  const span = context.terminal_span as SpanSummaryV3;
  if (eventType === "tool.completed") {
    return { ...basePayload, duration_ms: span.duration_ms, span };
  }
  if (eventType !== "turn.completed") return { ...basePayload, span };

  const telemetry =
    context.turn_telemetry ??
    extractTurnTelemetryV3(
      context.adapter,
      source.raw,
      context.observed_at ?? context.recorded_at ?? new Date().toISOString(),
    );
  return {
    ...basePayload,
    duration_ms: span.duration_ms,
    span,
    usage: telemetry.usage,
    inference: telemetry.inference,
    harness: harnessObservationV3(context.harness_timing ?? emptyHarnessTimingV3()),
  };
}
