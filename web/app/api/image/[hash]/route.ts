/**
 * Byte-serving route for the image feed. Streams a content-addressed blob from
 * `.harnery/images/<hash>.<ext>`. The hash is a bare sha256 hex (validated in
 * `resolveBlob`), so there's no path-traversal surface. Content-addressed =
 * immutable, so the response is aggressively cacheable.
 *
 * Streams from the fd `resolveBlob` returns, never a re-open by path. The old
 * `readFileSync(blob.path)` here was the check-then-reopen TOCTOU shape the
 * universal-file-viewer flags.
 */

import { closeSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { resolveBlob, resolveThumb } from "@/lib/images";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ hash: string }> },
): Promise<Response> {
  const { hash } = await ctx.params;
  const url = new URL(req.url);
  const download = url.searchParams.get("download");
  const wRaw = url.searchParams.get("w");

  // Thumbnail fast path for the gallery grid: `?w=<px>` serves a small cached
  // WebP instead of the multi-MB full-page-screenshot blob (the difference
  // between smooth scroll and a hang). Skipped for `?download` (always the
  // real file). Falls through to the full blob when the thumb can't be made —
  // bad width, vector/animated source, or no sharp on this host.
  if (wRaw && !download) {
    const thumb = await resolveThumb(hash, Number(wRaw));
    if (thumb) {
      const headers: Record<string, string> = {
        "content-type": thumb.contentType,
        "content-length": String(thumb.size),
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      };
      if (thumb.size === 0) {
        closeSync(thumb.fd);
        return new Response(null, { headers });
      }
      const stream = createReadStream("", { fd: thumb.fd, autoClose: true });
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
        headers,
      });
    }
  }

  const blob = resolveBlob(hash);
  if (!blob) {
    return Response.json({ error: "not_found", hash }, { status: 404 });
  }

  const headers: Record<string, string> = {
    "content-type": blob.contentType,
    "content-length": String(blob.size),
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    // The image store content-addresses SVGs too (IMAGE_EXTS includes "svg"),
    // and the gallery's "open in new tab" top-level-navigates here. An
    // image/svg+xml document navigated to executes its embedded <script> in
    // the dashboard's origin; nosniff doesn't help (the type is already
    // correct). `sandbox` gives the response a unique origin with scripts
    // disabled. Applied unconditionally: IMAGE_EXTS is raster + svg only (no
    // PDF), and <img>/<audio>/<video> consumers ignore response CSP, so the
    // lightbox/embed paths pay nothing. Mirrors the file route's defense.
    "content-security-policy": "sandbox",
  };

  // `?download=<name>` → force a download with the agent-facing filename
  // (the basename of the source path, not the content hash). Sanitized to a
  // bare filename so it can't smuggle CRLF / path separators into the header.
  if (download) {
    const safe = download.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || `image.${blob.ext}`;
    headers["content-disposition"] = `attachment; filename="${safe}"`;
  }

  if (blob.size === 0) {
    closeSync(blob.fd);
    return new Response(null, { headers });
  }
  // autoClose hands fd ownership to the stream (closed on end / error / abort).
  const stream = createReadStream("", { fd: blob.fd, autoClose: true });
  // Node's web-streams type and the DOM lib's don't structurally overlap.
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
    headers,
  });
}
