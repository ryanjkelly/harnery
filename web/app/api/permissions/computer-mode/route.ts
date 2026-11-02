import {
  changeComputerMode,
  checkLocalWrite,
  type ModeChangeOutcome,
  parseModeChangeRequest,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";

/** One change at a time: a second click must not open a second pop-up. */
let changing = false;

function reply(body: ModeChangeOutcome, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Change the person's own computer-use mode for this project by running
 * `harn computer mode`. Loosening it shows them the CLI's confirmation pop-up,
 * so this can wait up to about two minutes before it answers.
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

  if (changing) {
    return reply(
      {
        outcome: "busy",
        message: "Not changed: another change is still waiting for your answer in the pop-up.",
      },
      409,
    );
  }
  changing = true;
  try {
    return reply(await changeComputerMode(parsed.choice), 200);
  } finally {
    changing = false;
  }
}
