/** Run against a local dashboard: bun scripts/browse-mobile.ts <base-url> <output-dir>.
 * Browser-only fixtures leave the repository and its file APIs unchanged.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const [baseUrl, output] = process.argv.slice(2);
if (!baseUrl || !output) throw new Error("Provide a dashboard URL and managed output directory.");
const dir = ".harnery/artifacts/mobile-browser-fixture";
const entries = Array.from({ length: 24 }, (_, index) => ({
  name: `file-${String(index).padStart(2, "0")}.txt`,
  relPath: `${dir}/file-${String(index).padStart(2, "0")}.txt`,
  kind: "file",
  size: 100,
  mtime: "2026-01-01T12:00:00Z",
}));
const results: unknown[] = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [
    { width: 390, height: 640 },
    { width: 320, height: 480 },
    { width: 844, height: 390 },
    { width: 1440, height: 900 },
  ]) {
    const mobile = viewport.width < 1024;
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/file/list?*", (route) =>
      route.fulfill({
        json: {
          dir,
          entries,
          workspace: {
            name: "mobile-browser-fixture",
            relPath: dir,
            kind: "dir",
            title: "Preview rerun and source material review workspace",
            purpose:
              "Review the complete source material, updated media, exact inputs, and supporting evidence for the latest revision.",
          },
        },
      }),
    );
    await page.route("**/api/file/meta?*", (route) =>
      route.fulfill({
        json: {
          relPath: new URL(route.request().url()).searchParams.get("path"),
          size: 100,
          mtime: "2026-01-01T12:00:00Z",
          mime: "text/plain",
          category: "text",
          inlineable: true,
        },
      }),
    );
    await page.route("**/api/file/text?*", (route) =>
      route.fulfill({
        json: {
          relPath: new URL(route.request().url()).searchParams.get("path"),
          size: 100,
          mtime: "2026-01-01T12:00:00Z",
          mime: "text/plain",
          category: "text",
          content: "Mobile preview fixture",
          lines: 1,
          truncated: false,
        },
      }),
    );
    await page.route("**/api/file/thumbnail?*", (route) => route.fulfill({ status: 404 }));
    await page.goto(`${baseUrl}/browse?dir=${encodeURIComponent(dir)}`);
    await page.locator("[data-file-row]").last().waitFor();
    await page.waitForFunction(() => document.querySelector('[data-thumbnail-priority="visible"]'));
    assert(
      (await page.locator('[data-thumbnail-priority="offscreen"]').count()) > 0,
      "Distant thumbnails must stay unloaded with either scroll layout",
    );
    const region = page.getByRole("region", { name: "File browser", exact: true });
    const contents = page.getByRole("group", { name: "Folder contents" });
    const first = page.locator("[data-file-row]").first();
    const firstBounds = (await first.boundingBox())!;
    const initialVisible = viewport.height - firstBounds.y;
    await page.screenshot({ path: path.join(output, `${viewport.width}-initial.png`) });
    assert(
      initialVisible >= viewport.height * 0.3,
      `Files start too low: ${JSON.stringify({ viewport, firstBounds })}`,
    );
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "Page overflows horizontally",
    );
    await page.screenshot({ path: path.join(output, `${viewport.width}-initial.png`) });
    if (mobile) {
      assert.equal(await page.getByLabel("File type", { exact: true }).isVisible(), false);
      await page.locator("button[aria-controls='browse-folder-details']").click();
      assert(await page.getByRole("navigation", { name: "Folder breadcrumb" }).isVisible());
      await page.locator("button[aria-controls='browse-folder-details']").click();
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await page.getByLabel("File type", { exact: true }).selectOption("image");
      await page.locator("[data-file-row]").first().waitFor({ state: "detached" });
      await page.getByLabel("File type", { exact: true }).selectOption("all");
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await region.evaluate((element) => {
        element.scrollTop = 280;
      });
      assert(
        (await page.getByRole("heading", { level: 1 }).boundingBox())!.y < 0,
        "Folder header must scroll away",
      );
      const bounds = (await region.boundingBox())!;
      assert(bounds.height >= viewport.height * 0.65, "Browsing region is too short");
      await page.screenshot({ path: path.join(output, `${viewport.width}-scrolled.png`) });
      assert.equal(
        await contents.evaluate((element) => element.scrollTop),
        0,
        "Mobile files must not have a nested scroll area",
      );
      await region.evaluate((element) => {
        element.scrollTop = 0;
      });
    } else {
      assert(await page.getByLabel("File type", { exact: true }).isVisible());
      assert(
        await contents.evaluate((element) => element.scrollHeight > element.clientHeight),
        "Desktop list must retain its scrolling pane",
      );
    }
    await page.getByRole("button", { name: "Grid view", exact: true }).click();
    await page.locator("[data-entry-index='0']").click();
    const preview = page.getByRole("region", { name: "File preview", exact: true });
    await preview.getByText("Mobile preview fixture", { exact: true }).waitFor();
    if (mobile) {
      assert.equal(await region.isVisible(), false);
      assert.equal(
        await page.getByRole("complementary", { name: "File locations" }).isVisible(),
        false,
      );
      assert(
        (await preview.boundingBox())!.height >= viewport.height * 0.8,
        "Preview should use the phone screen",
      );
    } else assert(await region.isVisible(), "Desktop should keep split view");
    await page.getByRole("button", { name: "Close preview", exact: true }).click();
    await region.waitFor();
    await page.getByRole("button", { name: "List view", exact: true }).click();
    await page.getByLabel("Search files and workspaces").fill("file-03");
    await page.waitForFunction(() => document.querySelectorAll("[data-file-row]").length === 1);
    assert.deepEqual(errors, []);
    results.push({ viewport, initialVisible, passed: true });
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(
    path.join(output, "mobile-layout-results.json"),
    JSON.stringify(results, null, 2),
  );
}
console.log(JSON.stringify(results, null, 2));
