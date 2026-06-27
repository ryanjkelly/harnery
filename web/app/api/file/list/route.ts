/**
 * Directory listing for the file-browser tree. Resolves ONE directory's
 * immediate children through the same containment + deny model as the raw/meta
 * routes (lib/file-tree.ts `listDir`, which reuses lib/files.ts primitives), so
 * the tree can never escape the repo root or surface a denied/secret file.
 *
 *   GET /api/file/list            list the repo root
 *   GET /api/file/list?dir=<rel>  list a subdirectory
 */

import { fileErrorResponse } from "@/lib/file-routes";
import { listDir } from "@/lib/file-tree";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request): Response {
  const dir = new URL(req.url).searchParams.get("dir") ?? "";
  const r = listDir(dir);
  if (!r.ok) return fileErrorResponse(r);
  return Response.json(
    { dir: r.dir, entries: r.entries },
    { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}
