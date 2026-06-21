/**
 * SSE stream for the command stream of `.harnery/events.ndjson`: the
 * `command.*` + `narration` envelopes PLUS bare shell commands (Bash
 * `tool.pre_use` / `tool.post_use`), projected back to the flat SessionEvent
 * shape. Non-command tool calls (Read/Edit/…) + state/session events are
 * filtered out; they belong to `/events`.
 *
 * Sister to `/api/stream`: that endpoint fires coarse "something changed in
 * `.harnery/`" notifications so the dashboard can `router.refresh()`. This
 * one delivers the actual structured event objects so the `/live` viewer can
 * render them incrementally without a full page refetch.
 *
 * Lifecycle:
 *   1. Client connects (optionally with `?agent=Maya` filter).
 *   2. Server sends `event: snapshot`: last ~200 events as one payload so the
 *      viewer has an initial buffer.
 *   3. Server fs.watch'es the file. On each append, reads only the new bytes
 *      (tracked via file-position offset) and streams each parsed event as
 *      `event: event`.
 *   4. Heartbeat every 25s keeps proxies from closing the connection.
 *
 * Cleanup on `request.signal.aborted` (browser navigates away, HMR cycle).
 *
 * Ported from the upstream app's app/api/v1/internal/session-tail/events/route.ts.
 */

import fs from "node:fs";

import {
  currentEventsFileSize,
  readEventsAfter,
  readSessionEventsTail,
  sessionEventsPath,
} from "@/lib/session-events";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const HEARTBEAT_INTERVAL_MS = 25_000;
const DEBOUNCE_WINDOW_MS = 75;
/** Safety-net interval: re-checks filesize even if the inotify watcher
 * silently died (common on WSL2 with hot files). 5s = generous tradeoff
 * between responsiveness and load. */
const FILESIZE_POLL_MS = 5_000;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const agentFilter = url.searchParams.get("agent") || undefined;
  // Default snapshot of 1000 command rows (was 200). The stream is far denser
  // now that bare-shell commands project too, so 200 covered only a few minutes
  // and a fresh load couldn't search back far. 1000 stays well under the client
  // MAX_BUFFER (5000) and the 8MB tail window.
  const initialLines = Number(url.searchParams.get("initial") ?? 1000);

  const encoder = new TextEncoder();
  const filePath = sessionEventsPath();

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
          // controller closed under us; cleanup will handle
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

      // 1. Snapshot: initial buffer of the last N events.
      try {
        const snapshot = await readSessionEventsTail({
          lines: initialLines,
          agent: agentFilter,
        });
        send("snapshot", { events: snapshot, agent: agentFilter ?? null });
      } catch {
        send("snapshot", { events: [], agent: agentFilter ?? null });
      }

      // 2. Pin offset at current EOF so we only stream newly-appended events.
      offset = await currentEventsFileSize();

      async function drainNewEvents(): Promise<void> {
        if (processing) {
          dirtySinceLast = true;
          return;
        }
        processing = true;
        try {
          while (!closed) {
            const { events, newOffset } = await readEventsAfter(offset, agentFilter);
            offset = newOffset;
            for (const ev of events) {
              send("event", ev);
            }
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

      // 3. Watch the file for appends.
      //
      // When inotify drops the watcher (common on WSL2 with hot files;
      // .harnery/events.ndjson takes thousands of appends/hour from
      // many agents), tell the client and close the stream. EventSource
      // auto-reconnects, and the new connection mints a fresh fs.watch.
      // The filesize-poll safety net below also catches drops, but signalling
      // the client is faster: the browser reconnect is ~immediate vs waiting
      // for the next poll tick.
      try {
        if (fs.existsSync(filePath)) {
          watcher = fs.watch(filePath, () => {
            scheduleDrain();
          });
          watcher.on("error", () => {
            send("stale", { reason: "watcher_error" });
            cleanup();
          });
        }
      } catch {
        // non-fatal; filesize poll below will keep things flowing
      }

      // 4. Periodic heartbeat to keep proxies happy.
      heartbeat = setInterval(() => {
        send("heartbeat", { ts: new Date().toISOString() });
      }, HEARTBEAT_INTERVAL_MS);

      // 5. Safety-net filesize poll. Belt-and-suspenders for the inotify-drop
      // case: even if `fs.watch` silently stops firing (no error event, just
      // dead), this catches new bytes within FILESIZE_POLL_MS and drains.
      // Cheap (one stat() every 5s) and makes the stream tolerant of any
      // inotify weirdness: the watcher becomes a latency optimization, not
      // a correctness dependency.
      filesizePoll = setInterval(() => {
        void (async () => {
          try {
            const size = await currentEventsFileSize();
            if (size > offset) scheduleDrain();
          } catch {
            // file vanished mid-stream; drainNewEvents will handle on next tick
          }
        })();
      }, FILESIZE_POLL_MS);

      send("ready", { pid: process.pid, agent: agentFilter ?? null });

      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      // ReadableStream.cancel mirrors abort. cleanup is idempotent.
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
