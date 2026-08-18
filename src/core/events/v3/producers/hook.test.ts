import { describe, expect, test } from "bun:test";
import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import type { EventV3Base } from "../base-contract.ts";
import type { SpanSummaryV3 } from "../contract.ts";
import { attestationIdV3, generationIdV3, spanIdV3 } from "../ids.ts";
import { emptyHarnessTimingV3, recordHarnessTimingV3 } from "../turn-telemetry.ts";
import { type HookProducerContextV3, normalizeHookEventV3, upgradeHookEventV3 } from "./hook.ts";
import { normalizeHookEventV3Base } from "./hook-base.ts";

describe("event ledger V3 hook producer", () => {
  test("uses V3-owned privacy normalization under the V3 contract", () => {
    const event = normalizeHookEventV3(
      "session-start",
      parsed({ session_id: "native-session-secret", model: "claude-sonnet-4-5" }),
      producerContext(),
    );

    expect(event?.event_type).toBe("session.started");
    expect((event?.contract as { major: number } | undefined)?.major).toBe(3);
    expect(JSON.stringify(event)).not.toContain("native-session-secret");
  });

  test("requires and emits a self-contained tool terminal", () => {
    const spanId = spanIdV3();
    const span = terminalSpan(spanId);
    const event = normalizeHookEventV3(
      "post-tool-use",
      parsed({
        session_id: "native-session",
        turn_id: "native-turn",
        tool_name: "Read",
        tool_use_id: "native-tool-call",
        tool_response: "private output",
      }),
      { ...producerContext(), span_id: spanId, terminal_span: span },
    );

    expect(event?.event_type).toBe("tool.completed");
    expect(event?.payload).toMatchObject({ span });
    expect(
      normalizeHookEventV3(
        "post-tool-use",
        parsed({ tool_name: "Read", tool_use_id: "native-tool-call" }),
        { ...producerContext(), span_id: spanId },
      ),
    ).toBeNull();
  });

  test("emits observed turn economics and bounded harness timing", () => {
    const timing = recordHarnessTimingV3(emptyHarnessTimingV3(), "Stop", 17.9);
    const event = normalizeHookEventV3(
      "stop",
      parsed({
        session_id: "native-session",
        raw: {
          usage: { input_tokens: 80, output_tokens: 20, api_time_ms: 420 },
        },
      }),
      {
        ...producerContext(),
        terminal_span: terminalSpan(spanIdV3()),
        harness_timing: timing,
      },
    );

    expect(event?.event_type).toBe("turn.completed");
    expect(event?.payload).toMatchObject({
      usage: { state: "observed", value: { input_tokens: 80, output_tokens: 20 } },
      inference: { state: "observed", value: { api_time_ms: 420 } },
      harness: { state: "observed", value: { hook_time_ms: 17, hook_count: 1 } },
    });
  });

  test("emits native permission waits and anchors delegation starts", () => {
    const wait = normalizeHookEventV3(
      "permission-request",
      parsed({ session_id: "native-session", tool_use_id: "native-tool-call" }),
      producerContext(),
    );
    const delegation = normalizeHookEventV3(
      "sub-agent-start",
      parsed({ session_id: "native-session" }),
      {
        ...producerContext(),
        delegation_id: `del_018f2f9a-4e3a-7d11-8c22-0123456789ab`,
        child_generation_id: generationIdV3(),
        span_id: spanIdV3(),
        parent_span_id: spanIdV3(),
      },
    );

    expect(wait?.event_type).toBe("wait.started");
    expect(delegation?.event_type).toBe("agent.started");
    expect(delegation?.links).toMatchObject({
      span_id: expect.stringMatching(/^span_/),
      parent_span_id: expect.stringMatching(/^span_/),
    });
  });

  test("upgrades a recorder-synthesized resolving wait terminal", () => {
    const context = producerContext();
    const started = normalizeHookEventV3Base(
      "permission-request",
      parsed({ session_id: "native-session", tool_use_id: "native-tool-call" }),
      context,
    );
    if (started?.event_type !== "wait.started") throw new Error("wait start missing");
    const terminal = {
      ...started,
      event_type: "wait.ended",
      payload: {
        wait_id: started.payload.wait_id,
        outcome: "succeeded",
        resolution_reference: "post-tool-use",
      },
    } as EventV3Base;
    const span = terminalSpan(spanIdV3());

    expect(
      upgradeHookEventV3(terminal, parsed({}), { ...context, terminal_span: span }),
    ).toMatchObject({
      event_type: "wait.ended",
      payload: { outcome: "succeeded", span },
    });
  });
});

function producerContext(): HookProducerContextV3 {
  const generationId = generationIdV3();
  return {
    coordRoot: "/workspace/project",
    adapter: "claude-code",
    adapterVersion: "1.0.0",
    harnessVersion: "1.0.0",
    root_id: "root_fixture",
    instance_id: "inst_fixture",
    generation_id: generationId,
    attestation_id: attestationIdV3(),
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
    observed_at: "2026-08-18T14:00:01.000Z",
  };
}

function parsed(values: Partial<ParsedPayload>): ParsedPayload {
  return { raw: {}, ...values };
}

function terminalSpan(span_id: `span_${string}`): SpanSummaryV3 {
  return {
    span_id,
    opened_at: "2026-08-18T14:00:00.000Z",
    duration_ms: { state: "observed", value: 1_000, attestation: "native", confidence: "exact" },
  };
}
