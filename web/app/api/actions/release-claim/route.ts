import { releaseClaim } from "@/lib/coord-writer";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const { instance_id, path } = (body ?? {}) as { instance_id?: string; path?: string };
  if (!instance_id || !path) {
    return Response.json({ error: "missing_fields", required: ["instance_id", "path"] }, {
      status: 400,
    });
  }
  return Response.json(releaseClaim(instance_id, path));
}
