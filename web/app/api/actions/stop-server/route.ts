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
  if (typeof id === "string") return Response.json(await stopServerByRef({ id }));
  if (typeof pid === "number") return Response.json(await stopServerByRef({ pid }));
  return Response.json({ error: "missing_fields", required: ["id or pid"] }, { status: 400 });
}
