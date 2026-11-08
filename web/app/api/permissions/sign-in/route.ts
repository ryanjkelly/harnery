import {
  changeSignIn,
  checkLocalWrite,
  type ModeChangeOutcome,
  oneChangeAtATime,
  parseSignInChangeRequest,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";

function reply(body: ModeChangeOutcome, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Change whether agents may sign in to websites for the person in this
 * project, by running `harn computer sign-in`. Turning it on shows them the
 * CLI's confirmation pop-up, so this can wait up to about two minutes. It
 * shares the one-change-at-a-time guard with the computer-mode route.
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
  const parsed = parseSignInChangeRequest(body);
  if (!parsed.ok)
    return reply({ outcome: "failed", message: `Not changed: ${parsed.message}` }, 400);

  const outcome = await oneChangeAtATime(() => changeSignIn(parsed.choice));
  return reply(outcome, outcome.outcome === "busy" ? 409 : 200);
}
