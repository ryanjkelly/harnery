/**
 * Read-only character-pack portrait asset. Slug-validated segments resolve
 * through the pack manifest (never raw paths), so only files a valid pack
 * declares can be served. Unknown expressions fall back to the pack's
 * neutral portrait; anything else is 404.
 */

import {
  loadCachedPackAsset,
  packAssetHeaders,
  packAssetNotModified,
} from "@/lib/codec/pack-asset-cache";
import { resolvePackAsset } from "@/lib/codec/packs";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ pack: string; expression: string }> },
): Promise<Response> {
  const { pack, expression } = await params;
  const asset = resolvePackAsset(pack, expression);
  if (!asset) return new Response("not found", { status: 404 });
  try {
    const cached = await loadCachedPackAsset(asset);
    const headers = packAssetHeaders(cached);
    if (packAssetNotModified(request, cached)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(new Uint8Array(cached.body), { headers });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
