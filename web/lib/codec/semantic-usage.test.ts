import { describe, expect, test } from "bun:test";
import type { SemanticUsageReceiptV1 } from "../../../src/core/semantic/contract";
import { formatSemanticUsageAggregate, formatSemanticUsageReceipt } from "./semantic-usage";

describe("Codec semantic usage labels", () => {
  test("renders reported usage without calling it estimated", () => {
    const usage: SemanticUsageReceiptV1 = {
      schema_version: 1,
      source: "native",
      scope: "harness-call",
      tokens: {
        input_tokens: { value: 1200, provenance: "native" },
        output_tokens: { value: 42, provenance: "native" },
      },
    };
    expect(formatSemanticUsageReceipt(usage)).toBe("reported · input 1,200 · output 42");
  });

  test("renders estimated usage as visible-payload only", () => {
    const usage: SemanticUsageReceiptV1 = {
      schema_version: 1,
      source: "estimated",
      scope: "visible-payload",
      estimator: { id: "visible-o200k-base", version: 1 },
      tokens: {
        input_tokens: { value: 12, provenance: "estimated" },
        output_tokens: { value: 5, provenance: "estimated" },
        total_tokens: { value: 17, provenance: "estimated" },
      },
    };
    expect(formatSemanticUsageReceipt(usage)).toBe(
      "estimated visible payload · input 12 · output 5 · total 17",
    );
  });

  test("renders missing and aggregate unreported usage honestly", () => {
    expect(formatSemanticUsageReceipt(undefined)).toBe("unreported usage");
    expect(
      formatSemanticUsageAggregate("rolling hour", {
        call_count: 2,
        outcomes: { accepted: 2, invalid: 0, unavailable: 0, deferred: 0 },
        native_tokens: {},
        estimated_tokens: {},
        unreported_calls: 2,
        breakdowns: [],
      }),
    ).toEqual(["rolling hour: 2 calls", "unreported: 2 calls"]);
  });
});
