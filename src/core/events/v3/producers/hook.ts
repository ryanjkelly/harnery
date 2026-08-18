import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import type { EventV2 } from "../../v2/contract.ts";
import {
  type HookProducerContextV2,
  type HookSignalV2,
  normalizeHookEventV2,
} from "../../v2/producers/hook.ts";
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

export interface HookProducerContextV3 extends HookProducerContextV2 {
  /** Required for terminal events; captured when the corresponding span opens. */
  terminal_span?: SpanSummaryV3;
  /** Required by V3 delegation starts so the child span is anchored in its parent tree. */
  parent_span_id?: `span_${string}`;
  /** Optional recorder aggregate. An empty aggregate remains explicit missing evidence. */
  harness_timing?: HarnessTimingAccumulatorV3;
  /** Test/replay override for already-extracted telemetry. */
  turn_telemetry?: TurnTelemetryV3;
}

export type HookSignalV3 = HookSignalV2;

const TERMINAL_EVENT_TYPES = new Set([
  "session.ended",
  "turn.completed",
  "tool.completed",
  "agent.completed",
  "interaction.wait_ended",
]);

export type HookEventV3 = EventOfTypeV3<EventTypeV3>;

/**
 * Normalize one hook payload to the inactive V3 contract.
 *
 * The V2 normalizer remains the privacy and scope authority. This adapter only
 * applies V3's contract identity, span-terminal evidence, economics, and hard
 * event renames. Returning null for an incomplete terminal prevents a producer
 * from writing a structurally valid-looking event without its load-bearing
 * self-contained span.
 */
export function normalizeHookEventV3(
  signal: HookSignalV2,
  payload: ParsedPayload,
  context: HookProducerContextV3,
): HookEventV3 | null {
  const base = normalizeHookEventV2(signal, payload, context);
  if (!base) return null;
  return upgradeHookEventV3(base, payload, context);
}

/** Upgrade recorder-synthesized hook events, including resolving wait terminals. */
export function upgradeHookEventV3(
  base: EventV2,
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
    event_type:
      base.event_type === "interaction.wait_started"
        ? "wait.started"
        : base.event_type === "interaction.wait_ended"
          ? "wait.ended"
          : base.event_type,
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
