import { archiveCouncil, safeCouncilId } from "@/lib/council-writer";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!safeCouncilId(id)) {
    return Response.json({ error: "invalid_council_id" }, { status: 400 });
  }
  const result = await archiveCouncil(id);
  if (!result.ok) {
    return Response.json(
      { error: "archive_failed", stderr: result.stderr, exit_code: result.exit_code },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, stdout: result.stdout });
}
