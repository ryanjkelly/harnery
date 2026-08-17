import { describe, expect, test } from "bun:test";
import { type CritiqueProvider, type CritiqueTile, runCritique } from "./critique.ts";

function tile(index: number): CritiqueTile {
  return {
    index,
    label: `band ${index + 1}`,
    scrollY: index * 1000,
    width: 800,
    height: 1000,
    pngBase64: "",
  };
}

const TILES = [tile(0), tile(1), tile(2), tile(3), tile(4), tile(5)];

describe("runCritique concurrency", () => {
  test("runs tiles concurrently up to the provider's cap", async () => {
    let inFlight = 0;
    let peak = 0;
    const provider: CritiqueProvider = async ({ tile }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return [{ tile: tile.index, severity: "low", category: "x", description: `t${tile.index}` }];
    };
    provider.concurrency = 3;
    const res = await runCritique({ url: "u", rubric: "r", tiles: TILES, provider });
    expect(peak).toBe(3);
    expect(res.findings.length).toBe(6);
  });

  test("findings come back in tile order regardless of completion order", async () => {
    // Earlier tiles sleep longer, so they complete last.
    const provider: CritiqueProvider = async ({ tile }) => {
      await new Promise((r) => setTimeout(r, (TILES.length - tile.index) * 10));
      return [{ tile: tile.index, severity: "low", category: "x", description: `t${tile.index}` }];
    };
    provider.concurrency = 6;
    const res = await runCritique({ url: "u", rubric: "r", tiles: TILES, provider });
    expect(res.findings.map((f) => f.tile)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("one failing tile becomes a high finding without sinking the run", async () => {
    const provider: CritiqueProvider = async ({ tile }) => {
      if (tile.index === 2) throw new Error("boom");
      return [];
    };
    const res = await runCritique({ url: "u", rubric: "r", tiles: TILES, provider });
    expect(res.outcome).toBe("fail");
    const errs = res.findings.filter((f) => f.category === "provider-error");
    expect(errs.length).toBe(1);
    expect(errs[0].tile).toBe(2);
  });

  test("provider meta lands on the result envelope", async () => {
    const provider: CritiqueProvider = async () => [];
    provider.meta = () => ({ route: ["fake"], metered_tiles: 0 });
    const res = await runCritique({ url: "u", rubric: "r", tiles: TILES.slice(0, 2), provider });
    expect(res.provider_meta).toEqual({ route: ["fake"], metered_tiles: 0 });
    expect(res.outcome).toBe("pass");
  });

  test("no provider still reports skipped", async () => {
    const res = await runCritique({ url: "u", rubric: "r", tiles: TILES, provider: undefined });
    expect(res.outcome).toBe("skipped");
    expect(res.provider).toBe(false);
  });
});
