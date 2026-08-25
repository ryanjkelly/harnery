/**
 * Read-only current Codec scene. The polling-fallback counterpart of
 * /api/codec-stream: returns one complete sanitized CodecScene, never raw
 * events. See docs plan "Harnery Codec visual director" (host repo).
 */

import { getSharedCodecScene } from "@/lib/codec/scene-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const scene = await getSharedCodecScene();
    return Response.json(scene);
  } catch {
    // Fail closed: an unavailable director must not fabricate panels.
    return Response.json(
      { error: "codec scene unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
