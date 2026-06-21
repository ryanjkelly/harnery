/**
 * Metadata endpoint for the universal file viewer. The viewer hits this
 * first to pick a renderer and decide inline-vs-download. Same `resolveFile`
 * pipeline as the raw route: the security check lives in exactly one place.
 */

import { serveFileMeta } from "@/lib/file-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request): Response {
  return serveFileMeta(req);
}
