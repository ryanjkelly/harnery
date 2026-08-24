import { createHash } from "node:crypto";
import fs from "node:fs";

import sharp from "sharp";

import type { CachedPackAsset } from "./pack-asset-cache";
import {
  type PackSpriteDescriptor,
  ROSTER_SPRITE_COLUMNS,
  ROSTER_SPRITE_ROWS,
  ROSTER_SPRITE_TILE_HEIGHT,
  ROSTER_SPRITE_TILE_WIDTH,
} from "./packs";

const MAX_SPRITE_CACHE_ENTRIES = 64;

const spriteCache = new Map<string, Promise<CachedPackAsset>>();

/**
 * Build and retain one WebP sprite per immutable pack version. Repeated
 * requests for the same pack share the in-flight render instead of starting
 * parallel Sharp pipelines.
 */
export async function loadCachedPackSprite(
  descriptor: PackSpriteDescriptor,
): Promise<CachedPackAsset> {
  const key = `${descriptor.cacheKey}\0${descriptor.packVersion}`;
  const cached = spriteCache.get(key);
  if (cached) {
    spriteCache.delete(key);
    spriteCache.set(key, cached);
    return cached;
  }

  const pending = renderPackSprite(descriptor);
  spriteCache.set(key, pending);
  if (spriteCache.size > MAX_SPRITE_CACHE_ENTRIES) {
    const oldest = spriteCache.keys().next().value;
    if (oldest !== undefined && oldest !== key) spriteCache.delete(oldest);
  }

  try {
    return await pending;
  } catch (error) {
    spriteCache.delete(key);
    throw error;
  }
}

async function renderPackSprite(descriptor: PackSpriteDescriptor): Promise<CachedPackAsset> {
  const [tiles, stats] = await Promise.all([
    Promise.all(
      descriptor.filePaths.map(async (filePath, index) => ({
        input: await sharp(filePath)
          .resize(ROSTER_SPRITE_TILE_WIDTH, ROSTER_SPRITE_TILE_HEIGHT, {
            fit: "cover",
            position: "centre",
          })
          .webp({ quality: 82, smartSubsample: true })
          .toBuffer(),
        left: (index % ROSTER_SPRITE_COLUMNS) * ROSTER_SPRITE_TILE_WIDTH,
        top: Math.floor(index / ROSTER_SPRITE_COLUMNS) * ROSTER_SPRITE_TILE_HEIGHT,
      })),
    ),
    Promise.all(descriptor.filePaths.map((filePath) => fs.promises.stat(filePath))),
  ]);

  const output = await sharp({
    create: {
      width: ROSTER_SPRITE_COLUMNS * ROSTER_SPRITE_TILE_WIDTH,
      height: ROSTER_SPRITE_ROWS * ROSTER_SPRITE_TILE_HEIGHT,
      channels: 4,
      background: { r: 9, g: 11, b: 17, alpha: 1 },
    },
  })
    .composite(tiles)
    .webp({ quality: 82, effort: 3, smartSubsample: true })
    .toBuffer();
  const mtimeMs = Math.max(...stats.map((stat) => stat.mtimeMs));
  const hash = createHash("sha256").update(output).digest("base64url").slice(0, 22);

  return {
    body: new Uint8Array(output),
    contentType: "image/webp",
    etag: `"${hash}"`,
    lastModified: new Date(mtimeMs).toUTCString(),
    mtimeMs,
  };
}
