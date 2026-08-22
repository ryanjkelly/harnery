import { describe, expect, test } from "bun:test";
import { selectSemanticPending, semanticRateCap } from "./scheduler.ts";

describe("semantic fair scheduler", () => {
  test("serves the oldest first-band item but rotates away from the last generation", () => {
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
        band: 2 as const,
        pending_since: "2026-08-22T19:59:00.000Z",
      },
    ];
    expect(selectSemanticPending(pending)?.generation_id).toBe("gen_a");
    expect(selectSemanticPending(pending, "gen_a")?.generation_id).toBe("gen_b");
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
});
