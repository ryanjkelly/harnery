import { NextResponse } from "next/server";
import { coordRoot } from "@/lib/coord-reader";
import { refreshStorageFootprint } from "@/lib/storage-reader";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Start or join the storage walk and answer when it finishes. `force` walks
 * again even when the measurement is fresh. The walk is metadata-only and
 * changes nothing on disk except the dashboard's own display snapshot.
 * The dashboard middleware applies the shared write-origin guard to this POST.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let force = false;
  try {
    const body = (await req.json()) as { force?: unknown };
    force = body.force === true;
  } catch {
    // An empty or malformed body means "join any walk, do not force one".
  }
  try {
    const outcome = await refreshStorageFootprint(coordRoot(), { force });
    return NextResponse.json({ ok: true, ...outcome });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: "storage_refresh_failed",
        message: error instanceof Error ? error.message.slice(0, 500) : String(error),
      },
      { status: 500 },
    );
  }
}
