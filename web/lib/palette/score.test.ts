import { describe, expect, test } from "bun:test";

import { makePaletteScorer, matchesPaletteQuery, paletteMatchIndices } from "./score";

function scorer(q: string) {
  return makePaletteScorer(q, q.split(/\s+/).filter(Boolean));
}

describe("makePaletteScorer tiers", () => {
  const s = scorer("goal");

  test("exact > prefix > word boundary > substring > description > fallback", () => {
    const exact = s({ label: "goal" });
    const prefix = s({ label: "goal sweep — background service" });
    const word = s({ label: "durable goal graph" });
    const substr = s({ label: "ungoaled" });
    const desc = s({ label: "Unrelated", description: "goal things" });
    const kw = s({ label: "Unrelated", description: "also unrelated" }); // matched via keywords
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(substr);
    expect(substr).toBeGreaterThan(desc);
    expect(desc).toBeGreaterThan(kw);
  });

  test("multi-token queries fall back to all-tokens-in-label", () => {
    const multi = makePaletteScorer("durable goal", ["durable", "goal"]);
    const allTokens = multi({ label: "goal graph — durable missions" }); // both tokens, not as a phrase
    const descOnly = multi({ label: "Unrelated", description: "the durable goal flow" });
    expect(allTokens).toBeGreaterThan(descOnly);
  });

  test("regex-special characters in the query are safe", () => {
    const plus = scorer("c++");
    expect(() => plus({ label: "C++ style" })).not.toThrow();
    expect(plus({ label: "C++ style" })).toBeGreaterThan(plus({ label: "Unrelated" }));
  });
});

describe("matchesPaletteQuery", () => {
  test("matches fuzzy path characters in order", () => {
    expect(matchesPaletteQuery("explainers/active-work.html", ["expactive.html"])).toBe(true);
  });

  test("rejects characters that only appear out of order", () => {
    expect(matchesPaletteQuery("explainers/active-work.html", ["active.exp"])).toBe(false);
  });

  test("returns boundary-aware character positions for compact UI highlighting", () => {
    expect(paletteMatchIndices("explainers/active-work.html", ["expactive.html"])).toEqual([
      0, 1, 2, 11, 12, 13, 14, 15, 16, 22, 23, 24, 25, 26,
    ]);
  });
});

describe("priority hint", () => {
  test("clamped to 0–10", () => {
    const s = scorer("goal");
    const base = s({ label: "goal sweep" }); // prefix tier, no priority
    expect(s({ label: "goal sweep", priority: 25 }) - base).toBe(10);
    expect(s({ label: "goal sweep", priority: -5 })).toBe(base);
  });

  test("priority reorders adjacent title tiers but never beats an exact match", () => {
    const s = scorer("goal");
    const stalePrefix = s({ label: "Goal Archive Index", priority: 0 });
    const freshWord = s({ label: "the running goal graph", priority: 10 });
    expect(freshWord).toBeGreaterThan(stalePrefix);
    const exact = s({ label: "goal" });
    expect(s({ label: "goal sweep", priority: 10 })).toBeLessThan(exact);
  });
});
