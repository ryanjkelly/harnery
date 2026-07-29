import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Browser } from "../../src/lib/browser/client.ts";
import {
  bandRects,
  type CritiqueProvider,
  normalizeFindings,
  runCritique,
} from "../../src/lib/browser/critique.ts";

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

  test("Browser tiling: metrics + clip screenshot + element tiles", async () => {
    const browser = new Browser({ profileDir: profile(), viewport: { width: 800, height: 600 } });
    try {
      await browser.open();
      await browser.navigate(fixtureUrl);
      const m = await browser.pageMetrics();
      expect(m.scrollHeight).toBeGreaterThan(0);
      const png = await browser.screenshotClipBase64({ x: 0, y: 0, width: 200, height: 100 });
      expect(png.length).toBeGreaterThan(100); // non-empty base64
      const tiles = await browser.elementTiles("section");
      expect(tiles.length).toBeGreaterThan(0);
      expect(tiles[0]?.width).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });

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
    // skipped is not a failure — the gate only fires on outcome "fail".
    expect(result.exitCode).toBe(0);
  });
});
