/**
 * bun scripts/browse-performance.ts <managed-output-dir> <dashboard-base-url>
 * Optional HARNERY_BROWSE_LISTING_BUDGET_MS / HARNERY_BROWSE_FIRST_DECODE_BUDGET_MS /
 * HARNERY_BROWSE_DECODE_BUDGET_MS. Defaults are smoke ceilings, not speed targets.
 * Creates 1,000 files; measures cold, rapid scroll, and same-document Back navigation.
 * A decoded image followed by two animation frames is a paint opportunity, not a
 * compositor timestamp. Converter availability is explicit in the JSON report.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";
import sharp from "sharp";
import { coordRoot } from "../lib/coord-reader";
import { checkBrowseSample, defaultBudgets, positiveBudget } from "./browse-performance-budgets";

const [directory, baseUrl] = process.argv.slice(2);
if (!directory || !baseUrl)
  throw new Error("Provide a managed output directory and dashboard URL.");
const root = path.resolve(coordRoot());
const output = path.resolve(directory);
const relative = path.relative(root, output);
if (
  !relative.startsWith(`.harnery${path.sep}artifacts${path.sep}`) ||
  relative.split(path.sep).includes("..")
)
  throw new Error("Output must be inside a managed artifact workspace.");
const budgets = {
  ...defaultBudgets,
  listingMs: positiveBudget(process.env.HARNERY_BROWSE_LISTING_BUDGET_MS, defaultBudgets.listingMs),
  firstDecodedMs: positiveBudget(
    process.env.HARNERY_BROWSE_FIRST_DECODE_BUDGET_MS,
    defaultBudgets.firstDecodedMs,
  ),
  allDecodedMs: positiveBudget(
    process.env.HARNERY_BROWSE_DECODE_BUDGET_MS,
    defaultBudgets.allDecodedMs,
  ),
};
await mkdir(output, { recursive: true });
const fixtures = await mkdtemp(path.join(output, "large-fixtures-"));
const fixtureRelative = path.relative(root, fixtures).split(path.sep).join("/");
const formats: Record<string, string> = {};
for (let start = 0; start < 1000; start += 25) {
  await Promise.all(
    Array.from({ length: 25 }, (_, offset) => {
      const index = start + offset;
      return writeFile(
        path.join(fixtures, `${String(index).padStart(4, "0")}-notes.txt`),
        `File ${index}\n\nA reproducible Browse performance fixture.\nOnly visible and nearby files should request thumbnails.\n`,
      );
    }),
  );
}
await sharp({ create: { width: 720, height: 480, channels: 3, background: "#0369a1" } })
  .png()
  .toFile(path.join(fixtures, "0000-image.png"));
await writeFile(
  path.join(fixtures, "0000-page.html"),
  "<!doctype html><style>body{font:32px sans-serif;background:#dbeafe;padding:30px}</style><h1>Mixed workload</h1><p>Rendered HTML</p>",
);
formats.html = "included";
if (Bun.which("libreoffice")) {
  await writeFile(
    path.join(fixtures, "0000-document.rtf"),
    "{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Arial;}}\\f0\\fs32 Thumbnail benchmark\\par A warm document converter.}",
  );
  formats.office = "included";
} else formats.office = "skipped: libreoffice unavailable";
if (Bun.which("ffmpeg")) {
  const process = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=steelblue:s=320x180:d=1",
      "-c:v",
      "mpeg4",
      "-y",
      path.join(fixtures, "0000-video.mp4"),
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (await process.exited) throw new Error(await new Response(process.stderr).text());
  formats.video = "included";
} else formats.video = "skipped: ffmpeg unavailable";
// A malformed converter input must settle as a fallback without starving valid files.
await writeFile(path.join(fixtures, "0000-broken.mp4"), "invalid video fixture");
const expectedEntries =
  1003 + Number(formats.office === "included") + Number(formats.video === "included");
const broken = `${fixtureRelative}/0000-broken.mp4`;
const url = new URL("/browse", baseUrl);
url.searchParams.set("dir", fixtureRelative);
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => {
  try {
    localStorage.setItem("browse:mode", '"grid"');
    localStorage.setItem("browse:sort", '"name"');
  } catch {
    /* about:blank */
  }
});
const results: unknown[] = [];
const failures: string[] = [];

