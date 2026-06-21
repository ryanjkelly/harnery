/**
 * Archive entry listing: names + sizes, no extraction. Reuses the
 * resolveFile fd (security in one place); fflate/tar parsing is server-side
 * only, so no archive code reaches the client bundle.
 */

import { serveArchiveListing } from "@/lib/file-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request): Response {
  return serveArchiveListing(req);
}
