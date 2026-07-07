import { isVerdict, reviewDecision, safeDecisionId } from "@/lib/decision-writer";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!safeDecisionId(id)) {
    return Response.json({ error: "invalid_decision_id" }, { status: 400 });
  }
  let body: { verdict?: string; note?: string };
  try {
    body = (await req.json()) as { verdict?: string; note?: string };
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  if (!body.verdict || !isVerdict(body.verdict)) {
    return Response.json({ error: "invalid_verdict" }, { status: 400 });
  }
  const result = await reviewDecision(id, body.verdict, body.note);
  if (!result.ok) {
    return Response.json(
      { error: "review_failed", stderr: result.stderr, exit_code: result.exit_code },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, stdout: result.stdout });
}
