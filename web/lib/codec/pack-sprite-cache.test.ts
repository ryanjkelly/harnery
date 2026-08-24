import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import { loadCachedPackSprite } from "./pack-sprite-cache";
import {
  ROSTER_EXPRESSIONS,
  ROSTER_SPRITE_COLUMNS,
  ROSTER_SPRITE_ROWS,
  ROSTER_SPRITE_TILE_HEIGHT,
  ROSTER_SPRITE_TILE_WIDTH,
} from "./packs";

test("builds and coalesces one correctly sized roster sprite", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codec-pack-sprite-"));
  try {
    const source = path.join(dir, "portrait.webp");
    await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 20, g: 120, b: 220, alpha: 1 },
      },
    })
      .webp()
      .toFile(source);

    const descriptor = {
      cacheKey: dir,
      filePaths: ROSTER_EXPRESSIONS.map(() => source),
      packVersion: "1",
    };
    const [first, concurrent] = await Promise.all([
      loadCachedPackSprite(descriptor),
      loadCachedPackSprite(descriptor),
    ]);
    const repeat = await loadCachedPackSprite(descriptor);
    const metadata = await sharp(first.body).metadata();

    expect(concurrent).toBe(first);
    expect(repeat).toBe(first);
    expect(first.contentType).toBe("image/webp");
    expect(metadata.width).toBe(ROSTER_SPRITE_COLUMNS * ROSTER_SPRITE_TILE_WIDTH);
    expect(metadata.height).toBe(ROSTER_SPRITE_ROWS * ROSTER_SPRITE_TILE_HEIGHT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
