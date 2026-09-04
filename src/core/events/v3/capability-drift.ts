import type { EventAdapterIdV3 } from "./adapter-id.ts";
import {
  type AdapterSignalV3,
  adapterSignalSupportV3,
  type CapabilitySupportV3,
} from "./capabilities.ts";
import type { EventPayloadV3, EventV3 } from "./contract.ts";

export interface CapabilityDeliveryV3 {
  signal: AdapterSignalV3;
  expected_count: number;
  observed_count: number;
}

export type CapabilityDriftPayloadV3 = EventPayloadV3<"health.capability_drift">;

/**
 * Compare measurable adapter promises against one completed generation.
 *
 * Conditional and unsupported promises never drift: absence is allowed by
 * their contract. Native and derived promises report only when a concrete
 * opportunity existed, keeping a quiet generation from manufacturing health
 * failures.
 */
export function capabilityDriftPayloadsV3(
  adapter: EventAdapterIdV3,
  events: readonly EventV3[],
  options: { generation_ended?: boolean } = {},
): CapabilityDriftPayloadV3[] {
  const generationEnded =
    options.generation_ended ?? events.some((event) => eventType(event) === "session.ended");
  if (!generationEnded) return [];

  return measurableDeliveries(events)
    .filter(({ signal, expected_count, observed_count }) => {
      const promised = adapterSignalSupportV3(adapter, signal);
      return (
        promised !== "unsupported" && promised !== "conditional" && expected_count > observed_count
      );
    })
    .map(({ signal, expected_count, observed_count }) => ({
      signal,
      promised: adapterSignalSupportV3(adapter, signal) as Exclude<
        CapabilitySupportV3,
        "unsupported"
      >,
      expected_count,
      observed_count,
      generation_ended: true,
    }));
}

export function measurableDeliveriesV3(events: readonly EventV3[]): CapabilityDeliveryV3[] {
  return measurableDeliveries(events);
}

function measurableDeliveries(events: readonly EventV3[]): CapabilityDeliveryV3[] {
  const counts = new Map<string, number>();
  const observed = new Map<string, number>();
  const increment = (map: Map<string, number>, key: string) =>
    map.set(key, (map.get(key) ?? 0) + 1);

  for (const event of events) {
    const type = eventType(event);
    const payload = record((event as { payload?: unknown }).payload);
    switch (type) {
      case "session.started":
        increment(observed, "session_start");
        if (record(record(payload.runtime_attestation).model).state === "observed") {
          increment(observed, "model_identity");
        }
        break;
      case "session.ended":
        increment(observed, "session_end");
        break;
      case "turn.started":
        increment(counts, "turn_completion");
        break;
      case "turn.completed":
        increment(observed, "turn_completion");
        increment(counts, "harness_timing");
        increment(counts, "context_usage");
        increment(counts, "model_usage");
        increment(counts, "inference_timing");
        if (observationObserved(payload.harness)) increment(observed, "harness_timing");
        if (observationObserved(payload.usage)) increment(observed, "model_usage");
        if (observationObserved(payload.inference)) increment(observed, "inference_timing");
        break;
      case "tool.requested":
        increment(observed, "tool_request");
        increment(counts, "tool_result");
        break;
      case "tool.completed":
        increment(counts, "tool_request");
        increment(observed, "tool_result");
        increment(counts, "tool_duration");
        if (observationObserved(record(payload.span).duration_ms)) {
          increment(observed, "tool_duration");
        }
        break;
      case "wait.started":
        increment(counts, "permission");
        break;
      case "wait.ended":
        increment(observed, "permission");
        break;
      case "agent.started":
        increment(counts, "subagent");
        break;
      case "agent.completed":
        increment(observed, "subagent");
        break;
      case "context.compaction_started":
        increment(counts, "post_compaction");
        break;
      case "context.compaction_completed":
        increment(observed, "post_compaction");
        break;
      case "context.observed":
        if (observationObserved(payload.measurement)) increment(observed, "context_usage");
        break;
    }
  }

  const sessionExpected = events.length > 0 ? 1 : 0;
  const deliveries: CapabilityDeliveryV3[] = [
    delivery("session_start", sessionExpected, observed),
    delivery("session_end", sessionExpected, observed),
    deliveryFrom("turn_completion", counts, observed),
    delivery(
      "tool_request",
      Math.max(counts.get("tool_request") ?? 0, observed.get("tool_request") ?? 0),
      observed,
    ),
    deliveryFrom("tool_result", counts, observed),
    deliveryFrom("tool_duration", counts, observed),
    deliveryFrom("permission", counts, observed),
    deliveryFrom("subagent", counts, observed),
    deliveryFrom("post_compaction", counts, observed),
    deliveryFrom("context_usage", counts, observed),
    deliveryFrom("model_identity", new Map([["model_identity", sessionExpected]]), observed),
    deliveryFrom("model_usage", counts, observed),
    deliveryFrom("inference_timing", counts, observed),
    deliveryFrom("harness_timing", counts, observed),
  ];
  return deliveries.filter(({ expected_count }) => expected_count > 0);
}

function delivery(
  signal: AdapterSignalV3,
  expected_count: number,
  observed: Map<string, number>,
): CapabilityDeliveryV3 {
  return { signal, expected_count, observed_count: observed.get(signal) ?? 0 };
}

function deliveryFrom(
  signal: AdapterSignalV3,
  expected: Map<string, number>,
  observed: Map<string, number>,
): CapabilityDeliveryV3 {
  return delivery(signal, expected.get(signal) ?? 0, observed);
}

function eventType(event: EventV3): string {
  return String((event as { event_type?: unknown }).event_type ?? "");
}

function observationObserved(value: unknown): boolean {
  return record(value).state === "observed";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
