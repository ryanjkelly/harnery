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

import { connectSharedCodecScene } from "@/lib/codec/scene-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const HEARTBEAT_INTERVAL_MS = 5_000;
export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let closeSceneConnection: (() => void) | null = null;
      let closed = false;

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
        closeSceneConnection?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      try {
        const connection = await connectSharedCodecScene(
          (scene) => send("scene", scene),
          () => send("stale", { reason: "scene_build_failed" }),
        );
        closeSceneConnection = connection.close;
        if (closed) {
          connection.close();
          return;
        }
        if (request.signal.aborted) {
          cleanup();
          return;
        }
        send("snapshot", connection.snapshot);
      } catch {
        send("stale", { reason: "scene_build_failed" });
        cleanup();
        return;
      }

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
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
