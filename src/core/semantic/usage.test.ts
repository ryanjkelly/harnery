import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  SEMANTIC_VISIBLE_USAGE_ESTIMATOR_ID,
  SEMANTIC_VISIBLE_USAGE_ESTIMATOR_VERSION,
  SemanticUsageReceiptV1Schema,
} from "./contract.ts";
import {
  aggregateSemanticUsage,
  estimateVisibleSemanticUsage,
  nativeSemanticUsage,
  unreportedSemanticUsage,
} from "./usage.ts";

describe("semantic usage receipts", () => {
  test("uses a versioned visible-payload estimate when native usage is absent", () => {
    const first = estimateVisibleSemanticUsage("visible prompt", "visible response");
    const second = estimateVisibleSemanticUsage("visible prompt", "visible response");

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      source: "estimated",
      scope: "visible-payload",
      estimator: {
        id: SEMANTIC_VISIBLE_USAGE_ESTIMATOR_ID,
        version: SEMANTIC_VISIBLE_USAGE_ESTIMATOR_VERSION,
      },
      tokens: {
        input_tokens: { provenance: "estimated" },
        output_tokens: { provenance: "estimated" },
        total_tokens: { provenance: "estimated" },
      },
    });
    expect(Value.Check(SemanticUsageReceiptV1Schema, first)).toBe(true);
  });

  test("keeps native, estimated, and unreported states structurally distinct", () => {
    const native = nativeSemanticUsage({ input_tokens: 10, output_tokens: 2 })!;
    const estimated = estimateVisibleSemanticUsage("a", "b");
    const unreported = unreportedSemanticUsage();

    expect(native.source).toBe("native");
    if (native.source !== "native") throw new Error("fixture native usage missing");
    expect(native.tokens.input_tokens?.provenance).toBe("native");
    expect(native.tokens.total_tokens).toBeUndefined();
    expect(estimated.source).toBe("estimated");
    expect(unreported).toEqual({
      schema_version: 1,
      source: "unreported",
      scope: "unreported",
    });
    expect(
      [native, estimated, unreported].every((value) =>
        Value.Check(SemanticUsageReceiptV1Schema, value),
      ),
    ).toBe(true);
    expect(
      Value.Check(SemanticUsageReceiptV1Schema, {
        ...native,
        tokens: { input_tokens: { value: 10, provenance: "estimated" } },
      }),
    ).toBe(false);
  });

  test("aggregates by harness and model without combining exact and estimated totals", () => {
    const aggregate = aggregateSemanticUsage([
      {
        source_harness: "codex",
        configured_model: "gpt-5.6-luna",
        resolved_model_id: "gpt-5.6-luna",
        model_attestation: "requested-only",
        action: "accepted",
        model_call: true,
        usage: nativeSemanticUsage({ input_tokens: 100, output_tokens: 20 }),
      },
      {
        source_harness: "cursor",
        configured_model: "composer-2.5",
        resolved_model_id: "Composer 2.5",
        model_attestation: "verified",
        action: "invalid",
        model_call: true,
        invalid_reason_codes: ["citation", "unsupported_claim"],
        usage: estimateVisibleSemanticUsage("prompt", "invalid reply"),
      },
      {
        source_harness: "claude-code",
        configured_model: "haiku-4.5",
        action: "unavailable",
        model_call: true,
      },
      {
        source_harness: "codex",
        configured_model: "gpt-5.6-luna",
        action: "deferred",
        model_call: false,
      },
    ]);

    expect(aggregate.call_count).toBe(3);
    expect(aggregate.outcomes).toEqual({ accepted: 1, invalid: 1, unavailable: 1, deferred: 1 });
    expect(aggregate.invalid_reasons).toEqual({ citation: 1, unsupported_claim: 1 });
    expect(aggregate.native_tokens).toEqual({ input_tokens: 100, output_tokens: 20 });
    expect(aggregate.estimated_tokens.total_tokens).toBeGreaterThan(0);
    expect(aggregate.unreported_calls).toBe(1);
    expect(aggregate.breakdowns).toHaveLength(4);
    expect(aggregate.breakdowns.find((row) => row.harness === "cursor")).toMatchObject({
      invalid_reasons: { citation: 1, unsupported_claim: 1 },
    });
    expect(
      aggregate.breakdowns.find((row) => row.harness === "codex" && row.call_count === 1),
    ).toMatchObject({
      configured_model: "gpt-5.6-luna",
      call_count: 1,
      native_tokens: { input_tokens: 100, output_tokens: 20 },
    });
  });

  test("treats an old call without a usage receipt as unreported", () => {
    const aggregate = aggregateSemanticUsage([{ model_call: true, action: "accepted" }]);
    expect(aggregate).toMatchObject({ call_count: 1, unreported_calls: 1 });
    expect(aggregate.native_tokens).toEqual({});
    expect(aggregate.estimated_tokens).toEqual({});
  });
});
