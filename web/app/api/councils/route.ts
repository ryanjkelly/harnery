import { readCouncils } from "@/lib/coord-reader";
import { createCouncil } from "@/lib/council-writer";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(readCouncils());
}

export async function POST(req: Request): Promise<Response> {
  let payload: {
    objective?: string;
    members?: string[];
    steward?: string | null;
    target_doc?: string | null;
    auto_advance?: boolean;
  };
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const objective = (payload.objective ?? "").trim();
  const members = Array.isArray(payload.members) ? payload.members : [];
  if (!objective) {
    return Response.json({ error: "missing_objective" }, { status: 400 });
  }
  if (members.length === 0) {
    return Response.json({ error: "no_members" }, { status: 400 });
  }
  const result = await createCouncil({
    objective,
    members,
    steward: payload.steward ?? null,
    target_doc: payload.target_doc ?? null,
    auto_advance: payload.auto_advance === true,
  });
  if (!result.ok) {
    return Response.json(
      {
        error: "create_failed",
        stderr: result.stderr,
        exit_code: result.exit_code,
      },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, council_id: result.council_id });
}
