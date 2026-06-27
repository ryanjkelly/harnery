/**
 * Recursive disk usage + file/folder counts for a directory, plus a per-
 * immediate-child breakdown (lib/file-tree.ts `dirUsage`). Excludes everything
 * the listing hides (node_modules, .git, secrets); capped + TTL-cached.
 *
 *   GET /api/file/usage            usage for the repo root
 *   GET /api/file/usage?dir=<rel>  usage for a subdirectory
 */

import { fileErrorResponse } from "@/lib/file-routes";
import { dirUsage } from "@/lib/file-tree";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request): Response {
  const dir = new URL(req.url).searchParams.get("dir") ?? "";
  const r = dirUsage(dir);
  if (!r.ok) return fileErrorResponse(r);
  return Response.json(
    { dir: r.dir, self: r.self, children: r.children, partial: r.partial },
    { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}
