import { endSession } from "@/lib/coord-writer";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const { instance_id } = (body ?? {}) as { instance_id?: string };
  if (!instance_id) {
    return Response.json({ error: "missing_fields", required: ["instance_id"] }, { status: 400 });
  }
  return Response.json(endSession(instance_id));
}
