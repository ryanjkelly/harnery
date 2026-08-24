import type { SemanticReviewSubmissionV1 } from "harnery/core/semantic";
import { prepareCodecSemanticReview, submitCodecSemanticReview } from "@/lib/codec/semantic-review";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const study = await prepareCodecSemanticReview();
    return Response.json({ ok: true, study }, { headers: { "cache-control": "no-store" } });
  } catch (caught) {
    return Response.json(
      { error: caught instanceof Error ? caught.message : "semantic review could not be prepared" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  try {
    const receipt = await submitCodecSemanticReview(body as SemanticReviewSubmissionV1);
    return Response.json({ ok: true, receipt }, { headers: { "cache-control": "no-store" } });
  } catch (caught) {
    return Response.json(
      { error: caught instanceof Error ? caught.message : "semantic review could not be stored" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
}
