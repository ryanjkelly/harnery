import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadCachedPackAsset, packAssetHeaders, packAssetNotModified } from "./pack-asset-cache";

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
});
