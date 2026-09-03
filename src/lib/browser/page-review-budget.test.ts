import { describe, expect, test } from "bun:test";
import {
  allocateTileBudget,
  allocationCoverage,
  validatePageReviewAllocation,
  validatePageReviewCapturePlan,
} from "./page-review-budget.ts";
import {
  PAGE_REVIEW_CAPTURE_PLAN_SCHEMA,
  type PageReviewCapturePlan,
} from "./page-review-contracts.ts";

function plan(id: string, count = 10): PageReviewCapturePlan {
  return {
    schema: PAGE_REVIEW_CAPTURE_PLAN_SCHEMA,
    context_id: id,
    viewport: "desktop",
    viewport_width: 100,
    viewport_height: 100,
    theme: "light",
    state: "default",
    dpr: 1,
    page_width: 100,
    page_height: count * 100,
    source_digest: "source",
    recipe_version: "v2",
    required_scopes: [],
    candidates: Array.from({ length: count }, (_, i) => ({
      id: `b${i}`,
      index: i,
      label: `band ${i}`,
      rect: { x: 0, y: i * 100, width: 100, height: 100 },
      gate_hits: [],
    })),
  };
}

describe("page review tile budget", () => {
  test("reserves every context's edges and refuses insufficient budget", () => {
    expect(() => allocateTileBudget([plan("b"), plan("a")], 3)).toThrow("at least 4");
    const a = allocateTileBudget([plan("b"), plan("a")], 4);
    expect(a.used).toBe(4);
    expect(a.contexts.map((c) => [c.context_id, c.selected_ids])).toEqual([
      ["a", ["b0", "b9"]],
      ["b", ["b0", "b9"]],
    ]);
  });
  test("deduplicates one-band edges", () => {
    expect(allocateTileBudget([plan("a", 1)], 1).used).toBe(1);
  });
  test("fails an insufficient ceiling before allocating", () => {
    expect(() => allocateTileBudget([plan("a")], 8, { a: 1 })).toThrow("ceiling of at least 2");
  });
  test("ranks hits by severity and never captures over-budget extras", () => {
    const a = plan("a");
    a.candidates[2].gate_hits = [{ check_id: "medium", severity: "medium" }];
    a.candidates[8].gate_hits = [{ check_id: "critical", severity: "critical" }];
    a.candidates[5].gate_hits = [{ check_id: "high", severity: "high" }];
    const r = allocateTileBudget([a], 4).contexts[0];
    expect(r.selected_ids).toEqual(["b0", "b5", "b8", "b9"]);
    expect(r.coverage.omitted_gate_hits).toEqual(["medium"]);
    expect(r.omitted_candidates.every((c) => c.reason === "budget")).toBe(true);
  });
  test("stable context and document tie breaks for hits", () => {
    const a = plan("a"),
      b = plan("b");
    for (const p of [a, b])
      for (const i of [7, 3])
        p.candidates[i].gate_hits = [{ check_id: `${p.context_id}${i}`, severity: "high" }];
    const r = allocateTileBudget([b, a], 5);
    expect(r.contexts[0].selected_ids).toEqual(["b0", "b3", "b9"]);
    expect(r.used).toBe(5);
  });
  test("proportional allocation is stable under input order", () => {
    const a = plan("a", 12),
      b = plan("b", 6);
    const r = allocateTileBudget([a, b], 10);
    expect(allocateTileBudget([b, a], 10)).toEqual(r);
    expect(r.contexts.map((c) => c.selected_ids.length)).toEqual([6, 4]);
  });
  test("redistributes when one context saturates its ceiling", () => {
    const r = allocateTileBudget([plan("a", 20), plan("b", 20)], 12, { a: 3 });
    expect(r.contexts.map((c) => c.selected_ids.length)).toEqual([3, 9]);
    expect(r.used).toBe(12);
    expect(r.contexts[0].omitted_candidates.every((c) => c.reason === "ceiling")).toBe(true);
  });
  test("a context may exceed the old 24-tile cap", () => {
    expect(allocateTileBudget([plan("a", 100)], 96).contexts[0].selected_ids).toHaveLength(96);
  });
  test("scopes consume the same budget and missing scopes are explicit", () => {
    const p = plan("a", 2);
    p.required_scopes = [".card", ".missing"];
    p.candidates.push({
      id: "scope",
      index: 2,
      label: "card",
      scope: ".card",
      rect: { x: 10, y: 10, width: 20, height: 30 },
      gate_hits: [],
    });
    const small = allocateTileBudget([p], 2).contexts[0];
    expect(small.coverage.omitted_scopes).toEqual([".card", ".missing"]);
    const large = allocateTileBudget([p], 3).contexts[0];
    expect(large.coverage.omitted_scopes).toEqual([".missing"]);
    expect(large.coverage.capped).toBe(true);
    expect(large.selected_ids).toHaveLength(3);
  });
  test("union never double counts overlaps; gaps remain explicit", () => {
    const p = plan("a", 4);
    p.candidates[0].rect.height = 150;
    p.candidates[1].rect.y = 100;
    const c = allocationCoverage(p, ["b0", "b1", "b3"]);
    expect(c.reviewed_intervals).toEqual([
      { start: 0, end: 200 },
      { start: 300, end: 400 },
    ]);
    expect(c.uncovered_intervals).toEqual([{ start: 200, end: 300 }]);
    expect(c.reviewed_height_px).toBe(300);
  });
  test("a scoped rectangle cannot fill a full-width coverage gap", () => {
    const p = plan("a", 3);
    p.candidates.push({
      id: "scope",
      index: 3,
      label: "scope",
      scope: ".x",
      rect: { x: 10, y: 100, width: 20, height: 100 },
      gate_hits: [],
    });
    expect(allocationCoverage(p, ["b0", "b2", "scope"]).uncovered_intervals).toEqual([
      { start: 100, end: 200 },
    ]);
  });
  test("unknown budget, duplicate contexts and malformed plans fail closed", () => {
    for (const budget of [0, 1.1, 401, NaN])
      expect(() => allocateTileBudget([plan("a")], budget)).toThrow();
    expect(() => allocateTileBudget([plan("a"), plan("a")])).toThrow("Duplicate");
    expect(() => validatePageReviewCapturePlan({})).toThrow("schema");
    const p = plan("a");
    p.candidates[1].id = "b0";
    expect(() => validatePageReviewCapturePlan(p)).toThrow("duplicate");
  });
  test("capture rejects source, geometry, DPR, recipe and selected-ID drift", () => {
    const p = plan("a"),
      a = allocateTileBudget([p], 4).contexts[0];
    expect(validatePageReviewAllocation(a, p)).toEqual(a);
    for (const altered of [
      { ...p, source_digest: "changed" },
      { ...p, dpr: 2 },
      { ...p, recipe_version: "v3" },
      { ...p, page_height: 1001 },
    ])
      expect(() => validatePageReviewAllocation(a, altered)).toThrow("changed");
    expect(() => validatePageReviewAllocation({ ...a, selected_ids: ["missing"] }, p)).toThrow(
      "IDs",
    );
    expect(() => validatePageReviewAllocation({ ...a, ceiling: 1 }, p)).toThrow("ceiling");
    expect(() =>
      validatePageReviewAllocation(
        { ...a, coverage: { ...a.coverage, reviewed_height_px: 999 } },
        p,
      ),
    ).toThrow("coverage");
  });
  test("gate associations do not invalidate the render geometry signature", () => {
    const p = plan("a");
    p.candidates[3].gate_hits = [{ check_id: "x", severity: "high" }];
    const a = allocateTileBudget([p], 3).contexts[0];
    const current = structuredClone(p);
    current.candidates.forEach((c) => {
      c.gate_hits = [];
    });
    expect(validatePageReviewAllocation(a, current).coverage).toEqual(a.coverage);
  });
});
