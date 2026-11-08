import {
  changeComputerMode,
  checkLocalWrite,
  type ModeChangeOutcome,
  oneChangeAtATime,
  parseModeChangeRequest,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";

function reply(body: ModeChangeOutcome, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Change the person's own computer-use mode for this project by running
 * `harn computer mode`. Loosening it shows them the CLI's confirmation pop-up,
 * so this can wait up to about two minutes before it answers. It shares the
 * one-change-at-a-time guard with the sign-in route.
 */
export async function POST(req: Request): Promise<Response> {
  const local = checkLocalWrite(req.headers);
  if (!local.ok) return reply({ outcome: "refused", message: local.message }, 403);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return reply({ outcome: "failed", message: "Not changed: the request was not readable." }, 400);
  }
  const parsed = parseModeChangeRequest(body);
  if (!parsed.ok)
    return reply({ outcome: "failed", message: `Not changed: ${parsed.message}` }, 400);

  const outcome = await oneChangeAtATime(() => changeComputerMode(parsed.choice));
  return reply(outcome, outcome.outcome === "busy" ? 409 : 200);
}
