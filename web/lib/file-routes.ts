/**
 * Route logic for the universal-file-viewer API surface:
 *
 *   GET /api/file?path=<rel>        raw bytes (Range/206, ETag/304, ?download=)
 *   GET /api/file/meta?path=<rel>   JSON metadata for renderer dispatch
 *   GET /api/file/text?path=<rel>   capped UTF-8 body for text-family renderers
 *
 * All three reuse `resolveFile` and READ FROM THE FD IT RETURNS, never a
 * second path-open (TOCTOU; a path-reopen passes every functional test and
 * fails only the race). The security check
 * lives in exactly one place (lib/files.ts); this module owns HTTP semantics.
 */

import { closeSync, createReadStream, readSync } from "node:fs";
import { Readable } from "node:stream";
import { type ArchiveListing, listArchive } from "./file-viewer/archive";
import {
  type ResolveReject,
  type ResolvedFile,
  TEXT_ENDPOINT_MAX_BYTES,
  TEXT_ENDPOINT_MAX_LINES,
  TEXT_INLINE_CAP_BYTES,
  isTextCategory,
  resolveFile,
  scanChunk,
} from "./files";

/** Cap the archive bytes read into memory for listing (zip-bomb / OOM guard). */
const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const NOSNIFF = "nosniff";

export function fileErrorResponse(r: ResolveReject): Response {
  return Response.json(
    { error: r.code, detail: r.detail ?? null },
    {
      status: r.status,
      headers: { "x-content-type-options": NOSNIFF, "cache-control": "no-store" },
    },
  );
}

function missingPathResponse(): Response {
  return Response.json(
    { error: "invalid_path", detail: "missing ?path= query param" },
    { status: 400, headers: { "x-content-type-options": NOSNIFF, "cache-control": "no-store" } },
  );
}

/** Weak ETag from mtime+size: files change, so the cache revalidates instead
 * of being immutable like the content-addressed image route. */
function etagFor(f: ResolvedFile): string {
  return `W/"${f.size}-${Math.round(f.mtimeMs)}"`;
}

function baseHeaders(f: ResolvedFile): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": f.mime,
    "accept-ranges": "bytes",
    etag: etagFor(f),
    "cache-control": "private, no-cache",
    "x-content-type-options": NOSNIFF,
  };
  // CSP sandbox: a directly-navigated response gets a unique origin with
  // scripts disabled, the svg/html escape hatch ("never become
  // same-origin script"). PDF is the one exemption: Chrome's PDF viewer
  // document is blocked by a sandbox CSP. <img>/<audio>/<video> consumers
  // ignore response CSP entirely, so this costs the embed paths nothing.
  if (f.category !== "pdf") {
    headers["content-security-policy"] = "sandbox";
  }
  return headers;
}

/** Sanitized attachment filename, same shape as the image route: bare
 * filename only, no CRLF/path-separator smuggling into the header. */
function contentDisposition(name: string, fallback: string): string {
  const safe = name.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || fallback;
  return `attachment; filename="${safe}"`;
}

function ifNoneMatchHits(req: Request, etag: string): boolean {
  const inm = req.headers.get("if-none-match");
  if (!inm) return false;
  return inm.split(",").some((t) => t.trim() === etag || t.trim() === "*");
}

/** Count content lines the way both /meta and /text must agree on: a single
 * trailing-newline phantom entry is NOT counted. Shared so the two endpoints
 * can never drift (they disagreed at exactly TEXT_ENDPOINT_MAX_LINES + a
 * trailing newline before this was factored out). */
function countContentLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") return lines.length - 1;
  return lines.length;
}

/** Read [start, start+len) from the fd into a Buffer via positioned reads. */
function readFromFd(fd: number, start: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, start + got);
    if (n === 0) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}

/** fd → web ReadableStream for [start, end] inclusive. autoClose hands fd
 * ownership to the stream (closed on end, error, and client-abort destroy). */
function fdStream(fd: number, start: number, end: number): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream("", { fd, start, end, autoClose: true });
  // Node's web-streams type and the DOM lib's don't structurally overlap.
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Range parsing (single-range only; multi-range is ignored → 200 full body)
// ---------------------------------------------------------------------------

type RangeParse =
  | { kind: "none" }
  | { kind: "ignore" } // malformed per RFC 9110 → serve 200 full
  | { kind: "unsatisfiable" }
  | { kind: "range"; start: number; end: number };

