import { coordRoot } from "@/lib/coord-reader";
import { dashboardActionResponse } from "@/lib/dashboard-command-store";
import { stopServerByRef } from "@/lib/servers";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const { id, pid } = (body ?? {}) as { id?: unknown; pid?: unknown };
  if (typeof id === "string")
    return dashboardActionResponse(coordRoot(), "stop-server", body, { id }, () =>
      stopServerByRef({ id }),
    );
  if (typeof pid === "number")
    return dashboardActionResponse(coordRoot(), "stop-server", body, { pid }, () =>
      stopServerByRef({ pid }),
    );
  return Response.json({ error: "missing_fields", required: ["id or pid"] }, { status: 400 });
}
