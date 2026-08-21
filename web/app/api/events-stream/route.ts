/** V3-only SSE event stream. */
import { coordRoot, readEvents } from "@/lib/coord-reader";
import { readWorkflowChildSessions, resolveRunCoordRoot } from "@/lib/workflow-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const HEARTBEAT_INTERVAL_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const instanceFilter = url.searchParams.get("instance") || undefined;
  const typeFilter = url.searchParams.get("type") || undefined;
  const runFilter = url.searchParams.get("run") || undefined;
  const initialLines = Number(url.searchParams.get("initial") ?? 500);
  const localRoot = coordRoot();
  const runRoot = runFilter ? resolveRunCoordRoot(localRoot, runFilter) : undefined;
  const sourceRoot = runRoot?.foreign ? runRoot.root : localRoot;

  function resolveRunSessions(): Set<string> | undefined {
    if (!runFilter) return undefined;
    try {
      return new Set(
        readWorkflowChildSessions(localRoot, runFilter, {
          coordinationRoot: runRoot?.root,
        }).map((child) => child.sessionId),
      );
    } catch {
      return new Set();
    }
  }

  return streamV3Events(request, {
    sourceRoot,
    initialLines,
    instanceFilter,
    typeFilter,
    resolveRunSessions,
  });
}

function streamV3Events(
  request: Request,
  options: {
    sourceRoot: string;
    initialLines: number;
    instanceFilter?: string;
    typeFilter?: string;
    resolveRunSessions: () => Set<string> | undefined;
  },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let poll: ReturnType<typeof setInterval> | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const seen = new Set<string>();
      const send = (event: string, data: unknown) => {
        if (!closed) {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        }
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (poll) clearInterval(poll);
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const read = () =>
        readEvents({
          limit: Number.MAX_SAFE_INTEGER,
          instanceId: options.instanceFilter,
          type: options.typeFilter,
          sessions: options.resolveRunSessions(),
          root: options.sourceRoot,
        }).rows;

      try {
        const rows = read();
        for (const row of rows) seen.add(row.event_id);
        send("snapshot", { events: rows.slice(0, options.initialLines) });
      } catch {
        send("snapshot", { events: [] });
      }
      poll = setInterval(() => {
        try {
          const rows = read();
          const fresh = rows.filter((row) => !seen.has(row.event_id)).reverse();
          for (const row of fresh) {
            seen.add(row.event_id);
            send("event", row);
          }
        } catch {
          send("stale", { reason: "v2_ledger_read_failed" });
        }
      }, 1_000);
      heartbeat = setInterval(
        () => send("heartbeat", { ts: new Date().toISOString() }),
        HEARTBEAT_INTERVAL_MS,
      );
      send("ready", { pid: process.pid, ledger: "v3" });
      request.signal.addEventListener("abort", cleanup);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
