import { helperLimitArgs, parseHelperLimitBody, parseHelperLimitReport } from "@/lib/helper-limit";
import { requestLocality } from "@/lib/permissions";
import { runHarn } from "@/lib/run-harn";
import { checkWriteOrigin } from "@/lib/write-origin";

export const dynamic = "force-dynamic";

function reply(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function failure(error: string, status: number): Response {
  return reply({ ok: false, error }, status);
}

/**
 * Change the person's helper agent limit for all their projects by running
 * `harn devtools helpers`. Body `{ limit: { max_model?, max_effort? } }` sets
 * the pair (both absent = explicitly no limit); `{ limit: null }` removes the
 * person's choice so the project default applies. Answers with the fresh
 * report. No approval step: a limit can only lower what helpers run on.
 */
export async function POST(req: Request): Promise<Response> {
  if (!requestLocality(req.headers).local)
    return failure(
      "Not changed: the helper limit can be changed only from a browser on this computer.",
      403,
    );
  const origin = checkWriteOrigin(req.headers);
  if (!origin.ok) return failure(origin.message, 403);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return failure("Not changed: the request was not readable.", 400);
  }
  const parsed = parseHelperLimitBody(body);
  if (!parsed.ok) return failure(`Not changed: ${parsed.message}`, 400);

  const res = await runHarn(helperLimitArgs(parsed.change), { timeoutMs: 20_000 });
  if (!res.ok) {
    const why = res.stderr.trim() || "the helper limit command failed.";
    return failure(`Not changed: ${why}`, res.timedOut ? 504 : 500);
  }
  const report = parseHelperLimitReport(res.stdout);
  // The change was made; when its echo cannot be read the page re-reads instead.
  return reply(report ?? { ok: true }, 200);
}
