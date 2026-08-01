import { readAgent, readEvents, readJournal } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const agent = readAgent(id);
  if (!agent) {
    return Response.json({ error: "not_found", instance_id: id }, { status: 404 });
  }
  const journal = readJournal(id);
  const events = readEvents({ instanceId: id, limit: 100 });
  return Response.json({ agent, journal, events });
}
