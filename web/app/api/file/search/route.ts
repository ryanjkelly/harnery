/**
 * Fuzzy file-name search across the repo (lib/file-tree.ts `searchFiles`),
 * backed by a cached, deny-aware index that skips build-artifact dirs. Powers
 * the /browse ⌘K palette.
 *
 *   GET /api/file/search?q=<query>&limit=<n>
 */

import { fileErrorResponse } from "@/lib/file-routes";
import { searchFiles } from "@/lib/file-tree";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Math.max(1, Math.min(200, Number(limitRaw) || 0)) : undefined;
  const r = await searchFiles(q, { limit, dir: url.searchParams.get("dir") ?? "" });
  if (!r.ok) return fileErrorResponse(r);
  return Response.json(
    {
      query: r.query,
      matches: r.matches,
      total: r.total,
      truncated: r.truncated,
      indexing: r.indexing,
    },
    { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}
