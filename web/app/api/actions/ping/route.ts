import { coordRoot } from "@/lib/coord-reader";
import { pingAgent, safeOwnerId } from "@/lib/coord-writer";
import { dashboardActionResponse } from "@/lib/dashboard-command-store";

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
  if (typeof instance_id !== "string" || typeof message !== "string" || !message.trim()) {
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
  return dashboardActionResponse(coordRoot(), "ping", body, { instance_id, message }, () => ({
    ...pingAgent(instance_id, message),
  }));
}
