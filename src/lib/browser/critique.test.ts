import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";
import {
  addCritiqueUsage,
  type CritiqueProvider,
  type CritiqueTile,
  formatCritiqueUsage,
  runCritique,
  sumCritiqueUsage,
  tilesFromFullPage,
} from "./critique.ts";

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

function blankPage(width: number, height: number): Buffer {
  const img = new PNG({ width, height });
  img.data.fill(255);
  return PNG.sync.write(img);
}

describe("critique token usage", () => {
  test("a retried tile adds both calls; cost survives only when every call had one", () => {
    const once = addCritiqueUsage(undefined, {
      input_tokens: 100,
      output_tokens: 10,
      cost_usd: 0.01,
    });
    const twice = addCritiqueUsage(once, {
      input_tokens: 50,
      output_tokens: 5,
      cache_read_input_tokens: 40,
      cost_usd: 0.02,
    });
    expect(twice).toEqual({
      input_tokens: 150,
      output_tokens: 15,
      cache_read_input_tokens: 40,
      cost_usd: 0.03,
    });
    expect(addCritiqueUsage(twice, { input_tokens: 1, output_tokens: 1 }).cost_usd).toBeUndefined();
  });

  test("unreported tiles are counted, never treated as zero", () => {
    const totals = sumCritiqueUsage([
      { input_tokens: 1000, output_tokens: 200, cache_write_input_tokens: 800, cost_usd: 0.5 },
      undefined,
      { input_tokens: 3000, output_tokens: 100, cache_read_input_tokens: 2000, cost_usd: 0.25 },
    ]);
    expect(totals).toEqual({
      tiles_reported: 2,
      tiles_unreported: 1,
      input_tokens: 4000,
      output_tokens: 300,
      cache_read_input_tokens: 2000,
      cache_write_input_tokens: 800,
      cost_usd: 0.75,
    });
    expect(formatCritiqueUsage(totals)).toBe(
      "4,300 tokens over 2 tile(s) (1 unreported), $0.75 at list price",
    );
  });

  test("runCritique sums what the provider reports", async () => {
    const provider: CritiqueProvider = async ({ tile, reportUsage }) => {
      if (tile.index !== 1) reportUsage?.({ input_tokens: 500, output_tokens: 20 });
      return [];
    };
    const result = await runCritique({ url: "x", rubric: "r", tiles: TILES.slice(0, 3), provider });
    expect(result.usage).toMatchObject({
      tiles_reported: 2,
      tiles_unreported: 1,
      input_tokens: 1000,
      output_tokens: 40,
    });
  });
});

describe("per-invocation tile ceiling", () => {
  test("no maxTiles value or hit band list cuts more tiles than the ceiling", () => {
    // 200 bands of 100 px with no overlap; every band is a gate hit.
    const page = blankPage(10, 20_000);
    const { tiles } = tilesFromFullPage(page, {
      bandHeight: 100,
      overlap: 0,
      maxTiles: 500,
      hitRects: [{ x: 0, y: 0, width: 10, height: 20_000 }],
    });
    expect(tiles).toHaveLength(160);
    const capped = tilesFromFullPage(page, {
      bandHeight: 100,
      overlap: 0,
      maxTiles: 150,
      hitRects: [{ x: 0, y: 0, width: 10, height: 20_000 }],
    });
    expect(capped.hitBands).toBe(10);
    expect(capped.tiles).toHaveLength(160);
  });

  test("runCritique refuses a tile set above the ceiling without calling the provider", async () => {
    let calls = 0;
    const provider: CritiqueProvider = async () => {
      calls += 1;
      return [];
    };
    const result = await runCritique({
      url: "x",
      rubric: "r",
      tiles: Array.from({ length: 161 }, (_, i) => tile(i)),
      provider,
    });
    expect(calls).toBe(0);
    expect(result.outcome).toBe("skipped");
    expect(result.error).toContain("161 tiles exceed the per-invocation ceiling of 160");
  });
});

describe("tilesFromFullPage coverage", () => {
  test("an uncapped page reports full coverage", () => {
    const { tiles, coverage } = tilesFromFullPage(blankPage(400, 5000), {
      bandHeight: 1400,
      overlap: 120,
      maxTiles: 24,
    });
    expect(coverage.capped).toBe(false);
    expect(coverage.bands_total).toBe(tiles.length);
    expect(coverage.bands_reviewed).toBe(tiles.length);
    expect(coverage.page_height_px).toBe(5000);
    expect(coverage.reviewed_height_px).toBe(5000);
  });

  test("a capped page reports the dropped bands and the unreviewed tail", () => {
    const full = tilesFromFullPage(blankPage(400, 5000), {
      bandHeight: 1400,
      overlap: 120,
      maxTiles: 24,
    });
    const { tiles, coverage } = tilesFromFullPage(blankPage(400, 5000), {
      bandHeight: 1400,
      overlap: 120,
      maxTiles: 2,
    });
    expect(tiles).toHaveLength(2);
    expect(coverage.capped).toBe(true);
    expect(coverage.bands_total).toBe(full.coverage.bands_total);
    expect(coverage.bands_reviewed).toBe(2);
    expect(coverage.page_height_px).toBe(5000);
    expect(coverage.reviewed_height_px).toBeLessThan(5000);
    // Two bands of 1400 with a 120 overlap reach 1280 + 1400 px.
    expect(coverage.reviewed_height_px).toBe(2680);
  });

  test("hit rects below the cap add labelled hit bands after the kept prefix; coverage stays honest", () => {
    const { tiles, coverage, hitBands } = tilesFromFullPage(blankPage(400, 5000), {
      bandHeight: 1400,
      overlap: 120,
      maxTiles: 2,
      hitRects: [{ x: 10, y: 4000, width: 50, height: 10 }],
    });
    // Bands: 0..1400, 1280..2680, 2560..3960, 3840..5000. y=4000 lands in band 4 only.
    expect(tiles.map((t) => t.label)).toEqual(["band 1", "band 2", "hit band 4"]);
    expect(tiles[2]).toMatchObject({ index: 3, scrollY: 3840, height: 1160 });
    expect(hitBands).toBe(1);
    expect(coverage).toMatchObject({ bands_total: 4, bands_reviewed: 2, capped: true });
    // A hit inside the kept prefix adds nothing.
    const inside = tilesFromFullPage(blankPage(400, 5000), {
      bandHeight: 1400,
      overlap: 120,
      maxTiles: 2,
      hitRects: [{ x: 10, y: 100, width: 50, height: 10 }],
    });
    expect(inside.tiles).toHaveLength(2);
    expect(inside.hitBands).toBe(0);
  });
});

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

  test("result artifacts are identical across opposite completion orders", async () => {
    const run = async (reverse: boolean) => {
      const provider: CritiqueProvider = async ({ tile }) => {
        const order = reverse ? tile.index + 1 : TILES.length - tile.index;
        await new Promise((resolve) => setTimeout(resolve, order * 3));
        return [
          { tile: tile.index, severity: "low", category: "fixture", description: tile.label },
        ];
      };
      provider.concurrency = TILES.length;
      return await runCritique({ url: "u", rubric: "r", tiles: TILES, provider });
    };
    expect(await run(false)).toEqual(await run(true));
  });

  test("a metered cap of two is honored by the real worker pool", async () => {
    let inFlight = 0;
    let peak = 0;
    const provider: CritiqueProvider = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return [];
    };
    provider.concurrency = 2;
    await runCritique({ url: "u", rubric: "r", tiles: TILES, provider });
    expect(peak).toBe(2);
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
