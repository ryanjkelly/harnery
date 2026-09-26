import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { join } from "node:path";
import { ALLOW_PATHS_ENV } from "./path-scope";

// Runs the real detached gate worker against a stub upstream, the way
// `tunnel up` does, and checks what a tunneled request can reach.

const CLIENT_IP = "203.0.113.8";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

async function waitForGate(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { headers: { "cf-connecting-ip": CLIENT_IP } });
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error(`gate did not listen on ${port}`);
}

interface Gate {
  port: number;
  proc: ChildProcess;
}

async function startGate(upstreamPort: number, allowPaths: string): Promise<Gate> {
  const port = await freePort();
  const proc = spawn("bun", ["run", join(import.meta.dir, "gate.ts"), "--port", String(port)], {
    env: {
      ...process.env,
      HARNERY_TUNNEL_ACCESS: "cloudflare-allowlist",
      HARNERY_TUNNEL_ALLOW: CLIENT_IP,
      HARNERY_TUNNEL_TARGET: `127.0.0.1:${upstreamPort}`,
      HARNERY_TUNNEL_VHOST: `localhost:${upstreamPort}`,
      HARNERY_TUNNEL_PORT: String(port),
      [ALLOW_PATHS_ENV]: allowPaths,
    },
    stdio: "ignore",
  });
  await waitForGate(port);
  return { port, proc };
}

describe("tunnel gate path scope", () => {
  const upstreamHits: string[] = [];
  let upstream: ReturnType<typeof Bun.serve>;
  let scoped: Gate;
  let unscoped: Gate;

  beforeAll(async () => {
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        upstreamHits.push(url.pathname + url.search);
        return new Response(`upstream ${url.pathname}`);
      },
    });
    const upstreamPort = upstream.port as number;
    [scoped, unscoped] = await Promise.all([
      startGate(upstreamPort, "/decisions,/_next"),
      startGate(upstreamPort, ""),
    ]);
  });

  afterAll(() => {
    scoped?.proc.kill();
    unscoped?.proc.kill();
    upstream?.stop(true);
  });

  async function get(gate: Gate, path: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${gate.port}${path}`, {
      headers: { "cf-connecting-ip": CLIENT_IP },
      redirect: "manual",
    });
  }

  test("serves a path inside the allowed scope", async () => {
    const res = await get(scoped, "/decisions/42?tab=open");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream /decisions/42");
    expect(upstreamHits).toContain("/decisions/42?tab=open");
  });

  test("refuses the repo file viewer and file API over the tunnel", async () => {
    const before = upstreamHits.length;
    for (const path of [
      "/files?path=private/credentials.php",
      "/api/file?path=private/credentials.php",
      "/api/file/text?path=config/access.yml",
      "/private/credentials.php",
      "/",
    ]) {
      const res = await get(scoped, path);
      expect(res.status).toBe(403);
      expect(res.headers.get("x-harnery-tunnel-incident")).toBeTruthy();
      expect(await res.text()).toContain("This page is not shared");
    }
    expect(upstreamHits.length).toBe(before);
  });

  test("refuses traversal from an allowed prefix into the file viewer", async () => {
    const before = upstreamHits.length;
    for (const path of [
      "/decisions/../files",
      "/decisions/%2e%2e/files",
      "/decisions%2F..%2Ffiles",
    ]) {
      expect((await get(scoped, path)).status).toBe(403);
    }
    expect(upstreamHits.length).toBe(before);
  });

  test("refuses every path when the tunnel has no scope", async () => {
    const before = upstreamHits.length;
    expect((await get(unscoped, "/decisions")).status).toBe(403);
    expect((await get(unscoped, "/files")).status).toBe(403);
    expect(upstreamHits.length).toBe(before);
  });

  test("still refuses an unlisted client before checking the path", async () => {
    const res = await fetch(`http://127.0.0.1:${scoped.port}/decisions`, {
      headers: { "cf-connecting-ip": "198.51.100.1" },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("This device is not allowed yet");
  });
});
