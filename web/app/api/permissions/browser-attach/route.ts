import {
  changeBrowserAttach,
  checkLocalWrite,
  type ModeChangeOutcome,
  oneChangeAtATime,
  parseBrowserAttachChangeRequest,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";

function reply(body: ModeChangeOutcome, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Change whether agents may attach to the person's running browser in this
 * project, by running `harn computer browser-attach`. Turning it on shows them
 * the CLI's confirmation pop-up, so this can wait up to about two minutes; the
 * CLI then restarts the driver's daemon with or without the grant. It shares
 * the one-change-at-a-time guard with the other Permissions routes.
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
  const parsed = parseBrowserAttachChangeRequest(body);
  if (!parsed.ok)
    return reply({ outcome: "failed", message: `Not changed: ${parsed.message}` }, 400);

  const outcome = await oneChangeAtATime(() => changeBrowserAttach(parsed.choice));
  return reply(outcome, outcome.outcome === "busy" ? 409 : 200);
}
