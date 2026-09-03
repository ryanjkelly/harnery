import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { compareBand, cropNativePng, pngDimensions } from "./capture-fidelity.ts";
import { Browser } from "./client.ts";

const profiles: string[] = [];
afterEach(() => {
  for (const p of profiles.splice(0)) rmSync(p, { recursive: true, force: true });
});

for (const dpr of [1, 2])
  test(`grouped native scroll capture preserves seams and restores pinned styles at DPR ${dpr}`, async () => {
    const profile = mkdtempSync(join(tmpdir(), "native-capture-"));
    profiles.push(profile);
    const browser = new Browser({
      profileDir: profile,
      viewport: { width: 320, height: 240 },
      deviceScaleFactor: dpr,
      jar: null,
    });
    try {
      await browser.open();
      await browser.currentPage.setContent(
        "<style>html,body{margin:0}body{height:2400px;background:linear-gradient(#fff,#124)}header{position:fixed;top:0;left:0;width:320px;height:30px;background:red;opacity:0.8;transition:opacity 1s}</style><header>pinned</header>",
      );
      const full = PNG.sync.read(await browser.fullPageScreenshotBuffer());
      await browser.currentPage.evaluate(() => scrollTo(0, 100));
      const prior = await browser.currentPage.evaluate(() => ({
        y: scrollY,
        style: document.querySelector("header")!.getAttribute("style"),
      }));
      const rects = [
        { x: 0, y: 0, width: 320, height: 480 },
        { x: 0, y: 960, width: 320, height: 480 },
        { x: 0, y: 1920, width: 320, height: 480 },
      ];
      const shots = await browser.captureRegionsByScroll(rects);
      for (const [i, shot] of shots.entries()) {
        expect(pngDimensions(shot)).toEqual({ width: 320 * dpr, height: 480 * dpr });
        const r = rects[i];
        const crop = PNG.sync.read(
          cropNativePng(full, { x: 0, y: r.y * dpr, width: r.width * dpr, height: r.height * dpr }),
        );
        expect(compareBand(crop, PNG.sync.read(shot)).mismatch_ratio).toBeLessThan(0.001);
      }
      expect(await browser.currentPage.evaluate(() => scrollY)).toBe(prior.y);
      expect(
        await browser.currentPage.evaluate(() => document.querySelector("header")!.style.opacity),
      ).toBe("");
      expect(
        await browser.currentPage.evaluate(
          () => getComputedStyle(document.querySelector("header")!).opacity,
        ),
      ).toBe("0.8");
      await expect(
        browser.captureRegionsByScroll([{ x: 0, y: 4000, width: 320, height: 100 }]),
      ).rejects.toThrow("not reachable");
      expect(await browser.currentPage.evaluate(() => scrollY)).toBe(prior.y);
      expect(
        await browser.currentPage.evaluate(
          () => getComputedStyle(document.querySelector("header")!).opacity,
        ),
      ).toBe("0.8");
    } finally {
      await browser.close();
    }
  }, 30000);

test("page-review readiness refuses a continuously changing DOM", async () => {
  const profile = mkdtempSync(join(tmpdir(), "native-readiness-"));
  profiles.push(profile);
  const browser = new Browser({
    profileDir: profile,
    viewport: { width: 320, height: 240 },
    jar: null,
  });
  try {
    await browser.open();
    await browser.currentPage.setContent(
      '<p>Loading</p><script>let frame=0;function change(){document.querySelector("p").setAttribute("data-frame",String(frame++));requestAnimationFrame(change);}requestAnimationFrame(change);</script>',
    );
    await expect(browser.waitForReviewReady()).rejects.toThrow("did not settle");
  } finally {
    await browser.close();
  }
}, 15000);
