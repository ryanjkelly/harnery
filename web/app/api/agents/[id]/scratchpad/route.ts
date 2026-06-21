import {
  appendScratchEntry,
  editScratchpad,
  SCRATCH_CATEGORIES,
  safeOwnerId,
  type ScratchCategory,
} from "@/lib/coord-writer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Append a single well-formed entry. Preferred over PUT (wholesale replace);
 * the resulting `## YYYY-MM-DD H:MM AM/PM CDT · category` block parses cleanly
 * into the entries timeline without the synthetic-note nesting that bloats
 * the file on every UI Replace.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const instanceId = decodeURIComponent(id);
  if (!safeOwnerId(instanceId)) {
    return Response.json({ error: "invalid instance_id" }, { status: 400 });
  }

  let payload: { category?: unknown; body?: unknown };
  try {
    payload = (await request.json()) as { category?: unknown; body?: unknown };
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  const category = String(payload.category ?? "");
  const body = typeof payload.body === "string" ? payload.body : "";

  if (!SCRATCH_CATEGORIES.includes(category as ScratchCategory)) {
    return Response.json(
      {
        error: `invalid category: must be one of ${SCRATCH_CATEGORIES.join(", ")}`,
      },
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

  const result = appendScratchEntry(
    instanceId,
    category as ScratchCategory,
    body,
  );
  if (!result.ok) {
    return Response.json(
      { error: result.error ?? "append failed" },
      { status: 500 },
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

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const instanceId = decodeURIComponent(id);
  if (!safeOwnerId(instanceId)) {
    return Response.json({ error: "invalid instance_id" }, { status: 400 });
  }

  let body: { body?: unknown; summary?: unknown };
  try {
    body = (await request.json()) as { body?: unknown; summary?: unknown };
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }

  const newBody = typeof body.body === "string" ? body.body : "";
  const summary =
    typeof body.summary === "string" ? body.summary : "edited via web UI";

  if (newBody.length === 0) {
    return Response.json(
      { error: "body is empty; refusing to overwrite scratchpad with blank" },
      { status: 400 },
    );
  }
  const byteLen = Buffer.byteLength(newBody, "utf-8");
  if (byteLen > 128 * 1024) {
    return Response.json(
      { error: `body too large (${byteLen} bytes; cap 128KB)` },
      { status: 413 },
    );
  }

  const result = await editScratchpad(instanceId, newBody, summary);
  if (!result.ok) {
    return Response.json(
      {
        error: "agent-coord edit-scratchpad failed",
        exit_code: result.exit_code,
        stderr: result.stderr.trim(),
      },
      { status: 500 },
    );
  }

  // The helper prints `{ instance_id, path, archive_path }` on success.
  let parsed: { instance_id?: string; path?: string; archive_path?: string } = {};
  try {
    parsed = JSON.parse(result.stdout.trim()) as typeof parsed;
  } catch {
    /* helper succeeded but stdout malformed; still treat as ok */
  }

  return Response.json(
    {
      ok: true,
      instance_id: instanceId,
      path: parsed.path,
      archive_path: parsed.archive_path,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
