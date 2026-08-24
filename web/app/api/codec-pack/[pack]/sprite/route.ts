import { packAssetHeaders, packAssetNotModified } from "@/lib/codec/pack-asset-cache";
import { loadCachedPackSprite } from "@/lib/codec/pack-sprite-cache";
import { resolvePackSprite } from "@/lib/codec/packs";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ pack: string }> },
): Promise<Response> {
  const { pack } = await params;
  const descriptor = resolvePackSprite(pack);
  if (!descriptor) return new Response("not found", { status: 404 });

  try {
    const sprite = await loadCachedPackSprite(descriptor);
    const headers = packAssetHeaders(sprite);
    if (packAssetNotModified(request, sprite)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(new Uint8Array(sprite.body), { headers });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
