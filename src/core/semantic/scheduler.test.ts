import { describe, expect, test } from "bun:test";
import {
  selectSemanticPending,
  semanticGenerationCallEligible,
  semanticPendingPassDue,
  semanticRateCap,
} from "./scheduler.ts";

const pending = (generationId: string, pendingSince = "2026-08-22T20:00:00.000Z") => ({
  generation_id: generationId,
  evidence_digest: `sha256:${"a".repeat(64)}` as const,
  band: 2 as const,
  pending_since: pendingSince,
});

describe("semantic fair scheduler", () => {
  test("serves first-band items in a stable round robin", () => {
    const pending = [
      {
        generation_id: "gen_a",
        evidence_digest: `sha256:${"a".repeat(64)}` as const,
        band: 1 as const,
        pending_since: "2026-08-22T20:00:00.000Z",
      },
      {
        generation_id: "gen_b",
        evidence_digest: `sha256:${"b".repeat(64)}` as const,
        band: 1 as const,
        pending_since: "2026-08-22T20:00:01.000Z",
      },
      {
        generation_id: "gen_c",
        evidence_digest: `sha256:${"c".repeat(64)}` as const,
        band: 1 as const,
        pending_since: "2026-08-22T20:00:02.000Z",
      },
      {
        generation_id: "gen_d",
        evidence_digest: `sha256:${"d".repeat(64)}` as const,
        band: 2 as const,
        pending_since: "2026-08-22T19:59:00.000Z",
      },
    ];
    expect(selectSemanticPending(pending)?.generation_id).toBe("gen_a");
    expect(selectSemanticPending(pending, "gen_a")?.generation_id).toBe("gen_b");
    expect(selectSemanticPending(pending, "gen_b")?.generation_id).toBe("gen_c");
    expect(selectSemanticPending(pending, "gen_c")?.generation_id).toBe("gen_a");
    expect(selectSemanticPending(pending, "gen_missing")?.generation_id).toBe("gen_a");
  });

  test("hard-caps any configured hourly limit and names the next eligible time", () => {
    const history = Array.from({ length: 60 }, () => ({
      generation_id: "gen_a",
      started_at: "2026-08-22T20:00:00.000Z",
    }));
    expect(semanticRateCap(history, Date.parse("2026-08-22T20:30:00.000Z"), 10_000)).toEqual({
      available: 0,
      eligible_after: "2026-08-22T21:00:00.000Z",
    });
  });

  test("holds one hot generation for thirty seconds without delaying its peers", () => {
    const history = [{ generation_id: "gen_a", started_at: "2026-08-22T20:00:00.000Z" }];
    expect(
      semanticGenerationCallEligible(history, "gen_a", Date.parse("2026-08-22T20:00:29.999Z")),
    ).toBe(false);
    expect(
      semanticGenerationCallEligible(history, "gen_b", Date.parse("2026-08-22T20:00:01.000Z")),
    ).toBe(true);
    expect(
      semanticGenerationCallEligible(history, "gen_a", Date.parse("2026-08-22T20:00:30.000Z")),
    ).toBe(true);
  });

  test("does not start a pass while every pending generation is still held", () => {
    const nowMs = Date.parse("2026-08-22T20:00:10.000Z");
    expect(
      semanticPendingPassDue({
        pending: [pending("gen_a")],
        callHistory: [{ generation_id: "gen_a", started_at: "2026-08-22T20:00:00.000Z" }],
        nowMs,
        debounceMs: 5_000,
      }),
    ).toBe(false);
  });

  test("starts when any matured generation is eligible without delaying it behind a hot peer", () => {
    const nowMs = Date.parse("2026-08-22T20:00:10.000Z");
    expect(
      semanticPendingPassDue({
        pending: [pending("gen_a"), pending("gen_b")],
        callHistory: [{ generation_id: "gen_a", started_at: "2026-08-22T20:00:00.000Z" }],
        nowMs,
        debounceMs: 5_000,
      }),
    ).toBe(true);
  });

  test("waits for debounce before running otherwise eligible pending work", () => {
    expect(
      semanticPendingPassDue({
        pending: [pending("gen_a", "2026-08-22T20:00:08.000Z")],
        callHistory: [],
        nowMs: Date.parse("2026-08-22T20:00:10.000Z"),
        debounceMs: 5_000,
      }),
    ).toBe(false);
  });

  test("runs one matured pass at the hourly cap so deferred receipts can be published", () => {
    const callHistory = Array.from({ length: 60 }, (_, index) => ({
      generation_id: `gen_${index}`,
      started_at: "2026-08-22T20:00:00.000Z",
    }));
    expect(
      semanticPendingPassDue({
        pending: [pending("gen_waiting")],
        callHistory,
        nowMs: Date.parse("2026-08-22T20:30:00.000Z"),
        debounceMs: 5_000,
      }),
    ).toBe(true);
  });
});
