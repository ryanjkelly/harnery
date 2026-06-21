import { advanceCouncil, safeCouncilId } from "@/lib/council-writer";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!safeCouncilId(id)) {
    return Response.json({ error: "invalid_council_id" }, { status: 400 });
  }
  let force = false;
  try {
    const body = (await req.json()) as { force?: boolean };
    force = body.force === true;
  } catch {
    /* no body, fine */
  }
  const result = await advanceCouncil(id, force);
  if (!result.ok) {
    return Response.json(
      { error: "advance_failed", stderr: result.stderr, exit_code: result.exit_code },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, stdout: result.stdout });
}
