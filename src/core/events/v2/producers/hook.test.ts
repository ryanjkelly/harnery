import { describe, expect, test } from "bun:test";
import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import type { EventV2 } from "../contract.ts";
import { attestationIdV2, generationIdV2, spanIdV2 } from "../ids.ts";
import { type HookProducerContextV2, normalizeHookEventV2 } from "./hook.ts";

describe("event ledger V2 hook producer", () => {
  test("normalizes Claude start/tool/result/end without retaining native IDs or raw bodies", () => {
    const context = producerContext();
    const nativeSession = "native-session-account-secret";
    const toolInput = {
      file_path: "/workspace/project/src/index.ts",
      token: "API_SECRET_12345",
    };
    const toolResponse = "stdout customer-private-value";
    const spanId = spanIdV2();
    const started = normalizeHookEventV2(
      "session-start",
      parsed({ session_id: nativeSession, model: "claude-sonnet-4-5" }),
      { ...context, sequence: 1 },
    );
    const requested = normalizeHookEventV2(
      "pre-tool-use",
      parsed({
        session_id: nativeSession,
        turn_id: "native-turn-secret",
        tool_name: "Read",
        tool_use_id: "native-tool-call-secret",
        tool_input: toolInput,
      }),
      {
        ...context,
        sequence: 2,
        span_id: spanId,
        caused_by: [started?.event_id] as `evt_${string}`[],
      },
    );
    const completed = normalizeHookEventV2(
      "post-tool-use",
      parsed({
        session_id: nativeSession,
        turn_id: "native-turn-secret",
        tool_name: "Read",
        tool_use_id: "native-tool-call-secret",
        tool_response: toolResponse,
      }),
      {
        ...context,
        sequence: 3,
        span_id: spanId,
        caused_by: [requested?.event_id] as `evt_${string}`[],
      },
    );
    const ended = normalizeHookEventV2(
      "session-end",
      parsed({ session_id: nativeSession, clean_exit: true }),
      { ...context, sequence: 4, caused_by: [completed?.event_id] as `evt_${string}`[] },
    );
    const serialized = JSON.stringify([started, requested, completed, ended]);

    expect([started, requested, completed, ended].map((event) => event?.event_type)).toEqual([
      "session.started",
      "tool.requested",
      "tool.completed",
      "session.ended",
    ]);
    expect(serialized).not.toContain(nativeSession);
    expect(serialized).not.toContain("native-turn-secret");
    expect(serialized).not.toContain("native-tool-call-secret");
    expect(serialized).not.toContain("API_SECRET_12345");
    expect(serialized).not.toContain("customer-private-value");
    expect(
      (completed as Extract<EventV2, { event_type: "tool.completed" }>).payload.duration_ms,
    ).toEqual({
      state: "expected_but_missing",
      capability: "tool_duration",
      reason: "span_timing_not_supplied",
    });
    expect(
      (requested as Extract<EventV2, { event_type: "tool.requested" }>).payload.targets[0]?.display,
    ).toBe("src/index.ts");
  });

  test("returns no tool event when span-pairing evidence is unavailable", () => {
    const context = producerContext();
    expect(
      normalizeHookEventV2(
        "pre-tool-use",
        parsed({ tool_name: "Read", tool_input: { file_path: "src/a.ts" } }),
        { ...context, sequence: 1 },
      ),
    ).toBeNull();
  });

  test("records unsupported versus expected-but-missing telemetry explicitly", () => {
    const event = normalizeHookEventV2("session-start", parsed({ session_id: "native" }), {
      ...producerContext(),
      sequence: 1,
    }) as Extract<EventV2, { event_type: "session.started" }>;
    expect(event.payload.runtime_attestation.model).toEqual({
      state: "expected_but_missing",
      capability: "model_identity",
      reason: "not_reported",
    });

    const turn = normalizeHookEventV2("stop", parsed({ session_id: "native" }), {
      ...producerContext(),
      sequence: 2,
    }) as Extract<EventV2, { event_type: "turn.completed" }>;
    expect(turn.payload.duration_ms.state).toBe("expected_but_missing");
    expect(turn.payload.tool_call_count.state).toBe("expected_but_missing");
    expect(turn.payload.response).toEqual({
      state: "unsupported",
      capability: "turn_response_descriptor",
    });
  });
});

function producerContext(): HookProducerContextV2 {
  const generationId = generationIdV2();
  return {
    coordRoot: "/workspace/project",
    adapter: "claude-code",
    adapterVersion: "1.0.0",
    harnessVersion: "1.0.0",
    root_id: "root_fixture",
    instance_id: "inst_fixture",
    generation_id: generationId,
    attestation_id: attestationIdV2(),
    producer_id: "prd_claude-hook",
    boot_id: "boot_fixture",
    sequence: 1,
    build_id: "build_fixture",
    platform: "linux",
    capability_profile: `cap_${"a".repeat(64)}`,
    fingerprintContext: {
      epochId: "pep_fixture",
      epochKey: Buffer.alloc(32, 0x41),
      rootId: "root_fixture",
      generationId,
    },
  };
}

function parsed(values: Partial<ParsedPayload>): ParsedPayload {
  return { raw: {}, ...values };
}
