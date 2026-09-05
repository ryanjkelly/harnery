import { closeSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { resolveFile, sandboxedTreeMimeFor, scanChunk } from "../files";
import type { ThumbnailInput } from "../thumbnail-renderers";
import { THUMBNAIL_ORIGIN, thumbnailDependencyGraph, thumbnailDocumentUrl } from "./dependencies";

const ORIGIN = THUMBNAIL_ORIGIN;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
let browserPromise: Promise<Browser> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
let active = 0;

async function acquire(): Promise<Browser> {
  clearTimeout(idle);
  active++;
  if (!browserPromise) {
    const opening = import("playwright")
      .then(async ({ chromium }) => {
        const browser = await chromium.launch({
          headless: true,
          chromiumSandbox: true,
          timeout: 10_000,
        });
        browser.once("disconnected", () => {
          if (browserPromise === opening) browserPromise = undefined;
        });
        return browser;
      })
      .catch((error) => {
        if (browserPromise === opening) browserPromise = undefined;
        throw error;
      });
    browserPromise = opening;
  }
  return browserPromise;
}

function release(): void {
  active--;
  if (!active) {
    idle = setTimeout(() => {
      void closeThumbnailBrowser();
    }, 15_000);
    idle.unref?.();
  }
}

export async function closeThumbnailBrowser(): Promise<void> {
  clearTimeout(idle);
  const current = browserPromise;
  browserPromise = undefined;
  if (current) await (await current.catch(() => undefined))?.close();
}

/** Screenshots only a static document. All assets pass through the file resolver. */
export async function renderHtmlThumbnail(input: ThumbnailInput): Promise<Buffer> {
  const file = await open(input.inputPath, "r");
  let html: Buffer;
  let allowedPaths: Set<string>;
  try {
    const stat = await file.stat();
    if (stat.size > MAX_HTML_BYTES) throw new Error("thumbnail_source_limit");
    html = await file.readFile();
    if (scanChunk(html).secret) throw new Error("denied");
    ({ allowedPaths } = await thumbnailDependencyGraph(
      { fd: file.fd, relPath: input.relPath, category: "html" },
      input.root,
    ));
  } finally {
    await file.close();
  }

  let browser: Browser;
  try {
    browser = await acquire();
  } catch {
    release();
    throw new Error("converter_missing:chromium");
  }
  let context: BrowserContext | undefined;
  const documentUrl = thumbnailDocumentUrl(input.relPath);
  let mainServed = false;
  let assetBytes = 0;
  let assetCount = 0;
  try {
    context = await browser.newContext({
      viewport: { width: 720, height: 480 },
      javaScriptEnabled: false,
      serviceWorkers: "block",
      acceptDownloads: false,
      reducedMotion: "reduce",
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== ORIGIN || request.method() !== "GET") return route.abort();
      if (request.url() === documentUrl && !mainServed && request.resourceType() === "document") {
        mainServed = true;
        return route.fulfill({
          body: html,
          contentType: "text/html; charset=utf-8",
          headers: {
            "content-security-policy": `default-src 'none'; script-src 'none'; style-src 'unsafe-inline' ${ORIGIN}; img-src data: ${ORIGIN}; font-src data: ${ORIGIN}; frame-src 'none'; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; sandbox`,
          },
        });
      }
      if (!["image", "stylesheet", "font"].includes(request.resourceType()) || ++assetCount > 32)
        return route.abort();
      if (!allowedPaths.has(url.pathname)) return route.abort();
      let relative: string;
      try {
        relative = decodeURIComponent(url.pathname.slice(1));
      } catch {
        return route.abort();
      }
      const asset = resolveFile(relative, { root: input.root });
      if (!asset.ok) return route.abort();
      try {
        if (asset.size > 4 * 1024 * 1024 || assetBytes + asset.size > 16 * 1024 * 1024)
          return route.abort();
        assetBytes += asset.size;
        const buffer = Buffer.alloc(asset.size);
        let offset = 0;
        while (offset < buffer.length) {
          const count = readSync(asset.fd, buffer, offset, buffer.length - offset, offset);
          if (!count) break;
          offset += count;
        }
        const bytes = buffer.subarray(0, offset);
        if (scanChunk(bytes).secret) return route.abort();
        return route.fulfill({
          body: bytes,
          contentType: sandboxedTreeMimeFor(asset.category, path.extname(asset.relPath).slice(1)),
          headers: { "access-control-allow-origin": "*", "x-content-type-options": "nosniff" },
        });
      } finally {
        closeSync(asset.fd);
      }
    });
    const page = await context.newPage();
    await page.goto(documentUrl, { waitUntil: "load", timeout: 8_000 });
    const screenshot = await page.screenshot({
      type: "png",
      timeout: 5_000,
      animations: "disabled",
    });
    const { default: sharp } = await import("sharp");
    return sharp(screenshot).resize(360, 240).webp({ quality: 72 }).toBuffer();
  } finally {
    try {
      await context?.close();
    } finally {
      release();
    }
  }
}
