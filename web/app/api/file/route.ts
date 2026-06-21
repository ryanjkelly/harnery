/**
 * Raw-byte serving for the universal file viewer. Path travels as a
 * query param (`?path=`) to sidestep route-segment encoding pain with slashes.
 * Honors Range (206) for audio/video scrubbing, revalidates via ETag
 * (mtime+size, since files change, never `immutable`), `?download=<name>` forces
 * content-disposition. All bytes come from the fd `resolveFile` returns,
 * never a re-open by path (TOCTOU).
 */

import { serveRawFile } from "@/lib/file-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request): Response {
  return serveRawFile(req);
}

export function HEAD(req: Request): Response {
  return serveRawFile(req, { headOnly: true });
}
