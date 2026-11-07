import { readCouncils } from "@/lib/coord-reader";
import { createCouncil } from "@/lib/council-writer";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(readCouncils());
}

const optionalString = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || typeof value === "string";

export async function POST(req: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return Response.json({ error: "invalid_payload" }, { status: 400 });
  }
  const body = payload as Record<string, unknown>;
  if (body.objective !== undefined && typeof body.objective !== "string") {
    return Response.json({ error: "invalid_objective" }, { status: 400 });
  }
  const objective = (body.objective ?? "").trim();
  if (!objective) {
    return Response.json({ error: "missing_objective" }, { status: 400 });
  }
  if (body.members !== undefined && !Array.isArray(body.members)) {
    return Response.json({ error: "invalid_members" }, { status: 400 });
  }
  const rawMembers = (body.members ?? []) as unknown[];
  // The CLI takes members as one comma-separated list.
  if (!rawMembers.every((m) => typeof m === "string" && m.trim() && !m.includes(","))) {
    return Response.json({ error: "invalid_members" }, { status: 400 });
  }
  const members = (rawMembers as string[]).map((m) => m.trim());
  if (members.length === 0) {
    return Response.json({ error: "no_members" }, { status: 400 });
  }
  if (!optionalString(body.steward) || !optionalString(body.target_doc)) {
    return Response.json({ error: "invalid_payload" }, { status: 400 });
  }
  if (body.auto_advance !== undefined && typeof body.auto_advance !== "boolean") {
    return Response.json({ error: "invalid_payload" }, { status: 400 });
  }
  const result = await createCouncil({
    objective,
    members,
    steward: body.steward || null,
    target_doc: body.target_doc || null,
    auto_advance: body.auto_advance === true,
  });
  if (!result.ok) {
    return Response.json(
      {
        error: "create_failed",
        stderr: result.stderr,
        exit_code: result.exitCode,
      },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, council_id: result.council_id });
}
