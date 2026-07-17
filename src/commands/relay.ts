import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { MAX_FRAME_BYTES } from "../core/presence/relay-protocol.ts";

/**
 * `relay serve`: the Bun self-host of the presence relay (ADR 0016 phase 2).
 * Same wire protocol as the Cloudflare Durable Objects host in relay/worker/ —
 * one in-memory room per opaque room id, warm-join cache, fan-out, rate
 * limits. For teams who'd rather run their own box than use the public
 * relay.harnery.com; point clients at it via `.harnery/config.jsonc` →
 * `{ "presence": { "relay": "ws://host:port" } }`.
 *
 * Bun-only (Bun.serve WebSockets), like `harn tunnel` — fails fast with a
 * clear message on a Bun-free host.
 */

const MAX_SOCKETS_PER_ROOM = 64;
const RATE_BURST = 10;
const RATE_REFILL_MS = 2000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const ROOM_ID_RE = /^[0-9a-f]{32}$/;

interface RoomState {
  sockets: Set<unknown>;
  cache: Map<string, { raw: string; at: number }>;
}

interface SocketData {
  roomId: string;
  bucketTokens: number;
  bucketAt: number;
}

/** Start the relay server. Exported for in-process integration tests. */
export function startRelayServer(port: number): { port: number; stop: () => void } {
  if (typeof Bun === "undefined" || typeof Bun.serve !== "function") {
    throw new Error("relay serve requires Bun (Bun.serve WebSockets)");
  }
  const rooms = new Map<string, RoomState>();

  const roomOf = (roomId: string): RoomState => {
    let r = rooms.get(roomId);
    if (!r) {
      r = { sockets: new Set(), cache: new Map() };
      rooms.set(roomId, r);
    }
    return r;
  };

  const server = Bun.serve<SocketData>({
    port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/" || url.pathname === "/healthz") {
        return Response.json({ ok: true, service: "harnery-presence-relay", v: 1 });
      }
      const m = /^\/v1\/room\/([0-9a-f]{32})$/.exec(url.pathname);
      if (!m || !ROOM_ID_RE.test(m[1]!)) return new Response("not found", { status: 404 });
      const room = roomOf(m[1]!);
      if (room.sockets.size >= MAX_SOCKETS_PER_ROOM) {
        return new Response("room full", { status: 429 });
      }
      const ok = srv.upgrade(req, {
        data: { roomId: m[1]!, bucketTokens: RATE_BURST, bucketAt: Date.now() },
      });
      return ok ? undefined : new Response("expected websocket", { status: 426 });
    },
    websocket: {
      open(ws) {
        const room = roomOf(ws.data.roomId);
        room.sockets.add(ws);
        const now = Date.now();
        for (const [sender, entry] of room.cache) {
          if (now - entry.at > CACHE_TTL_MS) {
            room.cache.delete(sender);
            continue;
          }
          ws.send(entry.raw);
        }
        ws.send(JSON.stringify({ t: "hello", peers: room.sockets.size }));
      },
      message(ws, message) {
        if (typeof message !== "string" || message.length > MAX_FRAME_BYTES) return;
        // Rate limit (token bucket per socket).
        const d = ws.data;
        const now = Date.now();
        const refill = Math.floor((now - d.bucketAt) / RATE_REFILL_MS);
        if (refill > 0) {
          d.bucketTokens = Math.min(RATE_BURST, d.bucketTokens + refill);
          d.bucketAt = now;
        }
        if (d.bucketTokens <= 0) return;
        d.bucketTokens -= 1;

        let frame: { t?: unknown; sender?: unknown };
        try {
          frame = JSON.parse(message) as typeof frame;
        } catch {
          return;
        }
        if (
          frame.t !== "pub" ||
          typeof frame.sender !== "string" ||
          !/^[0-9a-f]+$/.test(frame.sender) ||
          frame.sender.length > 64
        ) {
          return;
        }
        const room = roomOf(d.roomId);
        room.cache.set(frame.sender, { raw: message, at: now });
        for (const peer of room.sockets) {
          if (peer === ws) continue;
          try {
            (peer as { send(m: string): void }).send(message);
          } catch {
            /* dead socket */
          }
        }
      },
      close(ws) {
        const room = rooms.get(ws.data.roomId);
        if (!room) return;
        room.sockets.delete(ws);
        if (room.sockets.size === 0 && room.cache.size === 0) rooms.delete(ws.data.roomId);
      },
    },
  });

  return {
    port: server.port ?? port,
    stop: () => server.stop(true),
  };
}

export function registerRelayCommand(program: Command, emit: EmitContext): void {
  const cmd = program
    .command("relay")
    .description("Self-host the presence relay (see also relay/worker/ for the Cloudflare host)");

  cmd
    .command("serve")
    .description(
      "Run the presence relay on this machine (Bun-only; same protocol as relay/worker/)",
    )
    .option("--port <n>", "Port to listen on", "8787")
    .action((opts: { port: string }) => {
      let server: { port: number; stop: () => void };
      try {
        server = startRelayServer(Number.parseInt(opts.port, 10));
      } catch (e) {
        emit.error({
          code: "relay_serve_failed",
          message: e instanceof Error ? e.message : String(e),
        });
        process.exit(1);
      }
      emit.log(`presence relay listening on :${server.port} (ws path: /v1/room/<room-id>)`, "info");
      // Foreground service: run until interrupted.
    });
}
