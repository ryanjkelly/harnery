import { storeCodecComprehensionResult } from "@/lib/codec/comprehension";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  try {
    const receipt = storeCodecComprehensionResult(body);
    return Response.json({ ok: true, receipt });
  } catch (caught) {
    return Response.json(
      { error: caught instanceof Error ? caught.message : "result could not be stored" },
      { status: 400 },
    );
  }
}
