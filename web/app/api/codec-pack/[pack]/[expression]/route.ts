/**
 * Read-only character-pack portrait asset. Slug-validated segments resolve
 * through the pack manifest (never raw paths), so only files a valid pack
 * declares can be served. Unknown expressions fall back to the pack's
 * neutral portrait; anything else is 404.
 */

import fs from "node:fs";

import { resolvePackAsset } from "@/lib/codec/packs";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ pack: string; expression: string }> },
): Promise<Response> {
  const { pack, expression } = await params;
  const asset = resolvePackAsset(pack, expression);
  if (!asset) return new Response("not found", { status: 404 });
  try {
    const body = await fs.promises.readFile(asset.filePath);
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": asset.contentType,
        // Pack contents are immutable per version; the client varies the URL
        // by pack_version, so long caching is safe.
        "cache-control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
