import { describe, expect, test } from "bun:test";
import {
  type EventV3Fixture,
  eventV3Fixture,
  fixtureObject,
} from "../../../../tests/helpers/event-v3.ts";
import type { EventV3 } from "./contract.ts";
import { projectLatencyV3, runtimeTelemetryEvidenceKeyV3 } from "./latency.ts";
import type { ReadLedgerV3Result } from "./reader.ts";
import type { RuntimeTelemetryCapabilitiesV3 } from "./runtime-telemetry-capabilities.ts";

describe("event ledger V3 latency projection", () => {
  test("unions overlapping tools, dedupes nested commands, and separates waits", () => {
    const turn = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 1000);
    const turnPayload = fixtureObject(turn.payload);
    turnPayload.tool_call_count = observed(2);
    turnPayload.wait_count = observed(1);
    turnPayload.inference = observed({ api_time_ms: 50, request_count: 1 });
    turnPayload.harness = observed({
      hook_time_ms: 20,
      hook_count: 4,
      slowest_hook: "pre-tool-use",
      slowest_hook_ms: 9,
    });

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
      slowest_hook: "pre-tool-use",
      slowest_hook_ms: 9,
      residual_ms: { state: "observed", value_ms: 30 },
      over_attributed_ms: 0,
      context_percent: 50,
      context_coverage: {
        state: "observed",
        event_id: "evt_00000000-0000-7000-8000-000000000006",
        reason: null,
      },
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

  test("preserves context coverage reasons without inventing a percentage", () => {
    const cases = [
      {
        measurement: { state: "unsupported", capability: "context_usage" },
        expected: {
          state: "unsupported",
          event_id: "evt_00000000-0000-7000-8000-000000000002",
          reason: "context_usage_unsupported",
        },
      },
      {
        measurement: {
          state: "expected_but_missing",
          capability: "context_usage",
          reason: "context_limit_tokens_not_reported",
        },
        expected: {
          state: "partial",
          event_id: "evt_00000000-0000-7000-8000-000000000002",
          reason: "context_limit_tokens_not_reported",
        },
      },
      {
        measurement: {
          state: "expected_but_missing",
          capability: "context_usage",
          reason: "promised_signal_not_reported",
        },
        expected: {
          state: "expected_but_missing",
          event_id: "evt_00000000-0000-7000-8000-000000000002",
          reason: "promised_signal_not_reported",
        },
      },
    ] as const;

    for (const fixture of cases) {
      const turn = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 100);
      const context = eventV3Fixture("context.observed", 2);
      fixtureObject(context.payload).measurement = structuredClone(fixture.measurement);
      alignTurn(turn, [context]);
      const result = projectLatencyV3(readOf(turn, context)).turns[0]!;
      expect(result.context_percent).toBeNull();
      expect(result.context_coverage).toEqual(fixture.expected);
    }

    const turn = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 100);
    expect(projectLatencyV3(readOf(turn)).turns[0]?.context_coverage).toEqual({
      state: "expected_but_missing",
      event_id: null,
      reason: "context_observation_missing",
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

  test("keeps the Batch 01 residual unknown when current hook inference is unsupported", () => {
    const turn = terminal("turn.completed", 1, "2026-08-19T14:00:00.000Z", 332_310);
    const payload = fixtureObject(turn.payload);
    payload.tool_call_count = observed(0);
    payload.wait_count = observed(0);
    payload.inference = { state: "unsupported", capability: "inference_timing" };
    payload.harness = observed({ hook_time_ms: 5_547, hook_count: 4 });

    const result = projectLatencyV3(readOf(turn)).turns[0]!;
    expect(result.inference_ms).toEqual({
      state: "unknown",
      known_ms: 0,
      reasons: ["unsupported"],
    });
    expect(result.residual_ms).toEqual({
      state: "unknown",
      known_ms: 0,
      reasons: ["inference_unknown"],
    });
  });

  test("reports an evidence-shaped recovered interval only as an upper bound", () => {
    const turn = terminal("turn.completed", 1, "2026-08-19T21:47:16.000Z", 71_017);
    const turnPayload = fixtureObject(turn.payload);
    turnPayload.tool_call_count = observed(1);
    turnPayload.inference = observed({ api_time_ms: 100, request_count: 1 });
    turnPayload.harness = observed({ hook_time_ms: 50, hook_count: 2 });
    const tool = terminal("tool.completed", 2, "2026-08-19T21:47:16.307Z", 70_710);
    const toolPayload = fixtureObject(tool.payload);
    toolPayload.outcome = "unknown";
    toolPayload.recovery = { reason: "completion_not_observed_before_turn_end" };
    const recovered = { state: "unknown", reason: "completion_not_observed_before_turn_end" };
    toolPayload.duration_ms = recovered;
    fixtureObject(toolPayload.span).duration_ms = structuredClone(recovered);
    fixtureObject(toolPayload.recovery).elapsed_upper_bound_ms = {
      state: "observed",
      value: 70_710,
      attestation: "derived",
      confidence: "exact",
    };
    alignTurn(turn, [tool]);

    const result = projectLatencyV3(readOf(turn, tool)).turns[0]!;
    expect(result.tool_ms).toEqual({
      state: "unknown",
      known_ms: 0,
      upper_bound_ms: 70_710,
      reasons: ["unknown:completion_not_observed_before_turn_end"],
    });
    expect(result.tool_bound_coverage_percent).toBe(99.6);
    expect(result.tool_ranking_eligible).toBeFalse();
  });

  test("declines ranking when a recovery bound crosses the turn wall", () => {
    const turn = terminal("turn.completed", 1, "2026-08-19T21:00:00.000Z", 60_000);
    fixtureObject(turn.payload).tool_call_count = observed(1);
    const tool = eventV3Fixture("tool.completed", 2);
    const payload = fixtureObject(tool.payload);
    payload.duration_ms = { state: "unknown", reason: "completion_not_observed_before_next_turn" };
    const span = fixtureObject(payload.span);
    span.opened_at = "2026-08-19T21:00:10.000Z";
    span.duration_ms = structuredClone(payload.duration_ms);
    payload.recovery = {
      reason: "completion_not_observed_before_next_turn",
      elapsed_upper_bound_ms: {
        state: "observed",
        value: 120_000,
        attestation: "derived",
        confidence: "exact",
      },
    };
    alignTurn(turn, [tool]);

    const projection = projectLatencyV3(readOf(turn, tool));
    expect(projection.turns[0]?.tool_ms).toEqual({
      state: "unknown",
      known_ms: 0,
      upper_bound_ms: 50_000,
      reasons: ["unknown:completion_not_observed_before_next_turn"],
    });
    expect(projection.turns[0]?.tool_bound_coverage_percent).toBe(83.3);
    expect(projection.turns[0]?.tool_ranking_eligible).toBeFalse();
    expect(projection.diagnostics).toContainEqual({
      code: "recovery_bound_exceeds_turn_wall",
      event_id: tool.event_id as string,
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

  test("keeps tool timing unknown when the tool channel was not attested", () => {
    const turn = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 100);
    const payload = fixtureObject(turn.payload);
    payload.tool_call_count = {
      state: "expected_but_missing",
      capability: "turn_tool_call_count",
      reason: "tool_channel_unattested",
    };
    payload.inference = observed({ api_time_ms: 40, request_count: 1 });
    payload.harness = observed({ hook_time_ms: 10, hook_count: 2 });

    const projection = projectLatencyV3(readOf(turn));
    expect(projection.turns[0]?.tool_ms).toEqual({
      state: "unknown",
      known_ms: 0,
      reasons: ["tool_channel_unattested"],
    });
    expect(projection.turns[0]?.residual_ms).toEqual({
      state: "unknown",
      known_ms: 0,
      reasons: ["occupied_unknown"],
    });
    expect(projection.diagnostics).toContainEqual({
      code: "tool_channel_unattested",
      event_id: turn.event_id as string,
    });
  });

  test("distinguishes attested zero from unsupported Cursor tool coverage", () => {
    const complete = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 100);
    fixtureObject(complete.payload).tool_call_count = observed(0);
    expect(projectLatencyV3(readOf(complete)).turns[0]?.tool_ms).toEqual({
      state: "observed",
      value_ms: 0,
    });

    const unsupported = terminal("turn.completed", 2, "2026-08-18T14:01:00.000Z", 100);
    fixtureObject(unsupported.payload).tool_call_count = {
      state: "unsupported",
      capability: "turn_tool_call_count",
    };
    expect(projectLatencyV3(readOf(unsupported)).turns[0]?.tool_ms).toEqual({
      state: "unknown",
      known_ms: 0,
      reasons: ["tool_call_count_unsupported"],
    });
  });

  test("keeps an evidence-shaped long empty wait set unattested", () => {
    const turn = terminal("turn.completed", 1, "2026-08-19T14:00:00.000Z", 3_568_960);
    delete fixtureObject(turn.payload).wait_count;

    expect(projectLatencyV3(readOf(turn)).turns[0]?.wait_ms).toEqual({
      state: "unknown",
      known_ms: 0,
      reasons: ["wait_count_unattested"],
    });
  });

  test("distinguishes attested zero from unsupported wait coverage", () => {
    const complete = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 100);
    fixtureObject(complete.payload).wait_count = observed(0);
    expect(projectLatencyV3(readOf(complete)).turns[0]?.wait_ms).toEqual({
      state: "observed",
      value_ms: 0,
    });

    const unsupported = terminal("turn.completed", 2, "2026-08-18T14:01:00.000Z", 100);
    fixtureObject(unsupported.payload).wait_count = {
      state: "unsupported",
      capability: "turn_wait_count",
    };
    expect(projectLatencyV3(readOf(unsupported)).turns[0]?.wait_ms).toEqual({
      state: "unknown",
      known_ms: 0,
      reasons: ["wait_count_unsupported"],
    });
  });

  test("reports a start without a terminal as a wait-count mismatch", () => {
    const turn = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 100);
    fixtureObject(turn.payload).wait_count = observed(1);
    const started = eventV3Fixture("wait.started", 2);
    alignTurn(turn, [started]);

    expect(projectLatencyV3(readOf(turn, started)).turns[0]?.wait_ms).toEqual({
      state: "unknown",
      known_ms: 0,
      reasons: ["wait_terminal_count_mismatch"],
    });
  });

  test("retains one closed wait as a lower bound when another terminal is missing", () => {
    const turn = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 500);
    fixtureObject(turn.payload).wait_count = observed(2);
    const wait = terminal("wait.ended", 2, "2026-08-18T14:00:00.100Z", 100);
    alignTurn(turn, [wait]);

    expect(projectLatencyV3(readOf(turn, wait)).turns[0]?.wait_ms).toEqual({
      state: "unknown",
      known_ms: 100,
      reasons: ["wait_terminal_count_mismatch"],
    });
  });

  test("unions overlapping waits when terminal coverage is complete", () => {
    const turn = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 1000);
    fixtureObject(turn.payload).wait_count = observed(2);
    const first = terminal("wait.ended", 2, "2026-08-18T14:00:00.000Z", 600);
    const second = terminal("wait.ended", 3, "2026-08-18T14:00:00.400Z", 400);
    fixtureObject(first.payload).wait_id = "wait-first";
    fixtureObject(second.payload).wait_id = "wait-second";
    alignTurn(turn, [first, second]);

    expect(projectLatencyV3(readOf(turn, first, second)).turns[0]?.wait_ms).toEqual({
      state: "observed",
      value_ms: 800,
    });
  });

  test("projects mixed response latency without populating inference", () => {
    const noTool = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 1_000);
    fixtureObject(noTool.payload).tool_call_count = observed(0);
    fixtureObject(noTool.payload).inference = {
      state: "unsupported",
      capability: "inference_timing",
    };
    const noToolProjection = projectLatencyV3(readOf(noTool)).turns[0]!;
    expect(noToolProjection.response_latency).toEqual({
      agent_action_ms: { state: "observed", value_ms: 1_000 },
      first_tool_request_ms: { state: "unknown", known_ms: 0, reasons: ["no_tool_request"] },
      post_tool_response_ms: {
        state: "unknown",
        known_ms: 0,
        reasons: ["no_tool_completion"],
      },
      no_tool_terminal_response_ms: { state: "observed", value_ms: 1_000 },
      method: "canonical_event_timestamps_v1",
    });
    expect(noToolProjection.inference_ms.state).toBe("unknown");

    const parallel = terminal("turn.completed", 2, "2026-08-18T15:00:00.000Z", 1_000);
    fixtureObject(parallel.payload).tool_call_count = observed(2);
    fixtureObject(parallel.payload).inference = {
      state: "unsupported",
      capability: "inference_timing",
    };
    const firstRequest = eventV3Fixture("tool.requested", 3);
    const secondRequest = eventV3Fixture("tool.requested", 4);
    fixtureObject(firstRequest.time).observed_at = "2026-08-18T15:00:00.100Z";
    fixtureObject(secondRequest.time).observed_at = "2026-08-18T15:00:00.200Z";
    const firstTerminal = terminal("tool.completed", 5, "2026-08-18T15:00:00.100Z", 400);
    const secondTerminal = terminal("tool.completed", 6, "2026-08-18T15:00:00.200Z", 600);
    alignTurn(parallel, [firstRequest, secondRequest, firstTerminal, secondTerminal]);
    const parallelProjection = projectLatencyV3(
      readOf(parallel, firstRequest, secondRequest, firstTerminal, secondTerminal),
    ).turns[0]!;
    expect(parallelProjection.response_latency).toMatchObject({
      agent_action_ms: { state: "observed", value_ms: 100 },
      first_tool_request_ms: { state: "observed", value_ms: 100 },
      post_tool_response_ms: { state: "observed", value_ms: 200 },
      no_tool_terminal_response_ms: {
        state: "unknown",
        reasons: ["turn_contains_tools"],
      },
    });
    expect(parallelProjection.inference_ms.state).toBe("unknown");
  });

  test("keeps response latency unknown when action or terminal boundaries are missing", () => {
    const turn = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 1_000);
    fixtureObject(turn.payload).tool_call_count = observed(1);
    const recovered = eventV3Fixture("tool.completed", 2);
    const recoveredPayload = fixtureObject(recovered.payload);
    recoveredPayload.duration_ms = {
      state: "unknown",
      reason: "completion_not_observed_before_turn_end",
    };
    fixtureObject(recoveredPayload.span).duration_ms = structuredClone(
      recoveredPayload.duration_ms,
    );
    alignTurn(turn, [recovered]);

    expect(projectLatencyV3(readOf(turn, recovered)).turns[0]?.response_latency).toMatchObject({
      agent_action_ms: {
        state: "unknown",
        reasons: ["tool_request_unobserved"],
      },
      post_tool_response_ms: {
        state: "unknown",
        reasons: ["final_tool_completion_unknown"],
      },
    });
  });

  test("reports per-kind wait completeness only from an attested aggregate", () => {
    const turn = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 1_000);
    fixtureObject(turn.payload).wait_count = observed(2);
    const permissionStart = eventV3Fixture("wait.started", 2);
    const approvalStart = eventV3Fixture("wait.started", 3);
    const permissionEnd = terminal("wait.ended", 4, "2026-08-18T14:00:00.100Z", 100);
    const approvalEnd = terminal("wait.ended", 5, "2026-08-18T14:00:00.300Z", 200);
    for (const [event, id, kind] of [
      [permissionStart, "permission-1", "permission"],
      [permissionEnd, "permission-1", "permission"],
      [approvalStart, "approval-1", "approval"],
      [approvalEnd, "approval-1", "approval"],
    ] as const) {
      fixtureObject(event.payload).wait_id = id;
      fixtureObject(event.payload).kind = kind;
    }
    alignTurn(turn, [permissionStart, approvalStart, permissionEnd, approvalEnd]);
    const coverage = projectLatencyV3(
      readOf(turn, permissionStart, approvalStart, permissionEnd, approvalEnd),
    ).turns[0]!.wait_coverage_by_kind;
    expect(coverage.permission).toMatchObject({
      started_count: 1,
      ended_count: 1,
      open_count: 0,
      completeness: "complete",
      reason: null,
      duration_ms: { state: "observed", value_ms: 100 },
    });
    expect(coverage.approval).toMatchObject({
      completeness: "complete",
      duration_ms: { state: "observed", value_ms: 200 },
    });
    expect(coverage.scheduled).toMatchObject({
      started_count: 0,
      ended_count: 0,
      completeness: "complete",
      duration_ms: { state: "observed", value_ms: 0 },
    });
  });

  test("keeps observed wait kinds as lower bounds when completeness is unsupported", () => {
    const turn = terminal("turn.completed", 1, "2026-08-18T14:00:00.000Z", 500);
    fixtureObject(turn.payload).wait_count = {
      state: "unsupported",
      capability: "turn_wait_count",
    };
    const started = eventV3Fixture("wait.started", 2);
    const ended = terminal("wait.ended", 3, "2026-08-18T14:00:00.100Z", 100);
    for (const event of [started, ended]) {
      fixtureObject(event.payload).wait_id = "needs-input-1";
      fixtureObject(event.payload).kind = "needs_input";
    }
    alignTurn(turn, [started, ended]);
    const coverage = projectLatencyV3(readOf(turn, started, ended)).turns[0]!.wait_coverage_by_kind;
    expect(coverage.needs_input).toMatchObject({
      completeness: "lower_bound",
      reason: "turn_wait_count_unsupported",
      duration_ms: {
        state: "unknown",
        known_ms: 100,
        reasons: ["wait_kind_completeness_unattested"],
      },
    });
    expect(coverage.permission).toMatchObject({
      completeness: "unsupported",
      reason: "turn_wait_count_unsupported",
      duration_ms: {
        state: "unknown",
        known_ms: 0,
        reasons: ["wait_kind_completeness_unattested"],
      },
    });
  });

  test("carries the latest effective telemetry attestation into each generation", () => {
    const started = eventV3Fixture("session.started", 1);
    const changed = eventV3Fixture("session.attestation_changed", 2);
    const turn = terminal("turn.completed", 3, "2026-08-18T14:00:00.000Z", 500);
    const generationId = fixtureObject(turn.scope).generation_id;
    fixtureObject(started.scope).generation_id = generationId;
    fixtureObject(changed.scope).generation_id = generationId;

    const startedTelemetry = fixtureObject(
      fixtureObject(started.payload).runtime_attestation,
    ).telemetry;
    const changedTelemetry = fixtureObject(
      fixtureObject(changed.payload).runtime_attestation,
    ).telemetry;
    fixtureObject(fixtureObject(changedTelemetry).context_usage).completeness = "partial";
    fixtureObject(fixtureObject(changedTelemetry).context_usage).missing_reason =
      "claude_context_limit_tokens_not_reported";

    const projected = projectLatencyV3(readOf(started, changed, turn)).turns[0]!;
    expect(projected.telemetry_capabilities).toEqual(
      changedTelemetry as unknown as RuntimeTelemetryCapabilitiesV3,
    );
    expect(projected.telemetry_capabilities).not.toEqual(startedTelemetry);
    expect(projected.telemetry_evidence_key).toBe(
      runtimeTelemetryEvidenceKeyV3(changedTelemetry as unknown as RuntimeTelemetryCapabilitiesV3),
    );
  });

  test("changes the comparison key when effective telemetry evidence differs", () => {
    const started = eventV3Fixture("session.started", 1);
    const telemetry = fixtureObject(fixtureObject(started.payload).runtime_attestation).telemetry;
    const partial = structuredClone(telemetry);
    fixtureObject(fixtureObject(partial).context_usage).completeness = "partial";
    fixtureObject(fixtureObject(partial).context_usage).missing_reason =
      "claude_context_limit_tokens_not_reported";

    const key = runtimeTelemetryEvidenceKeyV3(
      telemetry as unknown as RuntimeTelemetryCapabilitiesV3,
    );
    expect(
      runtimeTelemetryEvidenceKeyV3(
        structuredClone(telemetry) as unknown as RuntimeTelemetryCapabilitiesV3,
      ),
    ).toBe(key);
    expect(
      runtimeTelemetryEvidenceKeyV3(partial as unknown as RuntimeTelemetryCapabilitiesV3),
    ).not.toBe(key);
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
  if (eventType === "turn.completed") payload.wait_count = observed(0);
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
