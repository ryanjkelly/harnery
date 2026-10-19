import { pingAgent, safeOwnerId } from "@/lib/coord-writer";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const { instance_id, message } = (body ?? {}) as {
    instance_id?: string;
    message?: string;
  };
  if (!instance_id || !message) {
    return Response.json(
      { error: "missing_fields", required: ["instance_id", "message"] },
      {
        status: 400,
      },
    );
  }
  if (!safeOwnerId(instance_id)) {
    return Response.json({ error: "invalid instance_id" }, { status: 400 });
  }
  return Response.json(pingAgent(instance_id, message));
}
