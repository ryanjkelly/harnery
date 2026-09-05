/** bun scripts/thumbnail-browser-benchmark.ts <managed-output-dir> <base-url> [fixture-source-dir] */
import { copyFile, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { coordRoot } from "../lib/coord-reader";

interface PaintSample {
  restoredFromBackForwardCache: boolean;
  listingMs: number | null;
  initialVisible: string[];
  decoded: Record<string, number>;
  firstVisibleDecodedMs: number | null;
  firstVisiblePaintOpportunityMs: number | null;
  allVisibleDecodedMs: number | null;
  allVisiblePaintOpportunityMs: number | null;
  nearby: string[];
}
declare global {
  interface Window {
    __thumbnailBenchmark: PaintSample;
  }
}

const [directory, baseUrl, sourceDirectory] = process.argv.slice(2);
if (!directory || !baseUrl)
  throw new Error("Provide a managed output directory and the running dashboard base URL.");
const root = path.resolve(coordRoot());
const output = path.resolve(directory);
const relative = path.relative(root, output);
if (
  !relative.startsWith(`.harnery${path.sep}artifacts${path.sep}`) ||
  relative.split(path.sep).includes("..")
) {
  throw new Error("Benchmark output must be inside a managed .harnery/artifacts workspace.");
}
await mkdir(output, { recursive: true });
const fixtures = await mkdtemp(path.join(output, "browser-fixtures-"));
if (sourceDirectory) {
  const names = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(png|jpe?g|webp|svg|mp4|webm|wav|pdf|rtf|docx?|pptx?|xlsx?|json|md|csv|txt|log|html|ts)$/i.test(
          entry.name,
        ),
    )
    .slice(0, 24);
  for (const entry of names) {
    const source = path.join(sourceDirectory, entry.name);
    if ((await stat(source)).size > 128 * 1024 * 1024) continue;
    await copyFile(source, path.join(fixtures, entry.name));
  }
} else {
  const samples = [
    [
      "json",
      JSON.stringify(
        {
          title: "Sequence",
          frames: Array.from({ length: 6 }, (_, frame) => ({
            frame,
            direction: "Follow the moving subject",
          })),
        },
        null,
        2,
      ),
    ],
    [
      "md",
      "# Rendered document\n\nA benchmark of visible thumbnails.\n\n## Files\n\n- Notes\n- Images\n- Reports\n",
    ],
    ["csv", "Name,Count,Status\nImages,12,Ready\nDocuments,6,Ready\nVideo,1,Ready\n"],
    ["ts", "export function thumbnailSize(width: number) {\n  return Math.min(width, 360);\n}\n"],
    [
      "html",
      "<!doctype html><style>body{font:24px sans-serif;background:#e2e8f0;padding:30px}h1{color:#0369a1}</style><h1>Browser benchmark</h1><p>Rendered HTML thumbnail</p>",
    ],
  ];
  for (let index = 0; index < 18; index++) {
    const [extension, content] = samples[index % samples.length];
    await writeFile(
      path.join(fixtures, `${String(index).padStart(2, "0")}-sample.${extension}`),
      content,
    );
  }
  await sharp({ create: { width: 900, height: 600, channels: 3, background: "#0369a1" } })
    .png()
    .toFile(path.join(fixtures, "19-image.png"));
}
const fixtureRelative = path.relative(root, fixtures).split(path.sep).join("/");
const url = new URL("/browse", baseUrl);
url.searchParams.set("dir", fixtureRelative);
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(
  ({ fixtureRelative }) => {
    try {
      localStorage.setItem("browse:mode", '"grid"');
      localStorage.setItem("browse:sort", '"name"');
    } catch {
      /* about:blank has no storage origin. */
    }
    const state: PaintSample = {
      restoredFromBackForwardCache: false,
      listingMs: null,
      initialVisible: [],
      decoded: {},
      firstVisibleDecodedMs: null,
      firstVisiblePaintOpportunityMs: null,
      allVisibleDecodedMs: null,
      allVisiblePaintOpportunityMs: null,
      nearby: [],
    };
    window.__thumbnailBenchmark = state;
    let decoding = new WeakSet<HTMLImageElement>();
    let epoch = 0;
    let lastVisible = "";
    let stableFrames = 0;
    let paintQueued = false;
    let firstPaintQueued = false;
    const scan = () => {
      let thumbnails = Array.from(document.querySelectorAll<HTMLElement>("[data-thumbnail-path]"));
      // Instrument older bundles too, so a pre-deploy baseline does not depend on new markup.
      if (!thumbnails.length) {
        thumbnails = Array.from(
          document.querySelectorAll<HTMLButtonElement>("[data-entry-index]"),
        ).flatMap((button) => {
          const name = button.getAttribute("aria-label")?.replace(/^Preview /, "");
          const target = button.firstElementChild as HTMLElement | null;
          if (!target || !name) return [];
          target.dataset.thumbnailPath = `${fixtureRelative}/${name}`;
          return [target];
        });
      }
      const visible = thumbnails.filter((element) => {
        const box = element.getBoundingClientRect();
        const clip = element.closest('[aria-label="Folder contents"]')?.getBoundingClientRect();
        return (
          box.width > 0 &&
          box.height > 0 &&
          box.bottom > Math.max(0, clip?.top ?? 0) &&
          box.top < Math.min(innerHeight, clip?.bottom ?? innerHeight) &&
          box.right > Math.max(0, clip?.left ?? 0) &&
          box.left < Math.min(innerWidth, clip?.right ?? innerWidth)
        );
      });
      if (visible.length && state.listingMs === null) state.listingMs = performance.now() - epoch;
      const paths = visible.map((element) => element.dataset.thumbnailPath!);
      const signature = paths.join("\n");
      stableFrames = signature === lastVisible ? stableFrames + 1 : 0;
      lastVisible = signature;
      if (!state.initialVisible.length && paths.length && stableFrames >= 2)
        state.initialVisible = paths;
      state.nearby = thumbnails
        .filter((element) => element.dataset.thumbnailPriority === "prefetch")
        .map((element) => element.dataset.thumbnailPath!);
      for (const element of thumbnails) {
        const img = element.querySelector("img");
        if (!img || decoding.has(img)) continue;
        decoding.add(img);
        const rel = element.dataset.thumbnailPath!;
        void img
          .decode()
          .then(() => {
            state.decoded[rel] ??= performance.now() - epoch;
          })
          .catch(() => {});
      }
      const times = state.initialVisible
        .map((rel) => state.decoded[rel])
        .filter((value) => value !== undefined);
      if (times.length) {
        state.firstVisibleDecodedMs = Math.min(...times);
        if (!firstPaintQueued) {
          firstPaintQueued = true;
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              state.firstVisiblePaintOpportunityMs = performance.now() - epoch;
            }),
          );
        }
      }
      if (
        state.initialVisible.length &&
        times.length === state.initialVisible.length &&
        !paintQueued
      ) {
        paintQueued = true;
        state.allVisibleDecodedMs = Math.max(...times);
        // Decode completion is measurable; this records the next two animation frames,
        // an opportunity to paint, rather than claiming access to compositor timestamps.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            state.allVisiblePaintOpportunityMs = performance.now() - epoch;
          }),
        );
      }
      if (performance.now() - epoch < 40_000) requestAnimationFrame(scan);
    };
    window.addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      epoch = performance.now();
      Object.assign(state, {
        restoredFromBackForwardCache: true,
        listingMs: null,
        initialVisible: [],
        decoded: {},
        firstVisibleDecodedMs: null,
        firstVisiblePaintOpportunityMs: null,
        allVisibleDecodedMs: null,
        allVisiblePaintOpportunityMs: null,
        nearby: [],
      });
      decoding = new WeakSet();
      stableFrames = 0;
      lastVisible = "";
      paintQueued = false;
      firstPaintQueued = false;
      requestAnimationFrame(scan);
    });
    requestAnimationFrame(scan);
  },
  { fixtureRelative },
);

