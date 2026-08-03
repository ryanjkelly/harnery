import {
  deleteJournalEntry,
  editJournalEntry,
  safeOwnerId,
  JOURNAL_CATEGORIES,
  type JournalCategory,
} from "@/lib/coord-writer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string; index: string }>;
}

/**
 * Edit one journal entry by its newest-first index. Body:
 *   { category: JournalCategory, body: string, expected_ts_display: string }
 *
 * `expected_ts_display` is a sanity check: if the entry at `index` no longer
 * matches that wall-clock string (because another writer raced in), the
 * server returns 409 and refuses to mutate.
 */
export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { id, index } = await context.params;
  const instanceId = decodeURIComponent(id);
  if (!safeOwnerId(instanceId)) {
    return Response.json({ error: "invalid instance_id" }, { status: 400 });
  }
  const idx = Number.parseInt(index, 10);
  if (!Number.isFinite(idx) || idx < 0) {
    return Response.json({ error: "invalid index" }, { status: 400 });
  }

  let payload: {
    category?: unknown;
    body?: unknown;
    expected_ts_display?: unknown;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  const category = String(payload.category ?? "");
  const body = typeof payload.body === "string" ? payload.body : "";
  const expectedTs =
    typeof payload.expected_ts_display === "string"
      ? payload.expected_ts_display
      : "";

  if (!JOURNAL_CATEGORIES.includes(category as JournalCategory)) {
    return Response.json(
      {
        error: `invalid category: must be one of ${JOURNAL_CATEGORIES.join(", ")}`,
      },
      { status: 400 },
    );
  }
  if (!expectedTs) {
    return Response.json(
      { error: "expected_ts_display is required" },
      { status: 400 },
    );
  }
  if (!body.trim()) {
    return Response.json({ error: "body is empty" }, { status: 400 });
  }
  const byteLen = Buffer.byteLength(body, "utf-8");
  if (byteLen > 32 * 1024) {
    return Response.json(
      { error: `entry too large (${byteLen} bytes; cap 32KB per entry)` },
      { status: 413 },
    );
  }

  const result = editJournalEntry(
    instanceId,
    idx,
    expectedTs,
    category as JournalCategory,
    body,
  );
  if (!result.ok) {
    const conflict =
      result.error?.includes("no longer matches") ||
      result.error?.includes("out of range");
    return Response.json(
      { error: result.error ?? "edit failed" },
      { status: conflict ? 409 : 500 },
    );
  }
  return Response.json(
    {
      ok: true,
      instance_id: instanceId,
      bytes: result.bytes,
      entries: result.entries,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * Delete one journal entry by its newest-first index. Query:
 *   ?expected_ts_display=<wall-clock string>
 *
 * Same race-protection contract as PATCH. The prior file is archived
 * (audit trail) before the rewrite.
 */
export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { id, index } = await context.params;
  const instanceId = decodeURIComponent(id);
  if (!safeOwnerId(instanceId)) {
    return Response.json({ error: "invalid instance_id" }, { status: 400 });
  }
  const idx = Number.parseInt(index, 10);
  if (!Number.isFinite(idx) || idx < 0) {
    return Response.json({ error: "invalid index" }, { status: 400 });
  }

  const url = new URL(request.url);
  const expectedTs = url.searchParams.get("expected_ts_display") ?? "";
  if (!expectedTs) {
    return Response.json(
      { error: "expected_ts_display query param is required" },
      { status: 400 },
    );
  }

  const result = deleteJournalEntry(instanceId, idx, expectedTs);
  if (!result.ok) {
    const conflict =
      result.error?.includes("no longer matches") ||
      result.error?.includes("out of range");
    return Response.json(
      { error: result.error ?? "delete failed" },
      { status: conflict ? 409 : 500 },
    );
  }
  return Response.json(
    {
      ok: true,
      instance_id: instanceId,
      bytes: result.bytes,
      entries: result.entries,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
