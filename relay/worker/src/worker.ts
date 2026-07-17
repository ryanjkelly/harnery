/**
 * harnery presence relay — Cloudflare Workers + Durable Objects host.
 *
 * A dumb WebSocket fan-out relay for harnery's cross-machine presence
 * (decision record 0016, phase 2). One Durable Object instance per room
 * (`idFromName(roomId)` gives the single-instance-per-room guarantee a
 * fan-out room needs); the WebSocket Hibernation API keeps idle connections
 * effectively free.
 *
 * The relay is deliberately blind:
 *   - room ids are opaque 32-hex capability strings derived client-side
 *   - sender ids are opaque HMAC-derived strings
 *   - payloads are AES-GCM ciphertext end-to-end; no plaintext ever arrives
 * There are no accounts and nothing to configure. Abuse is bounded by frame
 * caps, per-socket rate limits, and per-room connection caps.
 *
 * Deploy: `wrangler deploy` from relay/worker/ (see README.md).
 * Self-hosters who prefer their own box can run the Bun host instead
 * (`harn relay serve`) — same wire protocol.
 */

// Minimal ambient types so this file typechecks standalone without pulling
// @cloudflare/workers-types into harnery's dependency tree (wrangler bundles
// with esbuild and does not typecheck).
interface DurableObjectStateLike {
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    list<T>(opts?: { prefix?: string }): Promise<Map<string, T>>;
  };
}
interface EnvLike {
  ROOMS: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(req: Request): Promise<Response> };
  };
}
declare global {
  interface WebSocket {
    serializeAttachment?(value: unknown): void;
    deserializeAttachment?(): unknown;
    accept?(): void;
  }
  interface ResponseInit {
    webSocket?: WebSocket | null;
  }
  // Workers runtime global; absent in plain DOM lib.
  const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };
}

const MAX_FRAME_BYTES = 16 * 1024;
const MAX_SOCKETS_PER_ROOM = 64;
/** Token bucket: burst of 10 frames, refill 1 per 2s. */
const RATE_BURST = 10;
const RATE_REFILL_MS = 2000;
/** Cached last-message-per-sender entries older than this are dropped at
 * read time (senders keepalive every ~5 min; 15 min = offline). */
const CACHE_TTL_MS = 15 * 60 * 1000;

const ROOM_ID_RE = /^[0-9a-f]{32}$/;

interface CachedPub {
  raw: string;
  at: number;
}

interface SocketState {
  bucketTokens: number;
  bucketAt: number;
}

/** One instance per room. In-memory state is disposable (hibernation evicts
 * it); the warm-join cache lives in DO storage so a joiner right after an
 * eviction still gets the room's last known state. */
export class PresenceRoom {
  private state: DurableObjectStateLike;
  private sockets = new Map<WebSocket, SocketState>();

  constructor(state: DurableObjectStateLike) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    if (this.state.getWebSockets().length >= MAX_SOCKETS_PER_ROOM) {
      return new Response("room full", { status: 429 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernation API: the runtime holds the socket and wakes this DO per
    // message — no duration billing while idle.
    this.state.acceptWebSocket(server);

    // Warm join: replay the last cached publication per sender, then greet.
    const cached = await this.state.storage.list<CachedPub>({ prefix: "s:" });
    const now = Date.now();
    for (const [key, entry] of cached) {
      if (now - entry.at > CACHE_TTL_MS) {
        await this.state.storage.delete(key);
        continue;
      }
      try {
        server.send(entry.raw);
      } catch {
        /* socket already gone */
      }
    }
    try {
      server.send(JSON.stringify({ t: "hello", peers: this.state.getWebSockets().length }));
    } catch {
      /* ignore */
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > MAX_FRAME_BYTES) return;
    if (!this.allowByRate(ws)) return;

    // Shape-validate without trusting anything: pub frames only.
    let frame: { t?: unknown; sender?: unknown; iv?: unknown; ct?: unknown };
    try {
      frame = JSON.parse(message) as typeof frame;
    } catch {
      return;
    }
    if (
      frame.t !== "pub" ||
      typeof frame.sender !== "string" ||
      frame.sender.length === 0 ||
      frame.sender.length > 64 ||
      !/^[0-9a-f]+$/.test(frame.sender) ||
      typeof frame.iv !== "string" ||
      typeof frame.ct !== "string"
    ) {
      return;
    }

    // Cache for warm joins, then fan out to everyone else in the room.
    await this.state.storage.put(`s:${frame.sender}`, {
      raw: message,
      at: Date.now(),
    } satisfies CachedPub);
    for (const peer of this.state.getWebSockets()) {
      if (peer === ws) continue;
      try {
        peer.send(message);
      } catch {
        /* dead socket; runtime reaps it */
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.sockets.delete(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.sockets.delete(ws);
  }

  /** Per-socket token bucket, kept in plain memory: rate state is disposable
   * across hibernation (a fresh bucket after eviction just means one extra
   * burst allowance, which is fine). */
  private allowByRate(ws: WebSocket): boolean {
    const now = Date.now();
    let s = this.sockets.get(ws);
    if (!s) {
      s = { bucketTokens: RATE_BURST, bucketAt: now };
      this.sockets.set(ws, s);
    }
    const refill = Math.floor((now - s.bucketAt) / RATE_REFILL_MS);
    if (refill > 0) {
      s.bucketTokens = Math.min(RATE_BURST, s.bucketTokens + refill);
      s.bucketAt = now;
    }
    if (s.bucketTokens <= 0) return false;
    s.bucketTokens -= 1;
    return true;
  }
}

export default {
  async fetch(request: Request, env: EnvLike): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "harnery-presence-relay", v: 1 });
    }

    // GET /v1/room/<roomId> with Upgrade: websocket
    const m = /^\/v1\/room\/([0-9a-f]{32})$/.exec(url.pathname);
    if (!m || !ROOM_ID_RE.test(m[1]!)) {
      return new Response("not found", { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const id = env.ROOMS.idFromName(m[1]!);
    return env.ROOMS.get(id).fetch(request);
  },
};
