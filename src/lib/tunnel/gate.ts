// Reverse-proxy worker spawned by `tunnel up`. Listens on 127.0.0.1:<port>
// and forwards HTTP + WebSocket requests to an upstream with a Host header
// rewrite and Content-Encoding stripped (Bun's fetch auto-decompresses the
// body but retains the encoding header, which breaks browser decoding
// downstream). Cloudflare provider mode checks CF-Connecting-IP against an
// allowlist; trusted local proxy mode lets the local exposer own access.
//
// Runs detached, outside the CLI command framework; no command context is
// available; stdout/stderr is captured into .cache/tunnel/gate.log by the
// spawner.

import { renderTunnelErrorPage } from "./error-page";

// `--port`/`--name` are also passed on argv (not just env) so the gate's port
// and instance name show up in its process command line. That's what lets
// `tunnel down` scope its stray-process sweep to a single instance via
// `pgrep -f`: every instance runs the same `bun run gate.ts`, so the port in
// the command line is the only thing that distinguishes them. Env stays the
// source of truth; argv is read only as a fallback/marker.
function argvFlag(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const ALLOW = new Set(
  (process.env.HARNERY_TUNNEL_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const TARGET = process.env.HARNERY_TUNNEL_TARGET ?? "127.0.0.1:8001";
const VHOST = process.env.HARNERY_TUNNEL_VHOST ?? "localhost";
const PORT = Number(process.env.HARNERY_TUNNEL_PORT ?? argvFlag("--port") ?? "9001");
const ACCESS = process.env.HARNERY_TUNNEL_ACCESS ?? "cloudflare-allowlist";
const NAME = argvFlag("--name") ?? "default";

const UPSTREAM_HTTP = `http://${TARGET}`;
const UPSTREAM_WS = `ws://${TARGET}`;

interface WsData {
  path: string;
}

function requestDetails(req: Request, url: URL) {
  return {
    incidentId: crypto.randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    tunnelName: NAME,
    method: req.method,
    path: url.pathname + url.search,
    clientIp: req.headers.get("cf-connecting-ip") ?? "",
    cloudflareRay: req.headers.get("cf-ray") ?? "",
  };
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (!(error instanceof Error)) {
    return { code: "UnknownError", message: String(error) };
  }
  const code =
    "code" in error && typeof error.code === "string" ? error.code : error.name || "Error";
  return { code, message: error.message || "The upstream request failed." };
}

const server = Bun.serve<WsData, never>({
  port: PORT,
  hostname: "127.0.0.1",
  // Bun.serve defaults idleTimeout to 10s. LLM SSE streams commonly take
  // longer than that between events (first-token latency + tool-call
  // pauses), so 10s would kill in-flight chats over the tunnel. 255s is
  // Bun's max, and beyond any realistic single-turn delay.
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (ACCESS === "cloudflare-allowlist") {
      const ip = req.headers.get("cf-connecting-ip") ?? "";
      if (!ALLOW.has(ip)) {
        const details = requestDetails(req, url);
        // Log denials so operators can whitelist a phone/laptop that just
        // hit 403 without asking the human to dig up their public IP.
        console.log(
          // lint-ok-emission: detached worker, see file note above
          `deny: incident=${details.incidentId} ip=${ip || "(missing-cf-connecting-ip)"} ray=${details.cloudflareRay || "(missing)"} ${req.method} ${details.path}`,
        );
        return new Response(renderTunnelErrorPage({ ...details, kind: "access-denied" }), {
          status: 403,
          headers: {
            "cache-control": "no-store",
            "content-type": "text/html; charset=utf-8",
            "x-harnery-tunnel-incident": details.incidentId,
          },
        });
      }
    }

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (server.upgrade(req, { data: { path: url.pathname + url.search } })) {
        return undefined;
      }
      return new Response("WS upgrade failed\n", { status: 500 });
    }

    const headers = new Headers(req.headers);
    headers.set("host", VHOST);
    headers.set("accept-encoding", "identity");
    headers.delete("connection");

    const init: RequestInit = {
      method: req.method,
      headers,
      redirect: "manual",
    };
    if (!["GET", "HEAD"].includes(req.method)) {
      init.body = await req.arrayBuffer();
    }
    let resp: Response;
    try {
      resp = await fetch(UPSTREAM_HTTP + url.pathname + url.search, init);
    } catch (error) {
      const details = requestDetails(req, url);
      const failure = errorDetails(error);
      console.log(
        // lint-ok-emission: detached worker, see file note above
        `upstream-error: incident=${details.incidentId} ip=${details.clientIp || "(missing-cf-connecting-ip)"} ray=${details.cloudflareRay || "(missing)"} code=${failure.code} ${req.method} ${details.path}`,
      );
      return new Response(
        renderTunnelErrorPage({
          ...details,
          kind: "upstream-unavailable",
          target: UPSTREAM_HTTP,
          errorCode: failure.code,
          errorMessage: failure.message,
        }),
        {
          // Cloudflare replaces 502 response bodies with its own generic error
          // page. Return the diagnostic as a successful document and preserve
          // the semantic status in a header so the human can actually see it.
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "text/html; charset=utf-8",
            "x-harnery-tunnel-incident": details.incidentId,
            "x-harnery-tunnel-status": "502",
          },
        },
      );
    }
    const respHeaders = new Headers(resp.headers);
    respHeaders.delete("content-encoding");
    respHeaders.delete("content-length");
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
    });
  },
  websocket: {
    open(ws) {
      const { path } = ws.data;
      // Bun's WebSocket constructor accepts a `headers` option at runtime
      // even though the standard lib.dom.d.ts WebSocket type doesn't.
      const upstream = new WebSocket(UPSTREAM_WS + path, {
        headers: { host: VHOST },
      } as unknown as undefined);
      upstream.binaryType = "arraybuffer";
      (ws as unknown as { upstream?: WebSocket }).upstream = upstream;
      upstream.onmessage = (ev) => ws.send(ev.data);
      upstream.onerror = () => ws.close();
      upstream.onclose = () => ws.close();
    },
    message(ws, msg) {
      const u = (ws as unknown as { upstream?: WebSocket }).upstream;
      if (u && u.readyState === 1) u.send(msg);
    },
    close(ws) {
      const u = (ws as unknown as { upstream?: WebSocket }).upstream;
      u?.close();
    },
  },
});

// This worker runs detached via `bun run gate.ts`, outside the CLI command
// framework, so no AsyncLocalStorage context is available. stdout/stderr is
// captured into .cache/tunnel/gate.log by the spawning command.
console.log(`harn-tunnel-gate :${server.port} -> ${UPSTREAM_HTTP} (Host: ${VHOST})`); // lint-ok-emission: detached worker, see file note above
console.log(`access: ${ACCESS}`); // lint-ok-emission: detached worker, see file note above
console.log(`allow: ${[...ALLOW].join(", ") || "(empty, not used outside allowlist mode)"}`); // lint-ok-emission: detached worker, see file note above
