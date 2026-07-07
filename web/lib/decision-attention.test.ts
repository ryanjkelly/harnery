import { describe, expect, test } from "bun:test";
import { reviewFeedScore, sortReviewFeed } from "./decision-attention";
import type { DecisionManifest } from "./decision-reader";

function d(over: Partial<DecisionManifest> & { decision_id: string }): DecisionManifest {
  return {
    schema_version: 1,
    status: "resolved",
    tier: 1,
    stakes: "medium",
    question: "q",
    filed_at: "2026-07-06T00:00:00Z",
    ...over,
  } as DecisionManifest;
}

describe("reviewFeedScore", () => {
  test("higher stakes scores higher", () => {
    const counts = new Map<string, number>();
    const hi = reviewFeedScore(d({ decision_id: "a-2026-07-06-aaaa", stakes: "high" }), counts);
    const lo = reviewFeedScore(d({ decision_id: "b-2026-07-06-bbbb", stakes: "small" }), counts);
    expect(hi).toBeGreaterThan(lo);
  });

  test("a recurring question (seen stem) scores lower than a novel one", () => {
    const counts = new Map<string, number>([["recurring", 3]]);
    const recurring = reviewFeedScore(d({ decision_id: "recurring-2026-07-06-aaaa" }), counts);
    const novel = reviewFeedScore(d({ decision_id: "novel-2026-07-06-bbbb" }), counts);
    expect(novel).toBeGreaterThan(recurring);
  });

  test("tier 2 outranks tier 0 at equal stakes", () => {
    const counts = new Map<string, number>();
    const t2 = reviewFeedScore(d({ decision_id: "x-2026-07-06-aaaa", tier: 2 }), counts);
    const t0 = reviewFeedScore(d({ decision_id: "y-2026-07-06-bbbb", tier: 0 }), counts);
    expect(t2).toBeGreaterThan(t0);
  });
});

describe("sortReviewFeed", () => {
  test("orders high-stakes-novel first, recurring-small last", () => {
    const feed = [
      d({ decision_id: "small-recurring-2026-07-06-aaaa", stakes: "small" }),
      d({ decision_id: "small-recurring-2026-07-05-bbbb", stakes: "small" }),
      d({ decision_id: "big-novel-2026-07-06-cccc", stakes: "high" }),
    ];
    const sorted = sortReviewFeed(feed);
    expect(sorted[0].decision_id).toBe("big-novel-2026-07-06-cccc");
  });

  test("ties break on most-recently-resolved first", () => {
    const feed = [
      d({
        decision_id: "a-2026-07-06-aaaa",
        resolution: {
          recommendation: "x",
          evidence: ["e"],
          resolved_by: "z",
          resolved_at: "2026-07-01T00:00:00Z",
        },
      }),
      d({
        decision_id: "b-2026-07-06-bbbb",
        resolution: {
          recommendation: "x",
          evidence: ["e"],
          resolved_by: "z",
          resolved_at: "2026-07-05T00:00:00Z",
        },
      }),
    ];
    const sorted = sortReviewFeed(feed);
    expect(sorted[0].decision_id).toBe("b-2026-07-06-bbbb");
  });

  test("does not mutate the input array", () => {
    const feed = [
      d({ decision_id: "a-2026-07-06-aaaa" }),
      d({ decision_id: "b-2026-07-06-bbbb", stakes: "high" }),
    ];
    const before = feed.map((x) => x.decision_id);
    sortReviewFeed(feed);
    expect(feed.map((x) => x.decision_id)).toEqual(before);
  });
});
