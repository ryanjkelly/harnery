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

/**
 * Settle a browser call before asserting on its rejection. Bun's
 * `expect(pending).rejects` waits on the promise from a nested event loop that
 * services the Playwright connection slowly: a refused capture took about 8 s
 * that way and 0.26 s when awaited first, enough to time these tests out under load.
 */
async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String(error);
  }
  throw new Error("Expected the browser call to reject.");
}

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
        await browser.currentPage.evaluate(() =>
          document.querySelector("header")!.getAttribute("style"),
        ),
      ).toBe(prior.style);
      expect(
        await browser.currentPage.evaluate(() => document.querySelector("header")!.style.opacity),
      ).toBe("");
      expect(
        await browser.currentPage.evaluate(
          () => getComputedStyle(document.querySelector("header")!).opacity,
        ),
      ).toBe("0.8");
      expect(
        await rejectionOf(
          browser.captureRegionsByScroll([{ x: 0, y: 4000, width: 320, height: 100 }]),
        ),
      ).toContain("not reachable");
      expect(await browser.currentPage.evaluate(() => scrollY)).toBe(prior.y);
      expect(
        await browser.currentPage.evaluate(() =>
          document.querySelector("header")!.getAttribute("style"),
        ),
      ).toBe(prior.style);
      expect(
        await browser.currentPage.evaluate(
          () => getComputedStyle(document.querySelector("header")!).opacity,
        ),
      ).toBe("0.8");
    } finally {
      await browser.close();
    }
  }, 30000);

test("native capture restores exact source after deferred scroll effects finish", async () => {
  const profile = mkdtempSync(join(tmpdir(), "native-source-restore-"));
  profiles.push(profile);
  const browser = new Browser({
    profileDir: profile,
    viewport: { width: 320, height: 240 },
    jar: null,
  });
  try {
    await browser.open();
    await browser.currentPage.setContent(`<!doctype html>
      <style>html,body{margin:0}body{height:960px}header{position:fixed;top:0}</style>
      <header><span data-position="top">Top</span></header>
      <script>addEventListener("scroll",()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
        const status=document.querySelector("span");
        status.dataset.position=scrollY===0?"top":"away";
        status.textContent=scrollY===0?"Top":"Away";
      })));</script>`);
    await browser.waitForReviewReady();
    const before = await browser.qaSignature();
    await browser.captureRegionsByScroll([
      { x: 0, y: 0, width: 320, height: 480 },
      { x: 0, y: 480, width: 320, height: 480 },
    ]);
    expect(await browser.currentPage.evaluate(() => scrollY)).toBe(0);
    expect(await browser.qaSignature()).toEqual(before);
  } finally {
    await browser.close();
  }
}, 15000);

test("native capture preserves a concurrent page style mutation for source refusal", async () => {
  const profile = mkdtempSync(join(tmpdir(), "native-source-mutation-"));
  profiles.push(profile);
  const browser = new Browser({
    profileDir: profile,
    viewport: { width: 320, height: 240 },
    jar: null,
  });
  try {
    await browser.open();
    await browser.currentPage.setContent(
      '<style>html,body{margin:0}body{height:960px}header{position:fixed;top:0}</style><header style="color: red">Pinned</header>',
    );
    await browser.waitForReviewReady();
    const before = await browser.qaSignature();
    const page = browser.currentPage;
    const screenshot = page.screenshot.bind(page);
    let changed = false;
    page.screenshot = async (options) => {
      if (!changed && (await page.evaluate(() => scrollY)) > 0) {
        changed = true;
        await page.evaluate(() => {
          document.querySelector("header")!.style.setProperty("color", "blue", "important");
        });
      }
      return screenshot(options);
    };
    expect(
      await rejectionOf(browser.captureRegionByScroll({ x: 0, y: 240, width: 320, height: 480 })),
    ).toContain("Pinned styles changed");
    expect(changed).toBe(true);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(await page.evaluate(() => document.querySelector("header")!.style.color)).toBe("blue");
    expect(await page.evaluate(() => document.querySelector("header")!.style.opacity)).toBe("");
    expect(await browser.qaSignature()).not.toEqual(before);
  } finally {
    await browser.close();
  }
}, 15000);

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
    expect(await rejectionOf(browser.waitForReviewReady(250))).toContain("did not settle");
    expect(await rejectionOf(browser.waitForReviewReady(0))).toContain("timeoutMs");
    expect(await rejectionOf(browser.waitForReviewReady(60_001))).toContain("timeoutMs");
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
      expect(
        await rejectionOf(
          browser.captureRegionByScroll({ x: 0, y: 6889, width: 390, height: 1486 }),
        ),
      ).toContain("document y 8374 is not reachable");
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
      expect(
        await rejectionOf(browser.captureRegionByScroll({ x: 0, y: 8374, width: 390, height: 1 })),
      ).toContain("not reachable");
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
    expect(
      await rejectionOf(browser.captureRegionByScroll({ x: 0, y: 2000, width: 320, height: 100 })),
    ).toContain("not reachable");
    expect(await state()).toEqual(before);
  } finally {
    await browser.close();
  }
}, 30000);
