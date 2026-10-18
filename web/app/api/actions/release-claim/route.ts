import { coordRoot } from "@/lib/coord-reader";
import { releaseClaim, safeOwnerId } from "@/lib/coord-writer";
import { dashboardActionResponse } from "@/lib/dashboard-command-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const { instance_id, path } = (body ?? {}) as { instance_id?: string; path?: string };
  if (typeof instance_id !== "string" || typeof path !== "string" || !instance_id || !path) {
    return Response.json(
      { error: "missing_fields", required: ["instance_id", "path"] },
      {
        status: 400,
      },
    );
  }
  if (!safeOwnerId(instance_id)) {
    return Response.json({ error: "invalid instance_id" }, { status: 400 });
  }
  return dashboardActionResponse(
    coordRoot(),
    "release-claim",
    body,
    { instance_id, path },
    async () => ({ ...(await releaseClaim(instance_id, path)) }),
  );
}
