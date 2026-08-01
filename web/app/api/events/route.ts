import { coordRoot, readEvents } from "@/lib/coord-reader";
import { readWorkflowChildSessions, resolveRunCoordRoot } from "@/lib/workflow-reader";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "200");
  const instanceId = url.searchParams.get("instance") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;
  // `run` scopes to one workflow run's child sessions. Resolved per request so
  // the SSE polling fallback sees children that started after page load. The
  // run's own coord root comes with it: a run driven from another checkout
  // transcripts here but emits its child events there.
  const run = url.searchParams.get("run") ?? undefined;
  const runRoot = run ? resolveRunCoordRoot(coordRoot(), run) : undefined;
  const sessions = run
    ? new Set(
        readWorkflowChildSessions(coordRoot(), run, {
          heartbeatRoot: runRoot?.root,
        }).map((c) => c.sessionId),
      )
    : undefined;
  return Response.json(
    readEvents({
      limit,
      instanceId,
      type,
      sessions,
      root: runRoot?.foreign ? runRoot.root : undefined,
    }),
  );
}
