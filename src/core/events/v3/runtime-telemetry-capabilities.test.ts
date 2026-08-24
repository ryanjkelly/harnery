import { describe, expect, test } from "bun:test";
import { effectiveRuntimeTelemetryCapabilitiesV3 } from "./runtime-telemetry-capabilities.ts";

describe("effective runtime telemetry capabilities", () => {
  test("attests exact derived Codex context without claiming inference", () => {
    const result = effectiveRuntimeTelemetryCapabilitiesV3({
      adapter: "codex",
      context: {
        state: "observed",
        source: "codex.rollout_token_count",
        attestation: "derived",
        confidence: "exact",
      },
      canonical_turn_boundaries: true,
    });

    expect(result.context_usage).toEqual({
      state: "observed",
      value: {
        support: "derived",
        source: "codex.rollout_token_count",
        completeness: "exact",
      },
      attestation: "derived",
      confidence: "exact",
    });
    expect(result.response_latency).toMatchObject({
      state: "observed",
      value: { support: "derived", completeness: "exact" },
    });
    expect(result.inference_timing).toEqual({
      state: "unsupported",
      capability: "provider_inference_timing",
    });
  });

  test("preserves Claude used-without-limit as a named missing capability", () => {
    const result = effectiveRuntimeTelemetryCapabilitiesV3({
      adapter: "claude-code",
      context: { state: "partial", reason: "context_limit_tokens_not_reported" },
      canonical_turn_boundaries: true,
    });

    expect(result.context_usage).toEqual({
      state: "expected_but_missing",
      capability: "context_usage",
      reason: "context_limit_tokens_not_reported",
    });
    expect(result.wait_spans).toMatchObject({
      state: "observed",
      value: { support: "native", completeness: "lower_bound" },
    });
  });

  test("distinguishes inferred Claude limits from Cursor percentage-only evidence", () => {
    const inferred = effectiveRuntimeTelemetryCapabilitiesV3({
      adapter: "claude-code",
      context: {
        state: "observed",
        source: "claude.transcript_usage_model_capability",
        attestation: "inferred",
        confidence: "high",
        completeness: "inferred",
      },
      canonical_turn_boundaries: true,
    });
    expect(inferred.context_usage).toMatchObject({
      state: "observed",
      value: { support: "derived", completeness: "inferred" },
      attestation: "inferred",
      confidence: "high",
    });

    const percentageOnly = effectiveRuntimeTelemetryCapabilitiesV3({
      adapter: "cursor",
      context: {
        state: "observed",
        source: "cursor.composer_context_percent",
        attestation: "derived",
        confidence: "high",
        completeness: "percentage_only",
      },
      canonical_turn_boundaries: true,
    });
    expect(percentageOnly.context_usage).toMatchObject({
      state: "observed",
      value: { support: "derived", completeness: "percentage_only" },
      attestation: "derived",
      confidence: "high",
    });
  });

  test("keeps local and cloud Cursor support distinct", () => {
    const local = effectiveRuntimeTelemetryCapabilitiesV3({
      adapter: "cursor",
      cursor_mode: "local",
      context: { state: "unsupported" },
      canonical_turn_boundaries: true,
    });
    const cloud = effectiveRuntimeTelemetryCapabilitiesV3({
      adapter: "cursor",
      cursor_mode: "cloud",
      context: { state: "unsupported" },
      canonical_turn_boundaries: true,
    });

    expect(local.context_usage).toEqual({ state: "unsupported", capability: "context_usage" });
    expect(local.wait_spans).toMatchObject({
      state: "observed",
      value: { support: "conditional", completeness: "lower_bound" },
    });
    expect(cloud.wait_spans).toEqual({
      state: "unsupported",
      capability: "wait_span_delivery",
    });
  });

  test("does not claim response latency without canonical turn boundaries", () => {
    const result = effectiveRuntimeTelemetryCapabilitiesV3({
      adapter: "cursor",
      cursor_mode: "unknown",
      context: { state: "unsupported" },
      canonical_turn_boundaries: false,
    });

    expect(result.response_latency).toEqual({
      state: "expected_but_missing",
      capability: "response_latency",
      reason: "turn_boundaries_not_delivered",
    });
  });

  test("separates observed waits from independently complete wait delivery", () => {
    const lowerBound = effectiveRuntimeTelemetryCapabilitiesV3({
      adapter: "codex",
      context: { state: "unsupported" },
      canonical_turn_boundaries: true,
    });
    const complete = effectiveRuntimeTelemetryCapabilitiesV3({
      adapter: "codex",
      context: { state: "unsupported" },
      canonical_turn_boundaries: true,
      independent_wait_completeness: true,
    });

    expect(lowerBound.wait_spans).toMatchObject({
      state: "observed",
      value: { completeness: "lower_bound" },
    });
    expect(lowerBound.wait_completeness).toEqual({
      state: "unsupported",
      capability: "wait_turn_completeness",
    });
    expect(complete.wait_completeness).toMatchObject({
      state: "observed",
      value: { completeness: "exact" },
    });
  });
});
