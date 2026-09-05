import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { serveFileThumbnail } from "./file-thumbnail";
import { __resetFilesCaches, __setResolveTestHooks } from "./files";

let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "harn-thumbnail-"));
  mkdirSync(join(root, ".harnery"));
  const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  writeFileSync(join(root, "image.png"), png);
  __resetFilesCaches();
});
afterEach(() => {
  __setResolveTestHooks(null);
  __resetFilesCaches();
  rmSync(root, { recursive: true, force: true });
});
const request = (path: string, headers?: Record<string, string>) =>
  new Request(`http://localhost/api/file/thumbnail?path=${encodeURIComponent(path)}`, { headers });

test("thumbnail is bounded WebP and revalidates with the same file version", async () => {
  const response = await serveFileThumbnail(request("image.png"), { root });
  expect(response.status).toBe(200);
  const bytes = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(bytes).metadata();
  expect(metadata.format).toBe("webp");
  expect(metadata.width).toBe(360);
  expect(metadata.height).toBe(240);
  const repeat = await serveFileThumbnail(
    request("image.png", { "if-none-match": response.headers.get("etag")! }),
    { root },
  );
  expect(repeat.status).toBe(304);
});

test("thumbnail rejects traversal, denied paths, and non-raster input", async () => {
  writeFileSync(join(root, "readme.md"), "hello");
  mkdirSync(join(root, ".credentials"));
  writeFileSync(join(root, ".credentials", "hidden.png"), "hidden");
  expect((await serveFileThumbnail(request("../image.png"), { root })).status).toBe(400);
  expect((await serveFileThumbnail(request(".credentials/hidden.png"), { root })).status).toBe(403);
  expect((await serveFileThumbnail(request("readme.md"), { root })).status).toBe(415);
});

test("thumbnail reads checked inode after its pathname is replaced", async () => {
  __setResolveTestHooks({
    afterOpen: (_fd, path) => {
      renameSync(path, `${path}.original`);
      symlinkSync("/etc/passwd", path);
    },
  });
  const response = await serveFileThumbnail(request("image.png"), { root });
  // The resolver may reject the race itself; it must never reopen the replacement.
  expect([200, 403]).toContain(response.status);
  if (response.status === 200)
    expect((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).format).toBe("webp");
});

test("oversized sources are refused before decoding", async () => {
  truncateSync(join(root, "image.png"), 33 * 1024 * 1024);
  expect((await serveFileThumbnail(request("image.png"), { root })).status).toBe(413);
});

test("a replaced image cannot reuse the old thumbnail cache", async () => {
  const first = await serveFileThumbnail(request("image.png"), { root });
  const replacement = await sharp({ create: { width: 400, height: 100, channels: 3, background: "blue" } }).png().toBuffer();
  writeFileSync(join(root, "replacement.png"), replacement);
  renameSync(join(root, "replacement.png"), join(root, "image.png"));
  const second = await serveFileThumbnail(request("image.png", { "if-none-match": first.headers.get("etag")! }), { root });
  expect(second.status).toBe(200);
  expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"));
  expect((await sharp(Buffer.from(await second.arrayBuffer())).metadata()).height).toBe(90);
});
