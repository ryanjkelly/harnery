import { readIconSvg } from "@/lib/file-icons/pack";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One icon from the bundled pack. URLs carry the pack version, so caching is permanent. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const svg = await readIconSvg(id);
  if (svg === null) {
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      // The pack's SVGs are static artwork; never let one run script if opened directly.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}
