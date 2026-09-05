/** V3-only SSE event stream. */
import { readDashboard } from "@/lib/dashboard-reader";
import { createEventsStreamResponse } from "@/lib/events-stream";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export function GET(request: Request): Response {
  const url = new URL(request.url);
  const options = {
    limit: Number.MAX_SAFE_INTEGER,
    instanceId: url.searchParams.get("instance") || undefined,
    type: url.searchParams.get("type") || undefined,
    run: url.searchParams.get("run") || undefined,
  };
  return createEventsStreamResponse(
    request,
    Number(url.searchParams.get("initial") ?? 500),
    (signal) => readDashboard("events", options, { signal }),
  );
}
