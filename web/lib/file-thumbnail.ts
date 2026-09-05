import { closeSync, createReadStream, fstatSync } from "node:fs";
import sharp from "sharp";
import { fileErrorResponse } from "./file-routes";
import { type ResolveOptions, resolveFile } from "./files";

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const CACHE_BYTES = 16 * 1024 * 1024;
const cache = new Map<string, Buffer>();
let cacheBytes = 0;
let active = 0;
const waiting: Array<() => void> = [];

function problem(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

/** Limit simultaneous image decoders without making a grid load originals. */
async function acquire(): Promise<boolean> {
  if (active < 2) {
    active++;
    return true;
  }
  if (waiting.length >= 64) return false;
  await new Promise<void>((resolve) => waiting.push(resolve));
  return true;
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

function remember(key: string, bytes: Buffer): void {
  const previous = cache.get(key);
  if (previous) cacheBytes -= previous.length;
  cache.delete(key);
  cache.set(key, bytes);
  cacheBytes += bytes.length;
  while (cacheBytes > CACHE_BYTES || cache.size > 128) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheBytes -= cache.get(oldest)!.length;
    cache.delete(oldest);
  }
}

/** Read only the resolver's checked fd; never reopen a user-controlled path. */
export async function serveFileThumbnail(
  req: Request,
  opts: ResolveOptions = {},
): Promise<Response> {
  const path = new URL(req.url).searchParams.get("path");
  if (!path) return problem("invalid_path", 400);
  const file = resolveFile(path, opts);
  if (!file.ok) return fileErrorResponse(file);
  try {
    if (file.category !== "image") return problem("not_image", 415);
    if (file.size > MAX_SOURCE_BYTES) return problem("too_large", 413);
    const stat = fstatSync(file.fd);
    const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const etag = `W/"thumb-${key}"`;
    const headers = {
      "content-type": "image/webp",
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      etag,
    };
    if (req.headers.get("if-none-match") === etag)
      return new Response(null, { status: 304, headers });
    let bytes = cache.get(key);
    if (bytes) {
      cache.delete(key);
      cache.set(key, bytes);
    } else {
      if (!(await acquire())) return problem("thumbnail_busy", 503);
      try {
        if (req.signal.aborted) return problem("cancelled", 499);
        const chunks: Buffer[] = [];
        const stream = createReadStream("", {
          fd: file.fd,
          autoClose: false,
          start: 0,
          end: Math.min(file.size, MAX_SOURCE_BYTES) - 1,
        });
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        bytes = await sharp(Buffer.concat(chunks), {
          limitInputPixels: 32_000_000,
          animated: false,
        })
          .rotate()
          .resize(360, 240, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 72 })
          .timeout({ seconds: 5 })
          .toBuffer();
        remember(key, bytes);
      } catch {
        return problem("thumbnail_unavailable", 422);
      } finally {
        release();
      }
    }
    return new Response(new Uint8Array(bytes), { headers });
  } finally {
    closeSync(file.fd);
  }
}
