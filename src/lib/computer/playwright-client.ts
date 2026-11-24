/**
 * The small MCP client that `harn computer` runs beside the Playwright MCP
 * server (ADR 0276). It is written into the driver's install directory and
 * run with the same Node as the server, because on WSL the server listens on
 * the Windows loopback, which the WSL side cannot reach.
 *
 * It speaks the streamable HTTP transport: one POST per JSON-RPC message, the
 * session in the `mcp-session-id` header, and the reply as JSON or as
 * server-sent events. Every operation prints one JSON line and exits 0 unless
 * the server could not be reached at all (exit 3).
 *
 *   ping  <port>
 *   init  <port> <client-name>             -> {"sid": "..."}
 *   call  <port> <sid> <tool> <b64-json>   -> {"status": 200, "result": {...}} or {"status": 404, ...}
 *   tools <port>                           -> {"tools": [...]}
 *   end   <port> <sid>                     -> {"status": 200}
 *
 * Internal module: not exported from package.json.
 */

export const PLAYWRIGHT_CLIENT_FILE = "harnery-mcp-client.mjs";

export const PLAYWRIGHT_CLIENT_SOURCE = `// Written by harn computer (ADR 0276). Do not edit; reinstall the driver instead.
const [op, port, a, b, c] = process.argv.slice(2);
const url = "http://127.0.0.1:" + port + "/mcp";
const out = (value) => { process.stdout.write(JSON.stringify(value) + "\\n"); };
const PROTOCOL = "2025-06-18";

async function post(body, sid, timeoutMs) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sid) headers["mcp-session-id"] = sid;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs ?? 30000) });
  const text = await response.text();
  let message = null;
  const events = text.split("\\n").filter((line) => line.startsWith("data:"));
  try { message = events.length > 0 ? JSON.parse(events[events.length - 1].slice(5)) : (text ? JSON.parse(text) : null); } catch { message = null; }
  return { status: response.status, sid: response.headers.get("mcp-session-id"), message, text };
}

async function init(name) {
  const r = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name, version: "0" } } });
  if (!r.sid) return { status: r.status, error: r.text.slice(0, 400) };
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, r.sid);
  return { status: r.status, sid: r.sid };
}

async function end(sid) {
  const response = await fetch(url, { method: "DELETE", headers: { "mcp-session-id": sid }, signal: AbortSignal.timeout(10000) });
  return { status: response.status };
}

try {
  if (op === "ping") {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3000) });
    out({ status: response.status });
  } else if (op === "init") {
    out(await init(a));
  } else if (op === "call") {
    const args = JSON.parse(Buffer.from(c ?? "", "base64").toString("utf8") || "{}");
    const r = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: b, arguments: args } }, a, Number(process.argv[7] ?? 120000));
    out({ status: r.status, result: r.message?.result ?? null, error: r.message?.error ?? null, text: r.message ? undefined : r.text.slice(0, 400) });
  } else if (op === "tools") {
    const session = await init("harnery-catalog");
    if (!session.sid) { out(session); } else {
      const r = await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, session.sid);
      await end(session.sid).catch(() => undefined);
      out({ status: r.status, tools: r.message?.result?.tools ?? [] });
    }
  } else if (op === "end") {
    out(await end(a));
  } else {
    out({ error: "unknown operation " + op });
    process.exitCode = 2;
  }
} catch (error) {
  out({ unreachable: true, error: String(error && error.message ? error.message : error) });
  process.exitCode = 3;
}
`;