export function parseRange(header: string | null, size: number): RangeParse {
  if (!header) return { kind: "none" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { kind: "ignore" };
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return { kind: "ignore" };
  if (rawStart === "") {
    // Suffix range: last N bytes.
    const n = Number(rawEnd);
    if (!Number.isSafeInteger(n) || n === 0) return { kind: "unsatisfiable" };
    if (size === 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, size - n);
    return { kind: "range", start, end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) return { kind: "ignore" };
  if (start >= size) return { kind: "unsatisfiable" };
  let end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(end)) return { kind: "ignore" };
  if (end < start) return { kind: "ignore" };
  if (end >= size) end = size - 1;
  return { kind: "range", start, end };
}

// ---------------------------------------------------------------------------
// GET /api/file: raw bytes
// ---------------------------------------------------------------------------

export function serveRawFile(req: Request, opts: { headOnly?: boolean } = {}): Response {
  const url = new URL(req.url);
  const pathParam = url.searchParams.get("path");
  if (!pathParam) return missingPathResponse();
  const r = resolveFile(pathParam);
  if (!r.ok) return fileErrorResponse(r);

  // From here the fd is owned by exactly one of: an early-return closeSync, or
  // fdStream(autoClose). The catch is insurance against a leak on any
  // unexpected throw in between.
  try {
    return serveRawResolved(req, url, r, opts);
  } catch (err) {
    try {
      closeSync(r.fd);
    } catch {
      // stream may already own + have closed it
    }
    throw err;
  }
}

function serveRawResolved(
  req: Request,
  url: URL,
  r: ResolvedFile,
  opts: { headOnly?: boolean },
): Response {
  const headers = baseHeaders(r);
  const download = url.searchParams.get("download");
  if (download !== null) {
    headers["content-disposition"] = contentDisposition(
      download,
      r.relPath.split("/").pop() ?? "file",
    );
  }

  if (ifNoneMatchHits(req, etagFor(r))) {
    closeSync(r.fd);
    return new Response(null, { status: 304, headers });
  }

  const range = parseRange(req.headers.get("range"), r.size);
  if (range.kind === "unsatisfiable") {
    closeSync(r.fd);
    headers["content-range"] = `bytes */${r.size}`;
    return new Response(null, { status: 416, headers });
  }

  if (opts.headOnly) {
    closeSync(r.fd);
    headers["content-length"] = String(r.size);
    return new Response(null, { status: 200, headers });
  }

  if (range.kind === "range") {
    headers["content-range"] = `bytes ${range.start}-${range.end}/${r.size}`;
    headers["content-length"] = String(range.end - range.start + 1);
    return new Response(fdStream(r.fd, range.start, range.end), { status: 206, headers });
  }

  headers["content-length"] = String(r.size);
  if (r.size === 0) {
    closeSync(r.fd);
    return new Response(null, { status: 200, headers });
  }
  return new Response(fdStream(r.fd, 0, r.size - 1), { status: 200, headers });
}

// ---------------------------------------------------------------------------
// GET /api/file/meta: renderer-dispatch metadata
// ---------------------------------------------------------------------------

export function serveFileMeta(req: Request): Response {
  const url = new URL(req.url);
  const pathParam = url.searchParams.get("path");
  if (!pathParam) return missingPathResponse();
  const r = resolveFile(pathParam);
  if (!r.ok) return fileErrorResponse(r);

  try {
    let lineCount: number | undefined;
    let truncated: boolean | undefined;
    if (isTextCategory(r.category)) {
      if (r.size <= TEXT_INLINE_CAP_BYTES) {
        // Whole-file read FROM THE FD (≤ 5 MB by the guard above). Count lines
        // with the SAME phantom-trailing-newline semantics /text uses, so
        // meta.truncated and text.truncated agree at the cap boundary.
        const body = readFromFd(r.fd, 0, r.size);
        lineCount = countContentLines(body.toString("utf-8"));
        truncated = r.size > TEXT_ENDPOINT_MAX_BYTES || lineCount > TEXT_ENDPOINT_MAX_LINES;
      } else {
        truncated = true;
      }
    }
    return Response.json(
      {
        relPath: r.relPath,
        size: r.size,
        mtime: new Date(r.mtimeMs).toISOString(),
        mime: r.mime,
        category: r.category,
        inlineable: r.inlineable,
        ...(lineCount !== undefined ? { lineCount } : {}),
        ...(truncated !== undefined ? { truncated } : {}),
      },
      {
        headers: {
          "x-content-type-options": NOSNIFF,
          "cache-control": "private, no-cache",
          etag: etagFor(r),
        },
      },
    );
  } finally {
    closeSync(r.fd);
  }
}

// ---------------------------------------------------------------------------
// GET /api/file/text: capped UTF-8 body for text-family renderers
// ---------------------------------------------------------------------------

export function serveFileText(req: Request): Response {
  const url = new URL(req.url);
  const pathParam = url.searchParams.get("path");
  if (!pathParam) return missingPathResponse();
  const r = resolveFile(pathParam);
  if (!r.ok) return fileErrorResponse(r);

  try {
    if (!isTextCategory(r.category)) {
      return Response.json(
        { error: "not_text", detail: `category "${r.category}" has no text body` },
        {
          status: 415,
          headers: { "x-content-type-options": NOSNIFF, "cache-control": "no-store" },
        },
      );
    }

    const byteCap = Math.min(r.size, TEXT_ENDPOINT_MAX_BYTES);
    const raw = readFromFd(r.fd, 0, byteCap);
    // Defense-in-depth beyond the 4 KB head scan: re-scan the bytes ACTUALLY
    // being exposed for a secret signature. The resolveFile scan only sees the
    // first 4 KB; a key past byte 4096 in an allowlisted (or soft-rescued, e.g.
    // .env.example) text file would otherwise be served. The buffer's already
    // in hand, so this is marginal cost. (Additive hardening, review 2026-06-11.)
    if (scanChunk(raw).secret) {
      return Response.json(
        { error: "secret_signature", detail: "content carries a secret-shaped signature" },
        {
          status: 403,
          headers: { "x-content-type-options": NOSNIFF, "cache-control": "no-store" },
        },
      );
    }
    let text = raw.toString("utf-8");
    const truncatedByBytes = r.size > TEXT_ENDPOINT_MAX_BYTES;
    if (truncatedByBytes) {
      // Drop the partial tail line (and any torn multibyte sequence with it)
      // so the preview never ends mid-line.
      const lastNl = text.lastIndexOf("\n");
      if (lastNl >= 0) {
        text = text.slice(0, lastNl + 1);
      } else if (text.endsWith("\uFFFD")) {
        // No newline in the 2 MB window (minified bundle / single-line JSON):
        // no tail line to drop, but the byte cap may have split a multibyte
        // sequence into a trailing U+FFFD. Strip it so the comment's promise
        // ("never ends mid-line / mid-char") holds.
        text = text.slice(0, -1);
      }
    }
    let lines = text.split("\n");
    // A trailing newline yields one empty phantom entry; don't count it.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
    let truncatedByLines = false;
    if (lines.length > TEXT_ENDPOINT_MAX_LINES) {
      lines = lines.slice(0, TEXT_ENDPOINT_MAX_LINES);
      truncatedByLines = true;
    }
    const truncated = truncatedByBytes || truncatedByLines;
    return Response.json(
      {
        relPath: r.relPath,
        size: r.size,
        mtime: new Date(r.mtimeMs).toISOString(),
        mime: r.mime,
        category: r.category,
        content: lines.join("\n"),
        lines: lines.length,
        truncated,
      },
      {
        headers: {
          "x-content-type-options": NOSNIFF,
          "cache-control": "private, no-cache",
          etag: etagFor(r),
        },
      },
    );
  } finally {
    closeSync(r.fd);
  }
}

// ---------------------------------------------------------------------------
// GET /api/file/archive: archive entry listing (names + sizes, no extraction)
// ---------------------------------------------------------------------------

export function serveArchiveListing(req: Request): Response {
  const url = new URL(req.url);
  const pathParam = url.searchParams.get("path");
  if (!pathParam) return missingPathResponse();
  const r = resolveFile(pathParam);
  if (!r.ok) return fileErrorResponse(r);

  try {
    if (r.category !== "archive") {
      return Response.json(
        { error: "not_archive", detail: `category "${r.category}" is not an archive` },
        {
          status: 415,
          headers: { "x-content-type-options": NOSNIFF, "cache-control": "no-store" },
        },
      );
    }
    if (r.size > ARCHIVE_MAX_BYTES) {
      return Response.json(
        { error: "too_large", detail: `archive exceeds ${ARCHIVE_MAX_BYTES} bytes` },
        {
          status: 413,
          headers: { "x-content-type-options": NOSNIFF, "cache-control": "no-store" },
        },
      );
    }
    const buf = readFromFd(r.fd, 0, r.size);
    const ext = (r.relPath.split(".").pop() ?? "").toLowerCase();
    let listing: ArchiveListing;
    try {
      listing = listArchive(new Uint8Array(buf), ext);
    } catch (err) {
      return Response.json(
        { error: "corrupt_archive", detail: (err as Error).message },
        {
          status: 422,
          headers: { "x-content-type-options": NOSNIFF, "cache-control": "no-store" },
        },
      );
    }
    return Response.json(
      { relPath: r.relPath, size: r.size, ...listing },
      {
        headers: {
          "x-content-type-options": NOSNIFF,
          "cache-control": "private, no-cache",
          etag: etagFor(r),
        },
      },
    );
  } finally {
    closeSync(r.fd);
  }
}