const results: unknown[] = [];
try {
  const page = await context.newPage();
  for (const name of ["cold", "cached-revisit", "back-reopen"]) {
    page.removeAllListeners("response");
    page.removeAllListeners("requestfinished");
    page.removeAllListeners("pageerror");
    const requests: Array<{
      path: string | null;
      priority: string | null;
      wait: string | null;
      status: number;
      cache: string | null;
      serverTiming: string | null;
      timing: unknown;
    }> = [];
    const failures: string[] = [];
    const completedRequests = new WeakMap<object, { timing: unknown }>();
    page.on("response", (response) => {
      const requestUrl = new URL(response.url());
      if (requestUrl.pathname !== "/api/file/thumbnail") return;
      const record = {
        path: requestUrl.searchParams.get("path"),
        priority: requestUrl.searchParams.get("priority"),
        wait: requestUrl.searchParams.get("wait"),
        status: response.status(),
        cache: response.headers()["x-thumbnail-cache"] ?? null,
        serverTiming: response.headers()["server-timing"] ?? null,
        timing: response.request().timing(),
      };
      requests.push(record);
      completedRequests.set(response.request(), record);
    });
    page.on("requestfinished", (request) => {
      const record = completedRequests.get(request);
      if (record) record.timing = request.timing();
    });
    page.on("pageerror", (error) => failures.push(error.message));
    if (name === "back-reopen") await page.goto("about:blank");
    const started = performance.now();
    if (name === "back-reopen")
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 60_000 });
    else await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    let complete = true;
    await page
      .waitForFunction(
        () => window.__thumbnailBenchmark?.allVisiblePaintOpportunityMs != null,
        undefined,
        {
          timeout: 35_000,
        },
      )
      .catch(() => {
        complete = false;
      });
    const result = await page.evaluate(() => ({
      ...window.__thumbnailBenchmark,
      timeOrigin: performance.timeOrigin,
      navigation: performance.getEntriesByType("navigation").map((entry) => entry.toJSON()),
      paint: performance.getEntriesByType("paint").map((entry) => entry.toJSON()),
      resources: performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.includes("/api/file/"))
        .map((entry) => entry.toJSON()),
    }));
    await page.screenshot({ path: path.join(output, `${name}.png`) });
    results.push({
      name,
      complete,
      wallMs: performance.now() - started,
      ...result,
      requests,
      failures,
    });
    console.log(
      JSON.stringify({
        name,
        complete,
        visible: result.initialVisible.length,
        listingMs: result.listingMs,
        firstVisibleDecodedMs: result.firstVisibleDecodedMs,
        firstVisiblePaintOpportunityMs: result.firstVisiblePaintOpportunityMs,
        allVisibleDecodedMs: result.allVisibleDecodedMs,
        allVisiblePaintOpportunityMs: result.allVisiblePaintOpportunityMs,
        requests: requests.length,
        failures,
      }),
    );
  }
} finally {
  await context.close();
  await browser.close();
}
await writeFile(
  path.join(output, "browser-benchmark.json"),
  JSON.stringify(
    {
      url: url.href,
      fixtureDirectory: fixtureRelative,
      viewport: { width: 1440, height: 1000 },
      results,
    },
    null,
    2,
  ),
);
