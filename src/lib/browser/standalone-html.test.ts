import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "./client.ts";

// A one-pixel PNG, so the fixture has a real binary sub-resource to inline.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let fixtureServer: Server;
let fixtureOrigin: string;
const browsers: Browser[] = [];

beforeEach(async () => {
  fixtureServer = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/assets/page.css") {
      response.setHeader("content-type", "text/css; charset=utf-8");
      response.end("body { background: rgb(1, 2, 3); background-image: url(/assets/pixel.png); }");
      return;
    }
    if (path === "/assets/pixel.png") {
      response.setHeader("content-type", "image/png");
      response.end(PIXEL_PNG);
      return;
    }
    if (path === "/assets/huge.png") {
      response.setHeader("content-type", "image/png");
      response.end(Buffer.alloc(4096, 7));
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
      <html>
        <head>
          <title>Standalone fixture</title>
          <link rel="stylesheet" href="/assets/page.css">
          <link rel="preload" as="script" href="/assets/app.js">
          <style>.badge { background-image: url("/assets/pixel.png"); }</style>
        </head>
        <body>
          <h1>Standalone fixture</h1>
          <img id="small" src="/assets/pixel.png" alt="pixel">
          <img id="large" src="/assets/huge.png" alt="huge">
          <a id="link" href="/somewhere">Somewhere</a>
          <script>window.fixtureRan = true;</script>
        </body>
      </html>`);
  });
  await new Promise<void>((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const address = fixtureServer.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind TCP.");
  fixtureOrigin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
});

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), "harnery-standalone-html-"));
  chmodSync(dir, 0o700);
  return dir;
}

async function capture(maxResourceBytes: number) {
  const browser = new Browser({ profileDir: profile(), navigationTimeout: 10_000 });
  browsers.push(browser);
  await browser.open();
  await browser.navigate(fixtureOrigin);
  return await browser.standaloneHtml({ maxResourceBytes });
}

describe("standalone HTML snapshots", () => {
  test("inlines stylesheets and small resources, absolutizes the rest", async () => {
    const snapshot = await capture(1024);

    // The whole point: nothing still resolves against the serving host's root.
    expect(snapshot.html).not.toMatch(/(?:href|src)="\//);

    expect(snapshot.stylesheetsInlined).toBe(1);
    expect(snapshot.stylesheetsLinked).toBe(0);
    expect(snapshot.html).toContain("rgb(1, 2, 3)");
    expect(snapshot.html).toContain('data-harnery-inlined-from="' + fixtureOrigin);

    // url() inside the fetched sheet and inside an inline <style> both resolve.
    expect(snapshot.html).not.toContain("url(/assets/pixel.png)");
    expect(snapshot.html.match(/url\("data:image\/png;base64,/g)?.length).toBe(2);

    // Under the cap → data URI; over it → absolute URL on the captured origin.
    expect(snapshot.html).toMatch(/id="small"\s+src="data:image\/png;base64,/);
    expect(snapshot.html).toContain(`id="large" src="${fixtureOrigin}/assets/huge.png"`);
    expect(snapshot.resourcesInlined).toBeGreaterThanOrEqual(3);
    expect(snapshot.resourcesLinked).toBe(1);

    // Navigation targets are absolutized, never embedded.
    expect(snapshot.html).toContain(`id="link" href="${fixtureOrigin}/somewhere"`);

    // Nothing executable, and no dead resource hints.
    expect(snapshot.html).not.toContain("<script");
    expect(snapshot.html).not.toContain('rel="preload"');

    expect(snapshot.source).toBe(`${fixtureOrigin}/`);
    expect(snapshot.html).toContain('name="harnery:snapshot-source"');
  });

  test("leaves the live page untouched", async () => {
    const browser = new Browser({ profileDir: profile(), navigationTimeout: 10_000 });
    browsers.push(browser);
    await browser.open();
    await browser.navigate(fixtureOrigin);
    await browser.standaloneHtml();

    const raw = await browser.htmlContent();
    expect(raw).toContain('href="/assets/page.css"');
    expect(raw).toContain("<script");
  });
});
