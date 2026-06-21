/**
 * Non-streaming snapshot of the session/command event tail: the polling-mode
 * counterpart to the `/api/live-events` SSE stream.
 *
 * LiveLogTable streams from `/api/live-events`; when that stream can't be used
 * (Cloudflare's `harn tunnel` buffers SSE; see useLiveSignal), the table polls
 * `/api/coord-version` and refetches its snapshot here on change. Returns
 * `{ rows }` to match `/api/events`, so the table's fallback path reads `.rows`
 * regardless of source.
 */

import { readSessionEventsTail } from "@/lib/session-events";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const lines = Number(url.searchParams.get("lines") ?? "1000");
  const agent = url.searchParams.get("agent") ?? undefined;
  const rows = await readSessionEventsTail({ lines, agent });
  return Response.json({ rows }, { headers: { "Cache-Control": "no-store" } });
}
