/**
 * SSE stream of sanitized Codec scenes.
 *
 * Emits named `snapshot`, `scene`, `heartbeat`, and `stale` events. `snapshot`
 * and `scene` both carry a complete, coalesced CodecScene — never animation
 * frames or raw source events — so a new or recovered connection starts from
 * a current snapshot and a missed interval is never replayed.
 *
 * Transport policy mirrors /api/events-stream (watch + debounce + filesize
 * poll safety net); the reducer stays server-side, and scene emissions are
 * coalesced to a bounded cadence and deduplicated by content so an event
 * burst becomes one scene.
 */

import fs from "node:fs";

import { buildScene, eventsFilePath } from "@/lib/codec/scene-source";
import type { CodecScene } from "@/lib/codec/contracts";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const HEARTBEAT_INTERVAL_MS = 25_000;
/** Minimum spacing between scene emissions; bursts coalesce into one. */
const SCENE_COALESCE_MS = 1_000;
/** Heartbeat-driven changes (activity, presence age) have no file watcher on
 * this route, so rebuild on a modest cadence and rely on content dedupe. */
const SCENE_POLL_MS = 5_000;

/** Content signature ignoring volatile generation fields, so an unchanged
 * world does not re-emit. */
function sceneSignature(scene: CodecScene): string {
  const { generated_at: _generatedAt, freshness: _freshness, ...rest } = scene;
  return JSON.stringify(rest);
}

export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  const filePath = eventsFilePath();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let watcher: fs.FSWatcher | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let scenePoll: ReturnType<typeof setInterval> | null = null;
      let pendingTimer: ReturnType<typeof setTimeout> | null = null;
      let closed = false;
      let building = false;
      let dirty = false;
      let lastEmitMs = 0;
      let lastSignature = "";

      function send(event: string, data: unknown): void {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
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
        if (heartbeat) clearInterval(heartbeat);
        if (scenePoll) clearInterval(scenePoll);
        if (pendingTimer) clearTimeout(pendingTimer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      async function emitScene(eventName: "snapshot" | "scene"): Promise<void> {
        if (building) {
          dirty = true;
          return;
        }
        building = true;
        try {
          const scene = await buildScene();
          const signature = sceneSignature(scene);
          if (eventName === "snapshot" || signature !== lastSignature) {
            lastSignature = signature;
            lastEmitMs = Date.now();
            send(eventName, scene);
          }
        } catch {
          send("stale", { reason: "scene_build_failed" });
        } finally {
          building = false;
          if (dirty && !closed) {
            dirty = false;
            scheduleScene();
          }
        }
      }

      function scheduleScene(): void {
        if (closed) return;
        const wait = Math.max(0, SCENE_COALESCE_MS - (Date.now() - lastEmitMs));
        if (pendingTimer) return;
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          void emitScene("scene");
        }, wait);
      }

      // 1. Every connection begins with a complete current snapshot.
      await emitScene("snapshot");

      // 2. Event-log appends schedule a coalesced rebuild.
      try {
        if (fs.existsSync(filePath)) {
          watcher = fs.watch(filePath, () => scheduleScene());
          watcher.on("error", () => {
            send("stale", { reason: "watcher_error" });
            cleanup();
          });
        }
      } catch {
        // non-fatal; the scene poll below keeps things flowing
      }

      // 3. Cadence rebuild catches heartbeat-only changes and silent watcher
      // death; content dedupe keeps an idle world quiet.
      scenePoll = setInterval(() => scheduleScene(), SCENE_POLL_MS);

      heartbeat = setInterval(() => {
        send("heartbeat", { ts: new Date().toISOString() });
      }, HEARTBEAT_INTERVAL_MS);

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
