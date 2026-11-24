import { loadIconMap } from "@/lib/file-icons/pack";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The compact name → icon map the browser resolves file and folder icons with. */
export async function GET(): Promise<Response> {
  const map = await loadIconMap();
  if (!map) {
    return Response.json(
      { error: "The file icon pack is not installed." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  // Short browser cache: a dependency bump changes the map without changing this URL.
  return Response.json(map, { headers: { "cache-control": "private, max-age=3600" } });
}
