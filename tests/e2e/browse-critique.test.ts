import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { Browser } from "../../src/lib/browser/client.ts";
import {
  bandRects,
  type CritiqueProvider,
  normalizeFindings,
  runCritique,
  tilesFromFullPage,
} from "../../src/lib/browser/critique.ts";

/** A solid-color full-page PNG buffer for crop tests. */
function fakePagePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(200); // opaque gray
  return PNG.sync.write(png);
}

const fixtureUrl = pathToFileURL(
  resolve(import.meta.dir, "../fixtures/content-checks/index.html"),
).href;
const profiles: string[] = [];

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), "harnery-critique-"));
  profiles.push(path);
  return path;
}

afterEach(() => {
  for (const path of profiles.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("critique tiling + orchestration", () => {
  test("bandRects covers the full height with overlap and no gaps", () => {
    const bands = bandRects(3000, 800, 1400, 120);
    expect(bands.length).toBeGreaterThan(1);
    expect(bands[0]?.y).toBe(0);
    // Last band reaches the bottom.
    const last = bands[bands.length - 1]!;
    expect(last.y + last.height).toBe(3000);
    // Consecutive bands overlap (next.y < prev.y + prev.height).
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.y).toBeLessThan(bands[i - 1]!.y + bands[i - 1]!.height);
    }
  });

  test("tilesFromFullPage bands a tall page from the image (below-fold safe)", () => {
    // A 3000px-tall page far exceeds any viewport — the old viewport-relative
    // clip threw here; cropping from the full-page buffer must not.
    const buf = fakePagePng(400, 3000);
    const { tiles, coverage } = tilesFromFullPage(buf, {
      bandHeight: 1400,
      overlap: 120,
      maxTiles: 24,
    });
    expect(tiles.length).toBeGreaterThan(1);
    expect(coverage.capped).toBe(false);
    expect(coverage.reviewed_height_px).toBe(3000);
    expect(tiles[0]?.scrollY).toBe(0);
    // Tiles advance down the page and each crop decodes to its declared size.
    for (let i = 1; i < tiles.length; i++) {
      expect(tiles[i]!.scrollY).toBeGreaterThan(tiles[i - 1]!.scrollY);
    }
    const decoded = PNG.sync.read(Buffer.from(tiles[0]!.pngBase64, "base64"));
    expect(decoded.width).toBe(400);
    expect(decoded.height).toBe(tiles[0]!.height);
  });

  test("tilesFromFullPage honors elementRects + maxTiles cap", () => {
    const buf = fakePagePng(400, 3000);
    const rects = [
      { label: "div.a", x: 0, y: 10, width: 400, height: 100 },
      { label: "div.b", x: 0, y: 2500, width: 400, height: 100 }, // below fold
      { label: "div.c", x: 0, y: 2800, width: 400, height: 100 },
    ];
    const { tiles, coverage } = tilesFromFullPage(buf, { elementRects: rects, maxTiles: 2 });
    expect(tiles).toHaveLength(2); // capped
    expect(coverage).toMatchObject({ bands_total: 3, bands_reviewed: 2, capped: true });
    expect(tiles[0]?.label).toBe("div.a");
    expect(tiles[1]?.scrollY).toBe(2500); // below-fold element cropped fine
  });

  test("normalizeFindings tolerates array, wrapper, and junk", () => {
    const a = normalizeFindings([{ severity: "high", description: "cut off" }], 2);
    expect(a).toEqual([{ tile: 2, severity: "high", category: "visual", description: "cut off" }]);
    const b = normalizeFindings({ findings: [{ description: "x", category: "spacing" }] }, 0);
    expect(b[0]?.severity).toBe("low"); // default
    expect(b[0]?.category).toBe("spacing");
    expect(normalizeFindings("nonsense", 0)).toEqual([]);
    expect(normalizeFindings([{ severity: "high" }], 0)).toEqual([]); // no description → dropped
  });

  test("runCritique aggregates findings and fails on a high finding", async () => {
    const provider: CritiqueProvider = async ({ tile }) =>
      tile.index === 0
        ? [{ tile: 0, severity: "high", category: "overlap", description: "boom" }]
        : [];
    const tiles = [0, 1].map((index) => ({
      index,
      label: `band ${index}`,
      scrollY: index * 100,
      width: 10,
      height: 10,
      pngBase64: "",
    }));
    const result = await runCritique({ url: "x", rubric: "r", tiles, provider });
    expect(result.outcome).toBe("fail");
    expect(result.findings).toHaveLength(1);
    expect(result.provider).toBe(true);
  });

  test("runCritique reports skipped with no provider (never a false pass)", async () => {
    const result = await runCritique({ url: "x", rubric: "r", tiles: [], provider: undefined });
    expect(result.outcome).toBe("skipped");
    expect(result.provider).toBe(false);
    expect(result.error).toContain("critiqueProvider");
  });

  test("a provider throw becomes a high error finding, not an abort", async () => {
    const provider: CritiqueProvider = async () => {
      throw new Error("model down");
    };
    const tiles = [{ index: 0, label: "band 0", scrollY: 0, width: 10, height: 10, pngBase64: "" }];
    const result = await runCritique({ url: "x", rubric: "r", tiles, provider });
    expect(result.outcome).toBe("fail");
    expect(result.findings[0]?.category).toBe("provider-error");
  });

  // Chromium cold-start on GHA is flaky (release CI #67/#69 hit Bun's 5s
  // default; #71 hung the full navigation budget). An internal budget lets
  // `finally` close the browser before Bun's uncatchable test-timeout kills
  // the fiber — otherwise a wedged Chromium survives into the retry and
  // every attempt hangs. Prefer domcontentloaded for the local fixture.
  test(
    "Browser tiling: metrics + clip screenshot + element tiles",
    async () => {
      const browser = new Browser({
        profileDir: profile(),
        viewport: { width: 800, height: 600 },
        waitUntil: "domcontentloaded",
        navigationTimeout: 10_000,
        launchTimeout: 10_000,
      });
      const budgetMs = 25_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await browser.open();
            await browser.navigate(fixtureUrl);
            const m = await browser.pageMetrics();
            expect(m.scrollHeight).toBeGreaterThan(0);
            const png = await browser.screenshotClipBase64({
              x: 0,
              y: 0,
              width: 200,
              height: 100,
            });
            expect(png.length).toBeGreaterThan(100); // non-empty base64
            const tiles = await browser.elementTiles("section");
            expect(tiles.length).toBeGreaterThan(0);
            expect(tiles[0]?.width).toBeGreaterThan(0);
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`browser tiling budget exceeded (${budgetMs}ms)`)),
              budgetMs,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        await browser.close();
      }
    },
    { timeout: 60_000, retry: 1 },
  );

  test("CLI --check-critique reports skipped when no provider is injected", () => {
    const result = Bun.spawnSync({
      cmd: [
        resolve(import.meta.dir, "../../bin/harn"),
        "browse",
        fixtureUrl,
        "--json",
        "--no-cookies",
        "--profile",
        profile(),
        "--check-critique",
        "--check-critique-fail",
      ],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const stdout = result.stdout.toString();
    expect(stdout).toContain('"critique"');
    expect(stdout).toContain('"skipped"');
    // A fail gate cannot certify a visual review that never ran.
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("check-critique FAIL");
  });
});
