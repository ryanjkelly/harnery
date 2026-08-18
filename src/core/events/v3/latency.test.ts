import { describe, expect, test } from "bun:test";
import {
  type EventV3Fixture,
  eventV3Fixture,
  fixtureObject,
} from "../../../../tests/helpers/event-v3.ts";
import type { EventV3 } from "./contract.ts";
import { projectLatencyV3 } from "./latency.ts";
import type { ReadLedgerV3Result } from "./reader.ts";

describe("event ledger V3 latency projection", () => {
  test("unions overlapping tools, dedupes nested commands, and separates waits", () => {
    const turn = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 1000);
    const turnPayload = fixtureObject(turn.payload);
    turnPayload.tool_call_count = observed(2);
    turnPayload.inference = observed({ api_time_ms: 50, request_count: 1 });
    turnPayload.harness = observed({ hook_time_ms: 20, hook_count: 4 });

    const toolOne = terminal("tool.completed", 2, "2026-08-18T14:00:00.000Z", 600);
    const command = terminal("command.completed", 3, "2026-08-18T14:00:00.100Z", 200);
    const toolTwo = terminal("tool.completed", 4, "2026-08-18T14:00:00.400Z", 400);
    fixtureObject(toolOne.payload).tool = { namespace: "functions", name: "exec" };
    fixtureObject(toolTwo.payload).tool = { namespace: "functions", name: "exec" };
    const wait = terminal("wait.ended", 5, "2026-08-18T14:00:00.800Z", 100);
    const context = eventV3Fixture("context.observed", 6);
    fixtureObject(context.payload).measurement = observed({
      used_tokens: 500,
      limit_tokens: 1000,
      measured_at: "2026-08-18T14:00:00.900Z",
      method: "fixture",
    });
    alignTurn(turn, [toolOne, command, toolTwo, wait, context]);

    const projection = projectLatencyV3(readOf(turn, toolOne, command, toolTwo, wait, context));
    expect(projection.diagnostics).toEqual([]);
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]).toMatchObject({
      wall_ms: { state: "observed", value_ms: 1000 },
      tool_ms: { state: "observed", value_ms: 800 },
      command_ms: { state: "observed", value_ms: 200 },
      command_exclusive_ms: { state: "observed", value_ms: 0 },
      wait_ms: { state: "observed", value_ms: 100 },
      occupied_ms: { state: "observed", value_ms: 900 },
      inference_ms: { state: "observed", value_ms: 50 },
      harness_ms: { state: "observed", value_ms: 20 },
      residual_ms: { state: "observed", value_ms: 30 },
      over_attributed_ms: 0,
      context_percent: 50,
      span_counts: { tool: 2, command: 1, wait: 1 },
      tool_breakdown: [
        {
          namespace: "functions",
          name: "exec",
          count: 2,
          duration_ms: { state: "observed", value_ms: 800 },
        },
      ],
    });
  });

  test("keeps known lower bounds while naming unknown terminal timing", () => {
    const turn = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 500);
    const turnPayload = fixtureObject(turn.payload);
    turnPayload.tool_call_count = observed(1);
    turnPayload.inference = observed({ api_time_ms: 10, request_count: 1 });
    turnPayload.harness = observed({ hook_time_ms: 5, hook_count: 1 });
    const tool = eventV3Fixture("tool.completed", 2);
    const toolPayload = fixtureObject(tool.payload);
    const unknown = { state: "unknown", reason: "completion_not_observed_before_turn_end" };
    toolPayload.duration_ms = unknown;
    fixtureObject(toolPayload.span).duration_ms = structuredClone(unknown);
    fixtureObject(toolPayload.span).opened_at = "2026-08-18T14:00:00.100Z";
    alignTurn(turn, [tool]);

    const result = projectLatencyV3(readOf(turn, tool)).turns[0]!;
    expect(result.tool_ms).toEqual({
      state: "unknown",
      known_ms: 0,
      reasons: ["unknown:completion_not_observed_before_turn_end"],
    });
    expect(result.residual_ms).toEqual({
      state: "unknown",
      known_ms: 0,
      reasons: ["occupied_unknown"],
    });
  });

  test("reports over-attribution instead of emitting a negative residual", () => {
    const turn = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 100);
    const payload = fixtureObject(turn.payload);
    payload.tool_call_count = observed(0);
    payload.inference = observed({ api_time_ms: 80, request_count: 1 });
    payload.harness = observed({ hook_time_ms: 40, hook_count: 1 });

    const projection = projectLatencyV3(readOf(turn));
    expect(projection.turns[0]?.residual_ms).toEqual({ state: "observed", value_ms: 0 });
    expect(projection.turns[0]?.over_attributed_ms).toBe(20);
    expect(projection.diagnostics).toEqual([
      { code: "over_attributed", event_id: turn.event_id as string },
    ]);
  });

  test("refuses to project an incomplete ledger read", () => {
    const read = readOf();
    read.complete = false;
    expect(() => projectLatencyV3(read)).toThrow("complete V3 ledger read");
  });
});

function terminal(
  eventType: "turn.completed" | "tool.completed" | "command.completed" | "wait.ended",
  sequence: number,
  openedAt: string,
  durationMs: number,
): EventV3Fixture {
  const event = eventV3Fixture(eventType, sequence);
  const payload = fixtureObject(event.payload);
  const duration = observed(durationMs);
  payload.duration_ms = duration;
  const span = fixtureObject(payload.span);
  span.opened_at = openedAt;
  span.duration_ms = structuredClone(duration);
  return event;
}

function alignTurn(turn: EventV3Fixture, events: EventV3Fixture[]): void {
  const scope = fixtureObject(turn.scope);
  for (const event of events) {
    const target = fixtureObject(event.scope);
    target.generation_id = scope.generation_id;
    target.turn_id = scope.turn_id;
  }
}

function observed(value: unknown) {
  return { state: "observed", value, attestation: "native", confidence: "exact" };
}

function readOf(...events: EventV3Fixture[]): ReadLedgerV3Result {
  return {
    events: events.map((event, index) => ({
      event: event as unknown as EventV3,
      position: { segment_ordinal: 1, byte_offset: index * 1000 },
    })),
    diagnostics: [],
    complete: true,
    genesis_id: "gex_fixture",
    active_schema_digest: "sha256:fixture",
    advances: [],
    bytes: 0,
  };
}
