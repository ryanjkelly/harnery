import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("browser launch failures retain their cause without changing the public code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thumbnail-browser-error-"));
  try {
    const script = `
      import { writeFile } from "node:fs/promises";
      import { renderHtmlThumbnail, closeThumbnailBrowser } from ${JSON.stringify(new URL("./thumbnail-renderers/html.ts", import.meta.url).href)};
      const root = ${JSON.stringify(root)};
      await writeFile(root + "/page.html", "<html><body>Browser failure</body></html>");
      try {
        await renderHtmlThumbnail({ inputPath: root + "/page.html", relPath: "page.html", root, category: "html" });
        process.exitCode = 1;
      } catch (error) {
        console.log(JSON.stringify({ message: error.message, detail: error.cause?.message }));
      } finally {
        await closeThumbnailBrowser();
      }
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(root, "missing-browsers") },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const failure = JSON.parse(result.stdout.trim());
    expect(failure.message).toBe("thumbnail_browser_failed");
    expect(failure.detail).toContain("Executable doesn't exist");
    expect(failure.detail.length).toBeLessThanOrEqual(16 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
