import { readDashboard } from "@/lib/dashboard-reader";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "200");
  const instanceId = url.searchParams.get("instance") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;
  // `run` scopes to one workflow run's child sessions. Resolved per request so
  // the SSE polling fallback sees children that started after page load. The
  // run's own coord root comes with it: a run driven from another checkout
  // transcripts here but emits its child events there.
  const run = url.searchParams.get("run") ?? undefined;
  try {
    return Response.json(
      await readDashboard("events", { limit, instanceId, type, run }, { signal: req.signal }),
    );
  } catch {
    return Response.json({ error: "Event reader unavailable" }, { status: 503 });
  }
}
