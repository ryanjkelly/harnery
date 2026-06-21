import { lookupAgentIdByName, safeCouncilId, setSteward } from "@/lib/council-writer";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!safeCouncilId(id)) {
    return Response.json({ error: "invalid_council_id" }, { status: 400 });
  }
  let steward: string | null = null;
  try {
    const body = (await req.json()) as { steward?: string | null };
    steward = typeof body.steward === "string" ? body.steward : null;
  } catch {
    /* clear */
  }
  const stewardId = steward ? lookupAgentIdByName(steward) : null;
  const result = await setSteward(id, steward, stewardId);
  if (!result.ok) {
    return Response.json(
      {
        error: "set_steward_failed",
        stderr: result.stderr,
        exit_code: result.exit_code,
      },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, stdout: result.stdout });
}
