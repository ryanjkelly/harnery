/**
 * Host-based files origin. Requests to `harnery-files.localhost` are rewritten
 * to `/api/file`; the repo path travels in `x-harnery-files-path` (Next rewrites
 * to App Router handlers often drop rewritten search params). Navigable MIME is
 * keyed off Host — never a client-supplied query flag.
 */

import { FILES_ORIGIN_HEADER, FILES_ORIGIN_HOST, isFilesOriginHost } from "@/lib/files-origin";
import { type NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  if (!isFilesOriginHost(req.headers.get("host"))) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;

  // Files host is file-bytes only — no dashboard routes or Next internals.
  if (pathname.startsWith("/_next/") || pathname.startsWith("/api/")) {
    return new NextResponse("Not found", { status: 404 });
  }

  if (pathname === "/" || pathname === "") {
    return new NextResponse(
      [
        "Harnery files origin",
        "",
        `Open a repo-relative path on this host, e.g.`,
        `  http://${FILES_ORIGIN_HOST}/docs/page.html`,
        "",
        "Same allowlist as the dashboard file viewer; HTML/JS/CSS use real browser MIME types.",
      ].join("\n"),
      {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      },
    );
  }

  // Pathname is already URL-decoded once by the platform; pass through as the
  // repo-relative path (resolveFile rejects residual %XX laundering).
  const relPath = pathname.replace(/^\/+/, "");
  if (!relPath) {
    return new NextResponse("Not found", { status: 404 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/api/file";
  url.search = "";

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(FILES_ORIGIN_HEADER, relPath);
  return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/:path*"],
};
