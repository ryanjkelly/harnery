import { readAgent } from "@/lib/coord-reader";
import { healAgent, safeOwnerId } from "@/lib/coord-writer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const instanceId = decodeURIComponent(id);
  if (!safeOwnerId(instanceId)) {
    return Response.json({ error: "invalid instance_id" }, { status: 400 });
  }

  let body: { kind?: unknown };
  try {
    body = (await request.json()) as { kind?: unknown };
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  const kind = String(body.kind ?? "");
  if (kind !== "cache") {
    return Response.json({ error: "kind must be: cache" }, { status: 400 });
  }

  const result = await healAgent(instanceId, kind);
  if (!result.ok) {
    return Response.json(
      {
        error: "agent-coord failed",
        exit_code: result.exit_code,
        stderr: result.stderr.trim(),
      },
      { status: 500 },
    );
  }

  // Post-repair V3 projection so the client can verify the derived cache landed.
  const after = readAgent(instanceId);
  return Response.json(
    { ok: true, action: `heal-${kind}`, instance_id: instanceId, after },
    { headers: { "cache-control": "no-store" } },
  );
}
