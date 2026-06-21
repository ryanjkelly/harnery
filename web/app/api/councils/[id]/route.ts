import { readCouncilDetail } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const archived = new URL(req.url).searchParams.get("archived") === "1";
  const detail = readCouncilDetail(id, archived);
  if (!detail) {
    // Fall back to the archive when caller didn't specify.
    if (!archived) {
      const alt = readCouncilDetail(id, true);
      if (alt) return Response.json(alt);
    }
    return Response.json({ error: "not_found", council_id: id }, { status: 404 });
  }
  return Response.json(detail);
}
