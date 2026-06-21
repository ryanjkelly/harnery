import { readEvents } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "200");
  const instanceId = url.searchParams.get("instance") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;
  return Response.json(readEvents({ limit, instanceId, type }));
}
