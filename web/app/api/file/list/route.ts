/**
 * Directory listing for the file-browser tree. Resolves ONE directory's
 * immediate children through the same containment + deny model as the raw/meta
 * routes (lib/file-tree.ts `listDir`, which reuses lib/files.ts primitives), so
 * the tree can never escape the repo root or surface a denied/secret file.
 *
 *   GET /api/file/list            list the repo root
 *   GET /api/file/list?dir=<rel>  list a subdirectory
 */

import { listBrowseDir } from "@/lib/browse-catalog";
import { fileErrorResponse } from "@/lib/file-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const started = performance.now();
  const dir = new URL(req.url).searchParams.get("dir") ?? "";
  const r = await listBrowseDir(dir);
  if (!r.ok) return fileErrorResponse(r);
  return Response.json(
    { dir: r.dir, entries: r.entries, workspace: r.workspace },
    {
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "server-timing": `listing;dur=${(performance.now() - started).toFixed(1)}`,
      },
    },
  );
}