async function measure(page: Page, name: string, action: () => Promise<unknown>) {
  const requests: Array<{
    path: string;
    status: number;
    timing: unknown;
    serverTiming: string | null;
  }> = [];
  const errors: string[] = [];
  const requestedFiles: string[] = [];
  let workspaceRequests = 0;
  const records = new WeakMap<import("playwright").Request, (typeof requests)[number]>();
  const onRequest = (request: import("playwright").Request) => {
    const parsed = new URL(request.url());
    if (parsed.pathname === "/api/file/workspaces") workspaceRequests++;
    if (parsed.pathname === "/api/file/thumbnail")
      requestedFiles.push(parsed.searchParams.get("path") ?? "");
  };
  const onResponse = (response: import("playwright").Response) => {
    const parsed = new URL(response.url());
    if (!parsed.pathname.startsWith("/api/file/")) return;
    const record = {
      path: response.url(),
      status: response.status(),
      timing: response.request().timing(),
      serverTiming: response.headers()["server-timing"] ?? null,
    };
    requests.push(record);
    records.set(response.request(), record);
  };
  const onFinished = (request: import("playwright").Request) => {
    const record = records.get(request);
    if (record) record.timing = request.timing();
  };
  const onError = (error: Error) => errors.push(error.message);
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfinished", onFinished);
  page.on("pageerror", onError);
  const start = performance.now();
  await action();
  const actionMs = performance.now() - start;
  const observed = await page.evaluate(
    async ({ timeout, broken }) => {
      const start = performance.now();
      let listingMs: number | null = null;
      let firstDecodedMs: number | null = null;
      let allDecodedMs: number | null = null;
      let visible: string[] = [];
      const decoded = new Set<string>();
      const decoding = new WeakSet<HTMLImageElement>();
      while (performance.now() - start < timeout) {
        const elements = Array.from(
          document.querySelectorAll<HTMLElement>("[data-thumbnail-path]"),
        ).filter((element) => {
          const bounds = element.getBoundingClientRect();
          const clip = element.closest('[aria-label="Folder contents"]')?.getBoundingClientRect();
          return (
            bounds.width > 0 &&
            bounds.height > 0 &&
            bounds.bottom > Math.max(0, clip?.top ?? 0) &&
            bounds.top < Math.min(innerHeight, clip?.bottom ?? innerHeight)
          );
        });
        if (elements.length && listingMs === null) listingMs = performance.now() - start;
        if (!visible.length && elements.length)
          visible = elements
            .map((element) => element.dataset.thumbnailPath!)
            .filter((path) => path !== broken);
        for (const element of elements) {
          const image = element.querySelector("img");
          if (!image || decoding.has(image)) continue;
          decoding.add(image);
          const rel = element.dataset.thumbnailPath!;
          void image
            .decode()
            .then(() => {
              if (image.naturalWidth && visible.includes(rel)) {
                decoded.add(rel);
                firstDecodedMs ??= performance.now() - start;
              }
            })
            .catch(() => {});
        }
        if (visible.length && decoded.size === visible.length) {
          allDecodedMs = performance.now() - start;
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          break;
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return {
        listingMs,
        firstDecodedMs,
        allDecodedMs,
        paintOpportunityMs: allDecodedMs === null ? null : performance.now() - start,
        visible: visible.length,
        decoded: decoded.size,
        visiblePaths: visible,
        domEntries: document.querySelectorAll("[data-entry-index]").length,
      };
    },
    { timeout: budgets.allDecodedMs, broken },
  );
  page.off("request", onRequest);
  page.off("response", onResponse);
  page.off("requestfinished", onFinished);
  page.off("pageerror", onError);
  const sample = {
    ...observed,
    name,
    listingMs: observed.listingMs === null ? null : observed.listingMs + actionMs,
    firstDecodedMs: observed.firstDecodedMs === null ? null : observed.firstDecodedMs + actionMs,
    allDecodedMs: observed.allDecodedMs === null ? null : observed.allDecodedMs + actionMs,
    paintOpportunityMs:
      observed.paintOpportunityMs === null ? null : observed.paintOpportunityMs + actionMs,
    thumbnailRequests: requestedFiles.length,
    workspaceRequests,
    uniqueRequestedFiles: new Set(requestedFiles).size,
    errors,
  };
  failures.push(...checkBrowseSample(sample, budgets));
  if (sample.domEntries !== expectedEntries)
    failures.push(
      `${name}: expected ${expectedEntries} searchable file rows, found ${sample.domEntries}`,
    );
  if (requestedFiles.filter((path) => path === broken).length > 3)
    failures.push(`${name}: failed converter was requested more than three times`);
  await page.screenshot({ path: path.join(output, `${name}.png`) });
  results.push({ ...sample, actionMs, requests });
  console.log(JSON.stringify({ ...sample, visiblePaths: undefined }));
  return sample;
}

try {
  const page = await context.newPage();
  await measure(page, "cold-large-mixed", () =>
    page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 }),
  );
  // Scroll several far-apart regions, allowing a frame at each position for observers.
  await measure(page, "rapid-scroll-return", async () => {
    await page.evaluate(async () => {
      const root = document.querySelector<HTMLElement>('[aria-label="Folder contents"]');
      if (!root) throw new Error("Folder scroll container is missing");
      for (const fraction of [0.25, 0.75, 0.5, 1, 0]) {
        root.scrollTop = (root.scrollHeight - root.clientHeight) * fraction;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      }
    });
  });
  await page.getByRole("button", { name: "Up one folder", exact: true }).click();
  await page.waitForFunction(
    (rel) => new URL(location.href).searchParams.get("dir") !== rel,
    fixtureRelative,
  );
  await measure(page, "same-document-back", async () => {
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      (rel) => new URL(location.href).searchParams.get("dir") === rel,
      fixtureRelative,
    );
  });
  // Verify converter failure settles and the negative cache avoids retry loops.
  const failedUrl = new URL("/api/file/thumbnail", baseUrl);
  failedUrl.searchParams.set("path", broken);
  failedUrl.searchParams.set("wait", "1000");
  const status: number[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(failedUrl, { signal: AbortSignal.timeout(5000) });
    status.push(response.status);
    await response.arrayBuffer();
    if (response.status === 422) break;
  }
  const repeat = await fetch(failedUrl, { signal: AbortSignal.timeout(5000) });
  status.push(repeat.status);
  await repeat.arrayBuffer();
  if (status.at(-1) !== 422 || status.at(-2) !== 422)
    failures.push("Malformed video did not settle into the negative cache");
  results.push({ name: "failed-converter", status });
} catch (error) {
  failures.push((error as Error).message);
  throw error;
} finally {
  await context.close();
  await browser.close();
  await writeFile(
    path.join(output, "browse-performance.json"),
    JSON.stringify(
      {
        url: url.href,
        formats,
        budgets,
        results,
        failures,
        note: "Timing begins before each action; decode sampling starts after the action. Decode timestamps are upper bounds when images finish during navigation. Paint opportunity records two animation frames, not compositor paint. A warm background service may prepare fresh fixtures before the first request.",
      },
      null,
      2,
    ),
  );
}
if (failures.length) throw new Error(failures.join("\n"));
