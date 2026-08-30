import { coordRoot } from "@/lib/coord-reader";
import { readSupervisorLogFeed } from "../../../../../src/core/supervisor/storage";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET(): Response {
  const feed = readSupervisorLogFeed(coordRoot());
  return Response.json(
    { v: feed ? `${feed.sequence}:${feed.captured_at}` : "unavailable" },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
