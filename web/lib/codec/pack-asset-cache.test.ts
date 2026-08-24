import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import {
  loadCachedPackAsset,
  packAssetHeaders,
  packAssetNotModified,
  ROSTER_THUMBNAIL_WIDTH,
} from "./pack-asset-cache";

describe("Codec pack asset cache", () => {
  test("caches immutable bytes by pack version and emits conditional validators", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codec-pack-cache-"));
    const filePath = path.join(dir, "neutral.webp");
    writeFileSync(filePath, "version-one");
    const descriptor = { filePath, contentType: "image/webp", packVersion: "1" };

    const first = await loadCachedPackAsset(descriptor);
    const second = await loadCachedPackAsset(descriptor);
    expect(second).toBe(first);
    expect(new TextDecoder().decode(first.body)).toBe("version-one");

    const headers = packAssetHeaders(first);
    expect(headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(headers.etag).toBe(first.etag);
    expect(headers["content-length"]).toBe(String(first.body.byteLength));
    expect(
      packAssetNotModified(
        new Request("http://localhost/image", { headers: { "if-none-match": first.etag } }),
        first,
      ),
    ).toBe(true);
    expect(
      packAssetNotModified(
        new Request("http://localhost/image", {
          headers: { "if-modified-since": first.lastModified },
        }),
        first,
      ),
    ).toBe(true);

    writeFileSync(filePath, "version-two");
    const next = await loadCachedPackAsset({ ...descriptor, packVersion: "2" });
    expect(new TextDecoder().decode(next.body)).toBe("version-two");
    expect(next.etag).not.toBe(first.etag);
    rmSync(dir, { recursive: true, force: true });
  });

  test("caches a bounded WebP roster thumbnail separately from the source", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codec-pack-thumbnail-"));
    try {
      const filePath = path.join(dir, "neutral.png");
      await sharp({
        create: {
          width: 512,
          height: 768,
          channels: 4,
          background: { r: 10, g: 80, b: 160, alpha: 1 },
        },
      })
        .png()
        .toFile(filePath);
      const descriptor = { filePath, contentType: "image/png", packVersion: "1" };

      const source = await loadCachedPackAsset(descriptor);
      const thumbnail = await loadCachedPackAsset(descriptor, "roster");
      const repeat = await loadCachedPackAsset(descriptor, "roster");
      const metadata = await sharp(thumbnail.body).metadata();

      expect(repeat).toBe(thumbnail);
      expect(thumbnail).not.toBe(source);
      expect(thumbnail.contentType).toBe("image/webp");
      expect(metadata.width).toBe(ROSTER_THUMBNAIL_WIDTH);
      expect(metadata.height).toBe(384);
      expect(thumbnail.body.byteLength).toBeLessThan(source.body.byteLength);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
