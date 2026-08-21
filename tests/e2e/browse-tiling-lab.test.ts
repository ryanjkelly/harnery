import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Browser } from "../../src/lib/browser/client.ts";
import { bandOversizedRect, snappedBandRects } from "../../src/lib/browser/tiling.ts";

const fixtureUrl = pathToFileURL(resolve(import.meta.dir, "../fixtures/tiling-lab/index.html")).href;
const profiles: string[] = [];

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), "harnery-tiling-lab-"));
  profiles.push(path);
  return path;
}

afterEach(() => {
  for (const path of profiles.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("tiling lab regression fixture", () => {
  test("content-aware seams avoid hard atoms and split the over-tall chart", async () => {
    const browser = new Browser({ profileDir: profile(), viewport: { width: 1280, height: 800 } });
    try {
      await browser.open();
      await browser.navigate(fixtureUrl);
      const metrics = await browser.pageMetrics();
      const atoms = await browser.visualAtoms();
      const plan = snappedBandRects(0, metrics.scrollHeight, 0, metrics.scrollWidth, atoms, {
        bandHeight: 1400,
        overlap: 120,
      });
      expect(plan.rects.length).toBeGreaterThan(4);
      expect(plan.seams.filter((seam) => seam.hard > 0).length).toBeLessThanOrEqual(1);
      for (const rect of plan.rects.slice(0, -1)) {
        expect(rect.height).toBeGreaterThanOrEqual(700);
        expect(rect.height).toBeLessThanOrEqual(1400);
      }

      const [chart] = await browser.elementTiles("#tall-chart");
      expect(chart.height).toBeGreaterThan(1750);
      const parts = bandOversizedRect(chart, atoms, { bandHeight: 1400, overlap: 120 });
      expect(parts.length).toBe(2);
      expect(parts[0].label).toContain("(1/2)");
      expect(parts[1].y + parts[1].height).toBeCloseTo(chart.y + chart.height, 3);
      for (const part of parts) expect(part.height).toBeLessThanOrEqual(1400);
    } finally {
      await browser.close();
    }
  });
});
