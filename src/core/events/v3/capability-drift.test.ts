import { describe, expect, test } from "bun:test";
import { capabilityDriftPayloadsV3, measurableDeliveriesV3 } from "./capability-drift.ts";
import type { EventV3 } from "./contract.ts";

describe("event ledger V3 capability drift", () => {
  test("waits for a generation terminal before reporting", () => {
    expect(
      capabilityDriftPayloadsV3("claude-code", [event("turn.started")], {
        generation_ended: false,
      }),
    ).toEqual([]);
  });

  test("reports a promised derived duration that never materialized", () => {
    const events = healthyGeneration();
    const terminal = events.find((candidate) => type(candidate) === "tool.completed");
    record(record((terminal as { payload?: unknown } | undefined)?.payload).span).duration_ms = {
      state: "expected_but_missing",
      capability: "tool_duration",
      reason: "lost",
    };

    expect(capabilityDriftPayloadsV3("claude-code", events)).toContainEqual({
      signal: "tool_duration",
      promised: "derived",
      expected_count: 1,
      observed_count: 0,
      generation_ended: true,
    });
  });

  test("keeps a coherent generation clean and exposes auditable counts", () => {
    const events = healthyGeneration();
    expect(capabilityDriftPayloadsV3("claude-code", events)).toEqual([]);
    expect(measurableDeliveriesV3(events)).toEqual(
      expect.arrayContaining([
        { signal: "tool_duration", expected_count: 1, observed_count: 1 },
        { signal: "harness_timing", expected_count: 1, observed_count: 1 },
        { signal: "context_usage", expected_count: 1, observed_count: 1 },
      ]),
    );
  });

  test("never treats unsupported Cursor economics as drift", () => {
    const events = [event("session.started"), event("session.ended")];
    expect(capabilityDriftPayloadsV3("cursor", events)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signal: "model_usage" }),
        expect.objectContaining({ signal: "inference_timing" }),
      ]),
    );
  });
});

function healthyGeneration(): EventV3[] {
  return [
    event("session.started", {
      runtime_attestation: { model: { state: "observed" } },
    }),
    event("turn.started"),
    event("tool.requested"),
    event("tool.completed", {
      span: { duration_ms: { state: "observed", value: 10 } },
    }),
    event("context.observed", { measurement: { state: "observed" } }),
    event("turn.completed", {
      harness: { state: "observed" },
      usage: { state: "observed" },
      inference: { state: "observed" },
    }),
    event("session.ended"),
  ];
}

function event(event_type: string, payload: Record<string, unknown> = {}): EventV3 {
  return { event_type, payload } as unknown as EventV3;
}

function type(event: EventV3): string {
  return String((event as { event_type?: unknown }).event_type ?? "");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
