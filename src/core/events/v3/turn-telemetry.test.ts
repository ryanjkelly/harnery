import { describe, expect, test } from "bun:test";
import {
  emptyHarnessTimingV3,
  extractTurnTelemetryV3,
  harnessObservationV3,
  recordHarnessTimingV3,
} from "./turn-telemetry.ts";

describe("event ledger V3 turn telemetry", () => {
  test("extracts Claude usage, inference, and context without coercing missing cache fields", () => {
    expect(
      extractTurnTelemetryV3(
        "claude-code",
        {
          usage: {
            input_tokens: 100,
            output_tokens: 25,
            cache_read_input_tokens: 40,
            api_time_ms: 750,
          },
          context_window: { context_window_size: 1_000, used_tokens: 600 },
        },
        "2026-08-18T14:00:00.000Z",
      ),
    ).toEqual({
      usage: {
        state: "observed",
        value: {
          input_tokens: 100,
          output_tokens: 25,
          cache_read_tokens: 40,
          method: "claude_code_hook",
        },
        attestation: "native",
        confidence: "exact",
      },
      inference: {
        state: "observed",
        value: { api_time_ms: 750, request_count: 1 },
        attestation: "native",
        confidence: "exact",
      },
      context: {
        state: "observed",
        value: {
          used_tokens: 600,
          limit_tokens: 1_000,
          remaining_tokens: 400,
          measured_at: "2026-08-18T14:00:00.000Z",
          method: "claude_code_hook",
        },
        attestation: "native",
        confidence: "exact",
      },
    });
  });

  test("marks current native-hook inference timing unsupported", () => {
    expect(extractTurnTelemetryV3("codex", { usage: { input_tokens: 10 } })).toMatchObject({
      usage: { state: "expected_but_missing", capability: "model_usage" },
      inference: { state: "unsupported", capability: "inference_timing" },
    });
    expect(extractTurnTelemetryV3("claude-code", {}).inference).toEqual({
      state: "unsupported",
      capability: "inference_timing",
    });
    expect(extractTurnTelemetryV3("cursor", {})).toMatchObject({
      usage: { state: "unsupported", capability: "model_usage" },
      inference: { state: "unsupported", capability: "inference_timing" },
      context: { state: "unsupported", capability: "context_usage" },
    });
  });

  test("distinguishes observed, partial, unsupported, and promised context coverage", () => {
    expect(
      extractTurnTelemetryV3("codex", {
        context_window: { used_tokens: 768, context_window_size: 1_024 },
      }).context,
    ).toMatchObject({
      state: "observed",
      value: { used_tokens: 768, limit_tokens: 1_024, remaining_tokens: 256 },
    });
    expect(
      extractTurnTelemetryV3("codex", { context_window: { used_tokens: 768 } }).context,
    ).toEqual({
      state: "expected_but_missing",
      capability: "context_usage",
      reason: "context_limit_tokens_not_reported",
    });
    expect(extractTurnTelemetryV3("codex", {}).context).toEqual({
      state: "unsupported",
      capability: "context_usage",
    });
    expect(
      extractTurnTelemetryV3("codex", {}, undefined, { context_usage: "native" }).context,
    ).toEqual({
      state: "expected_but_missing",
      capability: "context_usage",
      reason: "promised_signal_not_reported",
    });
  });

  test("distinguishes conditional absence from a broken native promise", () => {
    expect(
      extractTurnTelemetryV3("codex", {}, undefined, { inference_timing: "conditional" }).inference,
    ).toEqual({
      state: "expected_but_missing",
      capability: "inference_timing",
      reason: "conditional_signal_not_reported",
    });
    expect(
      extractTurnTelemetryV3("codex", {}, undefined, { inference_timing: "native" }).inference,
    ).toEqual({
      state: "expected_but_missing",
      capability: "inference_timing",
      reason: "promised_signal_not_reported",
    });
  });

  test("accumulates bounded hook timing and names the slowest hook", () => {
    const first = recordHarnessTimingV3(emptyHarnessTimingV3(), "PreToolUse", 12.8);
    const second = recordHarnessTimingV3(first, "Session Start", 30.2);
    expect(harnessObservationV3(second)).toEqual({
      state: "observed",
      value: {
        hook_time_ms: 42,
        hook_count: 2,
        slowest_hook: "Session_Start",
        slowest_hook_ms: 30,
      },
      attestation: "derived",
      confidence: "high",
    });
    expect(harnessObservationV3(emptyHarnessTimingV3())).toEqual({
      state: "expected_but_missing",
      capability: "harness_timing",
      reason: "no_hook_timing_samples",
    });
  });
});
