/** Privacy-safe V3 command stream for the live viewer. */
import { readSessionEventsTail } from "@/lib/session-events";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const HEARTBEAT_INTERVAL_MS = 25_000;
const POLL_INTERVAL_MS = 1_000;
const DEFAULT_INITIAL = 1_000;
const MAX_INITIAL = 5_000;

/** `?initial=` as a whole number of events in [0, MAX_INITIAL]. */
function initialCount(raw: string | null): number {
  const n = raw === null || raw.trim() === "" ? DEFAULT_INITIAL : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_INITIAL;
  return Math.min(MAX_INITIAL, Math.max(0, Math.floor(n)));
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent") || undefined;
  const initial = initialCount(url.searchParams.get("initial"));
  const encoder = new TextEncoder();
  let cleanup = (): void => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let polling = false;
      let poll: ReturnType<typeof setInterval> | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const seen = new Set<string>();
      const key = (event: Awaited<ReturnType<typeof readSessionEventsTail>>[number]) =>
        [event.ts, event.instance_id, event.type, event.cmd_id, event.message].join("\0");
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller closed; cleanup handles
        }
      };
      cleanup = () => {
        if (closed) return;
        closed = true;
        request.signal.removeEventListener("abort", cleanup);
        if (poll) clearInterval(poll);
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      request.signal.addEventListener("abort", cleanup, { once: true });
      if (request.signal.aborted) {
        cleanup();
        return;
      }

      try {
        const snapshot = await readSessionEventsTail({ lines: initial, agent });
        for (const event of snapshot) seen.add(key(event));
        send("snapshot", { events: snapshot, agent: agent ?? null });
      } catch {
        send("snapshot", { events: [], agent: agent ?? null });
      }
      if (closed) return;

      poll = setInterval(() => {
        // A slow ledger read must not stack a second read behind it.
        if (polling || closed) return;
        polling = true;
        void (async () => {
          try {
            const events = await readSessionEventsTail({ lines: 5000, agent });
            for (const event of events) {
              const eventKey = key(event);
              if (seen.has(eventKey)) continue;
              seen.add(eventKey);
              send("event", event);
            }
          } catch {
            send("stale", { reason: "v2_command_projection_failed" });
          } finally {
            polling = false;
          }
        })();
      }, POLL_INTERVAL_MS);
      heartbeat = setInterval(
        () => send("heartbeat", { ts: new Date().toISOString() }),
        HEARTBEAT_INTERVAL_MS,
      );
      send("ready", { pid: process.pid, agent: agent ?? null, ledger: "v3" });
    },
    cancel() {
      cleanup();
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
