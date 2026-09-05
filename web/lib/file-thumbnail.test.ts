import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import sharp from "sharp";
import { __resetFilesCaches, __setResolveTestHooks, resolveFile } from "./files";
import { __setThumbnailDiskTestHooks } from "./thumbnail-disk-cache";
import { registerThumbnailPreview } from "./thumbnail-reuse";
import { __resetThumbnailMemory, serveFileThumbnail } from "./thumbnail-service";

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
afterEach(async () => {
  await __resetThumbnailMemory();
  __setResolveTestHooks(null);
  __resetFilesCaches();
  rmSync(root, { recursive: true, force: true });
});
const request = (path: string, headers?: Record<string, string>) =>
  new Request(`http://localhost/api/file/thumbnail?path=${encodeURIComponent(path)}`, { headers });

test("thumbnail is bounded WebP and revalidates with the same file version", async () => {
  const response = await serveFileThumbnail(request("image.png"), { root, wait: true });
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

test("thumbnail rejects traversal, denied paths, and unsupported binary input", async () => {
  writeFileSync(join(root, "opaque.bin"), Buffer.from([0, 1, 0, 2]));
  mkdirSync(join(root, ".credentials"));
  writeFileSync(join(root, ".credentials", "hidden.png"), "hidden");
  expect((await serveFileThumbnail(request("../image.png"), { root })).status).toBe(400);
  expect((await serveFileThumbnail(request(".credentials/hidden.png"), { root })).status).toBe(403);
  expect((await serveFileThumbnail(request("opaque.bin"), { root })).status).toBe(415);
});

test("thumbnail reads checked inode after its pathname is replaced", async () => {
  __setResolveTestHooks({
    afterOpen: (_fd, path) => {
      renameSync(path, `${path}.original`);
      symlinkSync("/etc/passwd", path);
    },
  });
  const response = await serveFileThumbnail(request("image.png"), { root, wait: true });
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
  const first = await serveFileThumbnail(request("image.png"), { root, wait: true });
  const replacement = await sharp({
    create: { width: 400, height: 100, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  writeFileSync(join(root, "replacement.png"), replacement);
  renameSync(join(root, "replacement.png"), join(root, "image.png"));
  const second = await serveFileThumbnail(
    request("image.png", { "if-none-match": first.headers.get("etag")! }),
    { root, wait: true },
  );
  expect(second.status).toBe(200);
  expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"));
  expect((await sharp(Buffer.from(await second.arrayBuffer())).metadata()).height).toBe(90);
});

test("cold HTTP requests return pending and repeated requests reuse the result", async () => {
  writeFileSync(join(root, "sequence.json"), '{"title":"Motion sequence","frames":12}');
  const cold = await serveFileThumbnail(request("sequence.json"), { root, waitMs: 0 });
  expect(cold.status).toBe(202);
  expect(cold.headers.get("retry-after")).toBe("0");
  const generated = await serveFileThumbnail(request("sequence.json"), { root, wait: true });
  expect(generated.status).toBe(200);
  const cached = await serveFileThumbnail(request("sequence.json"), { root });
  expect(cached.headers.get("x-thumbnail-cache")).toBe("memory");
  expect(await cached.arrayBuffer()).toEqual(await generated.arrayBuffer());
});

test("disk cache survives memory eviction but never bypasses current file policy", async () => {
  const first = await serveFileThumbnail(request("image.png"), { root, wait: true });
  await __resetThumbnailMemory();
  const disk = await serveFileThumbnail(request("image.png"), { root });
  expect(disk.status).toBe(200);
  expect(disk.headers.get("x-thumbnail-cache")).toBe("disk");
  expect(await disk.arrayBuffer()).toEqual(await first.arrayBuffer());
  const [cachedFile] = readdirSync(join(root, ".harnery/cache/file-thumbnails"));
  expect(cachedFile).toBeDefined();
  const rawCache = resolveFile(`.harnery/cache/file-thumbnails/${cachedFile}`, { root });
  expect(rawCache.ok).toBe(false);
  if (!rawCache.ok) expect(rawCache.code).toBe("denied");
  rmSync(join(root, "image.png"));
  symlinkSync("/etc/passwd", join(root, "image.png"));
  expect([400, 403]).toContain((await serveFileThumbnail(request("image.png"), { root })).status);
});

test("folder previews are bounded collages and change when a child changes", async () => {
  mkdirSync(join(root, "frames"));
  writeFileSync(join(root, "frames", "one.md"), "# First frame");
  const first = await serveFileThumbnail(request("frames"), { root, wait: true });
  expect(first.status).toBe(200);
  const image = await sharp(Buffer.from(await first.arrayBuffer())).metadata();
  expect(image.width).toBe(360);
  expect(image.height).toBe(240);
  writeFileSync(join(root, "frames", "one.md"), "# Revised first frame");
  const second = await serveFileThumbnail(request("frames"), { root, wait: true });
  expect(second.status).toBe(200);
  expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"));
});

test("cache symlinks cannot substitute an unrelated file", async () => {
  mkdirSync(join(root, ".harnery", "cache"));
  symlinkSync(tmpdir(), join(root, ".harnery", "cache", "file-thumbnails"));
  const result = await serveFileThumbnail(request("image.png"), { root, wait: true });
  expect(result.status).toBe(200);
  expect(result.headers.get("x-thumbnail-cache")).toBe("generated");
});

test("bounded completion requests deliver a cold text thumbnail without another polling interval", async () => {
  writeFileSync(join(root, "ready.txt"), "Ready when rendering completes.");
  const result = await serveFileThumbnail(
    new Request("http://localhost/api/file/thumbnail?path=ready.txt&wait=1000"),
    { root },
  );
  expect(result.status).toBe(200);
  expect(result.headers.get("x-thumbnail-cache")).toBe("generated");
});

test("registered screenshots bypass HTML rendering and asset edits invalidate their cache", async () => {
  const workspace = ".harnery/artifacts/registered";
  mkdirSync(join(root, workspace), { recursive: true });
  const source = `${workspace}/page.html`;
  const preview = `${workspace}/capture.png`;
  writeFileSync(
    join(root, source),
    '<link rel="stylesheet" href="style.css"><h1>Current page</h1>',
  );
  writeFileSync(join(root, workspace, "style.css"), "h1 { color: blue }");
  writeFileSync(
    join(root, preview),
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: "red" },
    })
      .png()
      .toBuffer(),
  );
  await registerThumbnailPreview(source, preview, { root });
  const first = await serveFileThumbnail(request(source), { root, wait: true });
  expect(first.status).toBe(200);
  expect(first.headers.get("x-thumbnail-source")).toBe("registered-preview");
  const firstStats = await sharp(Buffer.from(await first.arrayBuffer())).stats();
  expect(firstStats.channels[0].mean).toBeGreaterThan(240);
  writeFileSync(join(root, workspace, "style.css"), "h1 { color: green }");
  const changed = await serveFileThumbnail(request(source), { root, wait: true });
  expect(changed.status).toBe(200);
  expect(changed.headers.get("x-thumbnail-source")).toBe("rendered");
  expect(changed.headers.get("etag")).not.toBe(first.headers.get("etag"));
});

test("embedded Office preview serves without requiring a convertible document body", async () => {
  const png = await sharp({
    create: { width: 800, height: 600, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  writeFileSync(
    join(root, "embedded.pptx"),
    zipSync({
      "docProps/thumbnail.png": png,
      "ppt/slides/slide1.xml": Buffer.from("<slide/>"),
    }),
  );
  const result = await serveFileThumbnail(request("embedded.pptx"), { root, wait: true });
  expect(result.status).toBe(200);
  expect(result.headers.get("x-thumbnail-source")).toBe("office-embedded");
  expect((await sharp(Buffer.from(await result.arrayBuffer())).metadata()).format).toBe("webp");
});

test("disk maintenance cannot hold a completed visible thumbnail response", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  __setThumbnailDiskTestHooks({ afterDirectoryOpen: () => held });
  try {
    // No cache directory exists yet, so only its creation by the writer reaches the hook.
    const result = await serveFileThumbnail(request("image.png"), { root, waitMs: 1000 });
    expect(result.status).toBe(200);
    expect(result.headers.get("x-thumbnail-cache")).toBe("generated");
    expect((await sharp(Buffer.from(await result.arrayBuffer())).metadata()).format).toBe("webp");
  } finally {
    release();
    __setThumbnailDiskTestHooks();
  }
});
