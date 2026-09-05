import type { EventsResponse } from "./coord-reader";

type ReadEvents = (signal: AbortSignal) => Promise<EventsResponse>;
type SendEvent = (event: string, data: unknown) => void;

interface PollOptions {
  signal: AbortSignal;
  initialLines: number;
  read: ReadEvents;
  send: SendEvent;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

/** One read at a time; the first successful read always establishes a snapshot. */
export function startEventPolling(options: PollOptions): () => void {
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const unschedule = options.clearTimeout ?? globalThis.clearTimeout;
  const seen = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = options.signal.aborted;
  let hasSnapshot = false;
  let ready = false;
  const stop = () => {
    stopped = true;
    if (timer !== undefined) unschedule(timer);
    options.signal.removeEventListener("abort", stop);
  };
  const poll = async () => {
    if (stopped) return;
    try {
      const { rows } = await options.read(options.signal);
      if (stopped) return;
      if (!hasSnapshot) {
        for (const row of rows) seen.add(row.event_id);
        options.send("snapshot", { events: rows.slice(0, options.initialLines) });
        hasSnapshot = true;
      } else {
        // Reader rows are newest-first; additions arrive in chronological order.
        for (const row of rows.filter((row) => !seen.has(row.event_id)).reverse()) {
          seen.add(row.event_id);
          options.send("event", row);
        }
      }
    } catch {
      if (!stopped) options.send("stale", { reason: "v3_ledger_read_failed" });
    } finally {
      if (!stopped) {
        if (!ready) {
          options.send("ready", { pid: process.pid, ledger: "v3" });
          ready = true;
        }
        if (!stopped) timer = schedule(() => void poll(), 1_000);
      }
    }
  };
  if (!stopped) {
    options.signal.addEventListener("abort", stop, { once: true });
    void poll();
  }
  return stop;
}

export function createEventsStreamResponse(
  request: Request,
  initialLines: number,
  read: ReadEvents,
): Response {
  const encoder = new TextEncoder();
  const lifetime = new AbortController();
  let cleanup = () => lifetime.abort();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let stopPolling: (() => void) | undefined;
      cleanup = () => {
        if (closed) return;
        closed = true;
        lifetime.abort();
        stopPolling?.();
        if (heartbeat !== undefined) clearInterval(heartbeat);
        request.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // Reader cancellation has already closed the stream.
        }
      };
      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", cleanup, { once: true });
      const send: SendEvent = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };
      heartbeat = setInterval(() => send("heartbeat", { ts: new Date().toISOString() }), 25_000);
      stopPolling = startEventPolling({ signal: lifetime.signal, initialLines, read, send });
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
