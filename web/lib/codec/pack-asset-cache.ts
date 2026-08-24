import { createHash } from "node:crypto";
import fs from "node:fs";

import sharp from "sharp";

const MAX_ASSET_CACHE_ENTRIES = 512;
export const ROSTER_THUMBNAIL_WIDTH = 256;

export type PackAssetVariant = "source" | "roster";

export interface PackAssetDescriptor {
  filePath: string;
  contentType: string;
  packVersion: string;
}

export interface CachedPackAsset {
  body: Uint8Array;
  contentType: string;
  etag: string;
  lastModified: string;
  mtimeMs: number;
}

const assetCache = new Map<string, Promise<CachedPackAsset>>();

/**
 * Pack versions make portrait bytes immutable. Keep the current 21-image
 * fleet in memory so repeat views never reopen hundreds of small files, and
 * coalesce concurrent requests for the same portrait.
 */
export async function loadCachedPackAsset(
  descriptor: PackAssetDescriptor,
  variant: PackAssetVariant = "source",
): Promise<CachedPackAsset> {
  const key = `${descriptor.filePath}\0${descriptor.packVersion}\0${variant}`;
  const cached = assetCache.get(key);
  if (cached) {
    assetCache.delete(key);
    assetCache.set(key, cached);
    return cached;
  }

  const pending = readPackAsset(descriptor, variant);
  assetCache.set(key, pending);
  if (assetCache.size > MAX_ASSET_CACHE_ENTRIES) {
    const oldest = assetCache.keys().next().value;
    if (oldest !== undefined && oldest !== key) assetCache.delete(oldest);
  }

  try {
    return await pending;
  } catch (error) {
    assetCache.delete(key);
    throw error;
  }
}

async function readPackAsset(
  descriptor: PackAssetDescriptor,
  variant: PackAssetVariant,
): Promise<CachedPackAsset> {
  const [source, stat] = await Promise.all([
    fs.promises.readFile(descriptor.filePath),
    fs.promises.stat(descriptor.filePath),
  ]);
  const body =
    variant === "roster"
      ? await sharp(source)
          .resize({ width: ROSTER_THUMBNAIL_WIDTH, withoutEnlargement: true })
          .webp({ quality: 82, effort: 2 })
          .toBuffer()
      : source;
  const hash = createHash("sha256").update(body).digest("base64url").slice(0, 22);
  return {
    body: new Uint8Array(body),
    contentType: variant === "roster" ? "image/webp" : descriptor.contentType,
    etag: `"${hash}"`,
    lastModified: stat.mtime.toUTCString(),
    mtimeMs: stat.mtimeMs,
  };
}

export function packAssetHeaders(asset: CachedPackAsset): Record<string, string> {
  return {
    "cache-control": "public, max-age=31536000, immutable",
    "content-length": String(asset.body.byteLength),
    "content-type": asset.contentType,
    etag: asset.etag,
    "last-modified": asset.lastModified,
    "x-content-type-options": "nosniff",
  };
}

export function packAssetNotModified(request: Request, asset: CachedPackAsset): boolean {
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch) {
    return ifNoneMatch.split(",").some((tag) => tag.trim() === asset.etag || tag.trim() === "*");
  }

  const ifModifiedSince = request.headers.get("if-modified-since");
  if (!ifModifiedSince) return false;
  const since = Date.parse(ifModifiedSince);
  if (!Number.isFinite(since)) return false;
  return Math.floor(asset.mtimeMs / 1000) * 1000 <= since;
}
