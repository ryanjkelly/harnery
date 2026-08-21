import { listJournalArchives, readJournalArchive } from "@/lib/coord-reader";
import { safeOwnerId } from "@/lib/coord-writer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * List or read archived journal snapshots for one owner.
 *
 *   GET /api/agents/<id>/journal/archives
 *     → { archives: [{ filename, bytes, archived_at, is_pre_ui_edit }, ...] }
 *
 *   GET /api/agents/<id>/journal/archives?filename=<name>
 *     → { filename, body }
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const instanceId = decodeURIComponent(id);
  if (!safeOwnerId(instanceId)) {
    return Response.json({ error: "invalid instance_id" }, { status: 400 });
  }

  const url = new URL(request.url);
  const filename = url.searchParams.get("filename");
  if (filename) {
    const body = readJournalArchive(instanceId, filename);
    if (body === null) {
      return Response.json({ error: "archive not found" }, { status: 404 });
    }
    return Response.json({ filename, body }, { headers: { "cache-control": "no-store" } });
  }

  const archives = listJournalArchives(instanceId);
  return Response.json({ archives }, { headers: { "cache-control": "no-store" } });
}
