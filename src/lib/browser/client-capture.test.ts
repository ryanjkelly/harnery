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

test("page-review readiness accepts finite late head initialization within the deadline", async () => {
  const profile = mkdtempSync(join(tmpdir(), "native-readiness-finite-"));
  profiles.push(profile);
  const browser = new Browser({
    profileDir: profile,
    viewport: { width: 320, height: 240 },
    jar: null,
  });
  try {
    await browser.open();
    await browser.currentPage.setContent(
      '<p>Ready</p><script>let frame=0;function change(){if(frame++<150){const link=document.createElement("link");link.rel="prefetch";link.href=`/late-${frame}.js`;document.head.append(link);requestAnimationFrame(change);}}requestAnimationFrame(change);</script>',
    );
    await browser.waitForReviewReady(5_000);
  } finally {
    await browser.close();
  }
}, 20_000);

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
    await expect(browser.waitForReviewReady(250)).rejects.toThrow("did not settle");
    await expect(browser.waitForReviewReady(0)).rejects.toThrow("timeoutMs");
    await expect(browser.waitForReviewReady(60_001)).rejects.toThrow("timeoutMs");
  } finally {
    await browser.close();
  }
}, 15000);

for (const dpr of [1, 2])
  test(`native bottom capture rejects stale geometry and preserves the last real row at DPR ${dpr}`, async () => {
    const profile = mkdtempSync(join(tmpdir(), "native-lazy-boundary-"));
    profiles.push(profile);
    const browser = new Browser({
      profileDir: profile,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: dpr,
      jar: null,
    });
    try {
      await browser.open();
      await browser.currentPage.setContent(
        `<!doctype html><style>html,body{margin:0}main{height:8303px}img{display:block;width:180px;height:auto}</style><main></main><img loading="lazy" width="360" height="144" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='71'%3E%3Crect width='180' height='71' fill='red'/%3E%3C/svg%3E">`,
      );
      await browser.waitForReviewReady();
      expect((await browser.pageMetrics()).scrollHeight).toBe(8375);
      let failure: unknown;
      try {
        await browser.captureRegionByScroll({ x: 0, y: 6889, width: 390, height: 1486 });
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain("document y 8374 is not reachable");
      expect((await browser.pageMetrics()).scrollHeight).toBe(8374);
      expect(await browser.currentPage.evaluate(() => scrollY)).toBe(0);
      const image = PNG.sync.read(
        await browser.captureRegionByScroll({ x: 0, y: 6889, width: 390, height: 1485 }),
      );
      expect({ width: image.width, height: image.height }).toEqual({
        width: 390 * dpr,
        height: 1485 * dpr,
      });
      const lastPixel = ((image.height - 1) * image.width + 30 * dpr) * 4;
      expect([...image.data.subarray(lastPixel, lastPixel + 4)]).toEqual([255, 0, 0, 255]);
      await expect(
        browser.captureRegionByScroll({ x: 0, y: 8374, width: 390, height: 1 }),
      ).rejects.toThrow("not reachable");
      expect(await browser.currentPage.evaluate(() => scrollY)).toBe(0);
    } finally {
      await browser.close();
    }
  }, 15000);

test("stitched captures suppress nested shadow fixed controls without hiding static content", async () => {
  const profile = mkdtempSync(join(tmpdir(), "native-shadow-pinned-"));
  profiles.push(profile);
  const browser = new Browser({
    profileDir: profile,
    viewport: { width: 320, height: 240 },
    jar: null,
  });
  try {
    await browser.open();
    await browser.currentPage.setContent(
      "<!doctype html><style>html,body{margin:0;background:white}body{height:960px}</style><div id='outer'></div>",
    );
    await browser.currentPage.evaluate(() => {
      const outer = document.querySelector("#outer")!.attachShadow({ mode: "open" });
      const inner = document.createElement("div");
      inner.id = "inner";
      outer.append(inner);
      const shadow = inner.attachShadow({ mode: "open" });
      shadow.innerHTML = `<style>.content{position:absolute;top:400px;left:30px;width:30px;height:30px;background:blue}.launcher{position:fixed;bottom:10px;right:10px;width:30px;height:30px;background:red}</style><div class="content"></div><div class="launcher" style="opacity: 1 !important; transition: opacity 1s !important;"></div>`;
      scrollTo(0, 120);
    });
    const state = () =>
      browser.currentPage.evaluate(() => {
        const host = document.querySelector("#outer")!;
        const inner = host.shadowRoot!.querySelector("#inner")!;
        const launcher = inner.shadowRoot!.querySelector(".launcher") as HTMLElement;
        return {
          scroll: scrollY,
          hostStyle: host.getAttribute("style"),
          innerStyle: inner.getAttribute("style"),
          launcherStyle: launcher.getAttribute("style"),
          opacity: getComputedStyle(launcher).opacity,
        };
      });
    const before = await state();
    const shots = await browser.captureRegionsByScroll([
      { x: 0, y: 0, width: 320, height: 720 },
      { x: 0, y: 720, width: 320, height: 240 },
    ]);
    const colorCount = (image: PNG, color: number[]) => {
      let count = 0;
      for (let i = 0; i < image.data.length; i += 4)
        if (color.every((channel, j) => image.data[i + j] === channel)) count++;
      return count;
    };
    const first = PNG.sync.read(shots[0]);
    expect({ width: first.width, height: first.height }).toEqual({ width: 320, height: 720 });
    expect(colorCount(first, [255, 0, 0, 255])).toBe(900);
    expect(colorCount(first, [0, 0, 255, 255])).toBe(900);
    expect(colorCount(PNG.sync.read(shots[1]), [255, 0, 0, 255])).toBe(0);
    expect(await state()).toEqual(before);
    let failure: unknown;
    try {
      await browser.captureRegionByScroll({ x: 0, y: 2000, width: 320, height: 100 });
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("not reachable");
    expect(await state()).toEqual(before);
  } finally {
    await browser.close();
  }
}, 30000);
