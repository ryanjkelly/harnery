/**
 * Server-Sent Events endpoint. Watches the coord directories for filesystem
 * changes and pushes a `refresh` event to all subscribers. The client uses
 * that signal to call `router.refresh()` which re-runs server components
 * against fresh disk state.
 *
 * The actual data lives in the page's server-side render path; this stream
 * is just a notification bus. Keeps the SSE payload tiny and avoids
 * duplicating the read logic.
 */

import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
import path from "node:path";
import { activeDir, councilsDir, eventsPath, scratchDir } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;
const DEBOUNCE_MS = 250;
const FILESIZE_POLL_MS = 2_000;

export function GET(): Response {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (eventName: string, data: unknown): void => {
        try {
          controller.enqueue(
            enc.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // controller closed
        }
      };

      send("hello", { ts: new Date().toISOString() });

      const watchers: FSWatcher[] = [];
      let pending: NodeJS.Timeout | null = null;
      let filesizePoll: ReturnType<typeof setInterval> | null = null;

      const fireRefresh = (reason: string): void => {
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          send("refresh", { ts: new Date().toISOString(), reason });
          pending = null;
        }, DEBOUNCE_MS);
      };

      for (const [label, dir] of [
        ["active", activeDir()],
        ["councils", councilsDir()],
        ["scratch", scratchDir()],
      ] as const) {
        if (!existsSync(dir)) continue;
        try {
          watchers.push(
            watch(dir, { recursive: true }, () => {
              fireRefresh(label);
            }),
          );
        } catch {
          // recursive watch unsupported on some platforms; fall back to
          // non-recursive at the top level (better than nothing).
          try {
            watchers.push(
              watch(dir, () => {
                fireRefresh(label);
              }),
            );
          } catch {
            // give up on this dir
          }
        }
      }

      // events.ndjson is a single file; watch its parent dir.
      const eventsP = eventsPath();
      if (existsSync(path.dirname(eventsP))) {
        try {
          watchers.push(
            watch(path.dirname(eventsP), (_evt, fname) => {
              if (fname === path.basename(eventsP)) {
                fireRefresh("events");
              }
            }),
          );
        } catch {
          // give up
        }
      }

      // Safety-net filesize poll for events.ndjson. A directory `fs.watch` does
      // NOT fire on a plain append to an existing file on Linux/WSL (inotify
      // reports create/rename/delete for a dir watch, not the IN_MODIFY of a
      // child append), so the watch above on `dirname(events.ndjson)` catches
      // rotation but misses every append. That means a `subagent.start` (or any
      // event) append goes unnoticed here until the next `.harnery/active/`
      // heartbeat write happens to churn that watched dir, minutes away when
      // agents are idle. Concretely: a freshly-spawned subagent's parent linkage
      // ("of agent-X") is computed in the page render from `readInstanceIdentities`
      // (the event log), so it only resolves on a refresh, and the refresh was
      // never firing on the append. Poll the size and fire a refresh when it
      // changes so event-log-derived UI updates within FILESIZE_POLL_MS
      // regardless of inotify behavior. Mirrors the same belt-and-suspenders
      // poll in /api/live-events; cheap (one stat() every 2s) and fires only on
      // actual growth, so idle streams cost nothing.
      const eventsForPoll = eventsPath();
      let lastEventsSize = -1;
      try {
        lastEventsSize = statSync(eventsForPoll).size;
      } catch {
        // not present yet; the poll will pick it up once it appears
      }
      filesizePoll = setInterval(() => {
        try {
          const size = statSync(eventsForPoll).size;
          if (size !== lastEventsSize) {
            lastEventsSize = size;
            fireRefresh("events-poll");
          }
        } catch {
          // file vanished mid-stream; a recreated file will grow again
        }
      }, FILESIZE_POLL_MS);

      const heartbeat = setInterval(() => {
        send("ping", { ts: new Date().toISOString() });
      }, HEARTBEAT_MS);

      const cleanup = (): void => {
        clearInterval(heartbeat);
        if (filesizePoll) clearInterval(filesizePoll);
        if (pending) clearTimeout(pending);
        for (const w of watchers) {
          try {
            w.close();
          } catch {
            // ignore
          }
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Wire the abort signal. Next propagates client disconnect via
      // controller's onCancel path; we hook into the ReadableStream's
      // cancel() below for the same effect.
      (controller as unknown as { _cleanup?: () => void })._cleanup = cleanup;
    },
    cancel() {
      const cleanup = (this as unknown as { _cleanup?: () => void })._cleanup;
      if (typeof cleanup === "function") cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
