/**
 * Route-layer integration tests for the /api/file* surface (test matrix). These
 * exercise the REAL route modules (app/api/file/*): the check≠serve-inode
 * property must be asserted at the route layer,
 * where a path-reopen implementation passes every functional test and fails
 * only the race.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET as metaGET } from "../app/api/file/meta/route.ts";
import { GET as rawGET, HEAD as rawHEAD } from "../app/api/file/route.ts";
import { GET as textGET } from "../app/api/file/text/route.ts";
import { GET as imageGET } from "../app/api/image/[hash]/route.ts";
import { __resetCoordRootCache } from "./coord-reader.ts";
import { parseRange } from "./file-routes.ts";
import { TEXT_ENDPOINT_MAX_BYTES, TEXT_ENDPOINT_MAX_LINES, __resetFilesCaches } from "./files.ts";

// ---------------------------------------------------------------------------
// Fixture: a coord root the routes resolve via HARNERY_COORD_ROOT
// ---------------------------------------------------------------------------

let root: string;
let envBefore: string | undefined;

function w(rel: string, content: string | Buffer): string {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harn-routes-")));
  mkdirSync(path.join(root, ".harnery"), { recursive: true }); // coordRoot() requires it
  envBefore = process.env.HARNERY_COORD_ROOT;
  process.env.HARNERY_COORD_ROOT = root;
  __resetCoordRootCache();
  __resetFilesCaches();
  w("docs/plans/plan.md", "# A plan\n\nbody\n");
  w(".env", "ROOT_SECRET=1\n");
  w("assets/song.mp3", Buffer.from("0123456789abcdef"));
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: restoring env to truly-unset, not "" (a test-only teardown)
  if (envBefore === undefined) delete process.env.HARNERY_COORD_ROOT;
  else process.env.HARNERY_COORD_ROOT = envBefore;
  __resetCoordRootCache();
  __resetFilesCaches();
  rmSync(root, { recursive: true, force: true });
});

function req(p: string, extra: { headers?: Record<string, string>; download?: string } = {}) {
  const u = new URL("http://localhost/api/file");
  u.searchParams.set("path", p);
  if (extra.download !== undefined) u.searchParams.set("download", extra.download);
  return new Request(u, { headers: extra.headers });
}

// ---------------------------------------------------------------------------
// parseRange (pure)
// ---------------------------------------------------------------------------

describe("parseRange", () => {
  test("forms", () => {
    expect(parseRange(null, 100)).toEqual({ kind: "none" });
    expect(parseRange("bytes=0-9", 100)).toEqual({ kind: "range", start: 0, end: 9 });
    expect(parseRange("bytes=10-", 100)).toEqual({ kind: "range", start: 10, end: 99 });
    expect(parseRange("bytes=-5", 100)).toEqual({ kind: "range", start: 95, end: 99 });
    expect(parseRange("bytes=0-999", 100)).toEqual({ kind: "range", start: 0, end: 99 });
    expect(parseRange("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=5-2", 100)).toEqual({ kind: "ignore" });
    expect(parseRange("chunks=1-2", 100)).toEqual({ kind: "ignore" });
    expect(parseRange("bytes=0-1,5-6", 100)).toEqual({ kind: "ignore" });
  });
});

// ---------------------------------------------------------------------------
// GET /api/file: raw
// ---------------------------------------------------------------------------

describe("GET /api/file", () => {
  test("200 with body, security headers, etag", async () => {
    const res = rawGET(req("docs/plans/plan.md"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("etag")).toStartWith('W/"');
    expect(res.headers.get("content-length")).toBe("15");
    expect(await res.text()).toBe("# A plan\n\nbody\n");
  });

  test("missing ?path= → 400; denied → 403; missing file → 404", async () => {
    const noParam = rawGET(new Request("http://localhost/api/file"));
    expect(noParam.status).toBe(400);
    const denied = rawGET(req(".env"));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toBe("denied");
    const missing = rawGET(req("docs/never.md"));
    expect(missing.status).toBe(404);
  });

  test("oracle holds at the route layer: nonexistent file in a denied tree is still 403", () => {
    expect(rawGET(req(".credentials/nope.env")).status).toBe(403);
    // .credentials doesn't even exist in this fixture; still 403, not 404.
  });

  test("If-None-Match → 304", () => {
    const first = rawGET(req("docs/plans/plan.md"));
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();
    const second = rawGET(
      req("docs/plans/plan.md", { headers: { "if-none-match": etag as string } }),
    );
    expect(second.status).toBe(304);
  });

  test("Range: 206 slice, suffix, 416, malformed → 200", async () => {
    const slice = rawGET(req("assets/song.mp3", { headers: { range: "bytes=4-7" } }));
    expect(slice.status).toBe(206);
    expect(slice.headers.get("content-range")).toBe("bytes 4-7/16");
    expect(slice.headers.get("content-length")).toBe("4");
    expect(await slice.text()).toBe("4567");

    const suffix = rawGET(req("assets/song.mp3", { headers: { range: "bytes=-4" } }));
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe("cdef");

    const beyond = rawGET(req("assets/song.mp3", { headers: { range: "bytes=99-" } }));
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe("bytes */16");

    const malformed = rawGET(req("assets/song.mp3", { headers: { range: "bytes=5-2" } }));
    expect(malformed.status).toBe(200);
    expect(await malformed.text()).toBe("0123456789abcdef");
  });

  test("?download= forces sanitized content-disposition", () => {
    const res = rawGET(req("docs/plans/plan.md", { download: "../evil\r\nname.md" }));
    const cd = res.headers.get("content-disposition");
    expect(cd).not.toBeNull();
    expect(cd).toStartWith("attachment;");
    expect(cd).not.toContain("\r");
    expect(cd).not.toContain("/");
  });

  test("HEAD returns headers only", async () => {
    const res = rawHEAD(req("docs/plans/plan.md"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("15");
    expect(await res.text()).toBe("");
  });

  test("check≠serve inode: bytes consumed after a path swap are the opened inode's", async () => {
    w("docs/race.md", "original contents\n");
    const res = rawGET(req("docs/race.md"));
    expect(res.status).toBe(200);
    // The resolve + open + re-verify are done; the body is an unread fd
    // stream. Swap the live path to a denied secret NOW; a path-reopen
    // implementation would serve the secret; the fd must serve the original.
    rmSync(path.join(root, "docs", "race.md"));
    symlinkSync(path.join(root, ".env"), path.join(root, "docs", "race.md"));
    expect(await res.text()).toBe("original contents\n");
  });

  test("multi-open race: sequential requests are each pinned to their opened inode", async () => {
    w("docs/v.md", "version-one\n");
    const r1 = rawGET(req("docs/v.md", { headers: { range: "bytes=0-5" } }));
    // Replace via rename (NEW inode, the editor-save / git-checkout pattern;
    // an in-place write would legitimately show through the same inode).
    w("docs/v.md.tmp", "VERSION-TWO\n");
    renameSync(path.join(root, "docs", "v.md.tmp"), path.join(root, "docs", "v.md"));
    const r2 = rawGET(req("docs/v.md", { headers: { range: "bytes=0-5" } }));
    expect(await r1.text()).toBe("versio");
    expect(await r2.text()).toBe("VERSIO");
  });
});

