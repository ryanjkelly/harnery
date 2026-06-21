/**
 * SSE stream for `.harnery/events.ndjson`, the canonical hook-event log.
 *
 * Sister to `/api/live-events` (which streams `.harnery/session-events.ndjson`).
 * Same envelope shape (`ready` / `snapshot` / `event` / `heartbeat`) so the
 * shared <LogTable> consumes both identically.
 *
 * Why a second endpoint instead of one /api/stream that watches both files:
 * the two ndjson schemas are different (hook EventRow vs session-tee
 * SessionEvent), so consumers need to know which file they're tailing
 * before parsing each row. Two endpoints keep the client side simple: one
 * EventSource per page, one renderer.
 */

import fs from "node:fs";
import path from "node:path";

import { eventsPath, type EventRow } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const HEARTBEAT_INTERVAL_MS = 25_000;
const DEBOUNCE_WINDOW_MS = 75;
/** Safety-net interval: re-checks filesize even if the inotify watcher
 * silently died (common on WSL2 with hot files). Mirrors /api/live-events. */
const FILESIZE_POLL_MS = 5_000;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const instanceFilter = url.searchParams.get("instance") || undefined;
  const typeFilter = url.searchParams.get("type") || undefined;
  const initialLines = Number(url.searchParams.get("initial") ?? 500);

  const encoder = new TextEncoder();
  const filePath = eventsPath();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let watcher: fs.FSWatcher | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let filesizePoll: ReturnType<typeof setInterval> | null = null;
      let closed = false;
      let offset = 0;
      let lastEmit = 0;
      let pendingTimer: ReturnType<typeof setTimeout> | null = null;
      let processing = false;
      let dirtySinceLast = false;

      function send(event: string, data: unknown): void {
        if (closed) return;
        try {
          const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // controller closed; cleanup handles
        }
      }

      function cleanup(): void {
        if (closed) return;
        closed = true;
        try {
          watcher?.close();
        } catch {
          /* ignore */
        }
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (filesizePoll) {
          clearInterval(filesizePoll);
          filesizePoll = null;
        }
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      // 1. Snapshot: last N rows, applying server-side filters if present.
      try {
        const snapshot = await readEventsTail({
          lines: initialLines,
          instanceId: instanceFilter,
          type: typeFilter,
        });
        send("snapshot", { events: snapshot });
      } catch {
        send("snapshot", { events: [] });
      }

      // 2. Pin offset at current EOF so we only stream newly-appended rows.
      offset = await currentFileSize(filePath);

      async function drainNewEvents(): Promise<void> {
        if (processing) {
          dirtySinceLast = true;
          return;
        }
        processing = true;
        try {
          while (!closed) {
            const { events, newOffset } = await readEventsAfter(
              filePath,
              offset,
              { instanceId: instanceFilter, type: typeFilter },
            );
            offset = newOffset;
            for (const ev of events) send("event", ev);
            if (!dirtySinceLast) break;
            dirtySinceLast = false;
          }
        } finally {
          processing = false;
        }
      }

      function scheduleDrain(): void {
        const now = Date.now();
        if (now - lastEmit < DEBOUNCE_WINDOW_MS) {
          if (!pendingTimer) {
            pendingTimer = setTimeout(() => {
              pendingTimer = null;
              lastEmit = Date.now();
              void drainNewEvents();
            }, DEBOUNCE_WINDOW_MS);
          }
          return;
        }
        lastEmit = now;
        void drainNewEvents();
      }

      // 3. Watch the file for appends. Watch parent dir since rotation could
      // replace the file inode.
      //
      // Same layered defense as /api/live-events: signal `stale` + close on
      // explicit watcher error so EventSource reconnects, and a filesize-poll
      // safety net (below) catches the silent inotify-drop case.
      try {
        if (fs.existsSync(filePath)) {
          watcher = fs.watch(filePath, () => scheduleDrain());
          watcher.on("error", () => {
            send("stale", { reason: "watcher_error" });
            cleanup();
          });
        }
      } catch {
        // non-fatal; filesize poll below keeps things flowing
      }

      heartbeat = setInterval(() => {
        send("heartbeat", { ts: new Date().toISOString() });
      }, HEARTBEAT_INTERVAL_MS);

      // Safety-net filesize poll; same rationale as /api/live-events.
      filesizePoll = setInterval(() => {
        void (async () => {
          try {
            const size = await currentFileSize(filePath);
            if (size > offset) scheduleDrain();
          } catch {
            // file vanished mid-stream; next tick handles
          }
        })();
      }, FILESIZE_POLL_MS);

      send("ready", { pid: process.pid });

      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      // mirrors abort; cleanup is idempotent
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/* ────────────────────────────────────────────────────────────────────── */

interface TailOpts {
  lines: number;
  instanceId?: string;
  type?: string;
}

async function readEventsTail(opts: TailOpts): Promise<EventRow[]> {
  const filePath = eventsPath();
  try {
    const stat = await fs.promises.stat(filePath);
    let text: string;
    if (stat.size > 2_000_000) {
      const APPROX_BYTES_PER_LINE = 1024;
      const startOffset = Math.max(
        0,
        stat.size - opts.lines * APPROX_BYTES_PER_LINE * 2,
      );
      const fh = await fs.promises.open(filePath, "r");
      try {
        const length = stat.size - startOffset;
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, startOffset);
        text = buf.toString("utf8");
      } finally {
        await fh.close();
      }
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    } else {
      text = await fs.promises.readFile(filePath, "utf8");
    }

    const out: EventRow[] = [];
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      try {
        const ev = JSON.parse(raw) as EventRow;
        if (opts.instanceId && ev.instance_id !== opts.instanceId) continue;
        if (opts.type && ev.event_type !== opts.type) continue;
        out.push(ev);
      } catch {
        // skip malformed
      }
    }
    if (out.length > opts.lines) return out.slice(-opts.lines);
    return out;
  } catch {
    return [];
  }
}

async function readEventsAfter(
  filePath: string,
  offset: number,
  opts: { instanceId?: string; type?: string },
): Promise<{ events: EventRow[]; newOffset: number }> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size <= offset) return { events: [], newOffset: offset };
    const fh = await fs.promises.open(filePath, "r");
    try {
      const length = stat.size - offset;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, offset);
      const text = buf.toString("utf8");
      const lastNl = text.lastIndexOf("\n");
      const consumed = lastNl >= 0 ? lastNl + 1 : 0;
      const payload = text.slice(0, consumed);
      const events: EventRow[] = [];
      for (const raw of payload.split("\n")) {
        if (!raw) continue;
        try {
          const ev = JSON.parse(raw) as EventRow;
          if (opts.instanceId && ev.instance_id !== opts.instanceId) continue;
          if (opts.type && ev.event_type !== opts.type) continue;
          events.push(ev);
        } catch {
          // skip
        }
      }
      return { events, newOffset: offset + consumed };
    } finally {
      await fh.close();
    }
  } catch {
    return { events: [], newOffset: offset };
  }
}

async function currentFileSize(filePath: string): Promise<number> {
  void path;
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}
