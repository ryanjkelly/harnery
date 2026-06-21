/**
 * Capped UTF-8 text body for the text-family renderers: code,
 * markdown, json, yaml, csv, log. Server-side line + byte caps with a
 * `truncated` flag so a 200 MB log can't OOM the tab (or the server).
 */

import { serveFileText } from "@/lib/file-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request): Response {
  return serveFileText(req);
}