// ---------------------------------------------------------------------------
// GET /api/file/meta
// ---------------------------------------------------------------------------

describe("GET /api/file/meta", () => {
  test("shape for a text file", async () => {
    const res = metaGET(req("docs/plans/plan.md"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.relPath).toBe("docs/plans/plan.md");
    expect(body.size).toBe(15);
    expect(body.category).toBe("markdown");
    expect(body.mime).toStartWith("text/plain");
    expect(body.inlineable).toBe(true);
    // Phantom-trailing-newline NOT counted; same semantics /text uses, so the
    // two endpoints agree (verification finding, 2026-06-11). "# A plan\n\nbody\n"
    // is 3 content lines, matching /text's `lines: 3` below.
    expect(body.lineCount).toBe(3);
    expect(body.truncated).toBe(false);
    expect(typeof body.mtime).toBe("string");
  });

  test("denied → 403 with the same error envelope as raw", async () => {
    const res = metaGET(req(".env"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("denied");
  });

  test("media file: no lineCount, inlineable true", async () => {
    const res = metaGET(req("assets/song.mp3"));
    const body = await res.json();
    expect(body.category).toBe("audio");
    expect(body.lineCount).toBeUndefined();
  });

  test("meta.truncated and text.truncated agree at exactly TEXT_ENDPOINT_MAX_LINES + trailing newline", async () => {
    // The boundary case the two endpoints disagreed on before the shared
    // line-counter (verification MEDIUM): N content lines + a trailing '\n'.
    const exact = Array.from({ length: TEXT_ENDPOINT_MAX_LINES }, (_, i) => `line ${i}`).join("\n");
    w("docs/exact.log", `${exact}\n`);
    const metaBody = await metaGET(req("docs/exact.log")).json();
    const textBody = await textGET(req("docs/exact.log")).json();
    expect(metaBody.lineCount).toBe(TEXT_ENDPOINT_MAX_LINES);
    expect(textBody.lines).toBe(TEXT_ENDPOINT_MAX_LINES);
    expect(metaBody.truncated).toBe(textBody.truncated);
    expect(metaBody.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/file/text
// ---------------------------------------------------------------------------

describe("GET /api/file/text", () => {
  test("returns content for text family", async () => {
    const res = textGET(req("docs/plans/plan.md"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("# A plan\n\nbody");
    expect(body.truncated).toBe(false);
    expect(body.lines).toBe(3);
  });

  test("line cap truncates with a flag, never silently", async () => {
    const big = Array.from({ length: TEXT_ENDPOINT_MAX_LINES + 500 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    w("docs/big.log", `${big}\n`);
    const res = textGET(req("docs/big.log"));
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.lines).toBe(TEXT_ENDPOINT_MAX_LINES);
  });

  test("non-text category → 415", async () => {
    const res = textGET(req("assets/song.mp3"));
    expect(res.status).toBe(415);
    expect((await res.json()).error).toBe("not_text");
  });

  test("denied → 403", () => {
    expect(textGET(req(".env")).status).toBe(403);
  });

  test("secret past the 4 KB head scan is still refused by the served-bytes rescan (verification NIT)", async () => {
    // A rescued .env.example survives the denylist; a real key past byte 4096
    // would otherwise be served. The /text endpoint rescans the bytes it's
    // about to expose.
    const padding = `${"# filler comment line\n".repeat(300)}`; // > 4 KB
    w(".env.example", `${padding}AWS_KEY=AKIAIOSFODNN7EXAMPLE\n`);
    const res = textGET(req(".env.example"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("secret_signature");
  });

  test("byte-cap with no newline in window doesn't end in U+FFFD (torn multibyte, verification LOW)", async () => {
    // Single-line file > 2 MB whose cap boundary splits a 3-byte char.
    const filler = "a".repeat(TEXT_ENDPOINT_MAX_BYTES - 1); // cap lands mid-euro (U+20AC, 3-byte)
    w("docs/oneline.json", `${filler}\u20AC${"b".repeat(10)}`);
    const res = textGET(req("docs/oneline.json"));
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.content.endsWith("\uFFFD")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/image/[hash]: fd migration regression
// ---------------------------------------------------------------------------

describe("GET /api/image/[hash] (fd-based)", () => {
  test("serves a content-addressed blob from the fd", async () => {
    const hash = "ab".repeat(32);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    w(`.harnery/images/${hash}.png`, bytes);
    const res = await imageGET(new Request(`http://localhost/api/image/${hash}`), {
      params: Promise.resolve({ hash }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(bytes)).toBe(true);
  });

  test("bad hash → 404", async () => {
    const res = await imageGET(new Request("http://localhost/api/image/nope"), {
      params: Promise.resolve({ hash: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  test("SVG blob carries CSP sandbox so it can't execute as a navigable document (verification HIGH)", async () => {
    const hash = "cd".repeat(32);
    w(
      `.harnery/images/${hash}.svg`,
      "<svg xmlns='http://www.w3.org/2000/svg'><script>x</script></svg>",
    );
    const res = await imageGET(new Request(`http://localhost/api/image/${hash}`), {
      params: Promise.resolve({ hash }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });
});
