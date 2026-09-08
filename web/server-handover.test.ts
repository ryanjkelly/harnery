import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(new URL("./server-handover.mjs", import.meta.url));
const keepalivePath = fileURLToPath(new URL("./server-keepalive.mjs", import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });

const fixture = `
  const http = require("node:http");
  const server = http.createServer((request, response) => {
    response.setHeader("x-served-by", process.env.FIXTURE_ID || "fixture");
    if (request.url === "/slow") {
      response.flushHeaders();
      setTimeout(() => response.end("finished"), 300);
      return;
    }
    response.end("ok " + request.url);
  });
  server.on("upgrade", (request, socket) => {
    socket.end("HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\n\\r\\n");
  });
  server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

function startFixture(env: Record<string, string>): Promise<{ child: ChildProcess; port: number }> {
  // The dashboard runs under Node; test the runtime that loads the preload.
  const child = spawn("node", ["--import", keepalivePath, "--import", modulePath, "-e", fixture], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      const firstLine = stdout.split("\n")[0]?.trim();
      if (firstLine && /^\d+$/.test(firstLine)) resolve({ child, port: Number(firstLine) });
    });
    child.once("error", reject);
  });
}

async function waitForPort(port: number, ms: number): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/hello`);
      return `${response.headers.get("x-served-by")}:${await response.text()}`;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return undefined;
}

describe("web server handover preload", () => {
  test("lets an in-flight response finish when its listener drains", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "harnery-web-inflight-"));
    roots.push(root);
    const drain = path.join(root, "drain");
    const { port } = await startFixture({ HARNERY_WEB_DRAIN_FILE: drain });
    const { get } = await import("node:http");
    const body = await new Promise<string>((resolve, reject) => {
      const request = get(`http://127.0.0.1:${port}/slow`, { agent: false }, (response) => {
        writeFileSync(drain, "");
        let received = "";
        response.on("data", (chunk) => {
          received += chunk;
        });
        response.once("end", () => resolve(received));
        response.once("error", reject);
      });
      request.once("error", reject);
      request.setTimeout(2000, () => request.destroy(new Error("response timeout")));
    });
    expect(body).toBe("finished");
    expect(existsSync(drain)).toBe(false);
  });

  test("drains pooled sockets across successive public-port handovers", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "harnery-web-drain-"));
    roots.push(root);
    const { Agent, get } = await import("node:http");
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const drainFiles = [0, 1, 2].map((i) => path.join(root, `drain-${i}`));
    const initial = await startFixture({
      FIXTURE_ID: "old",
      HARNERY_WEB_DRAIN_FILE: drainFiles[0],
    });
    const publicPort = initial.port;
    const read = (pooled: boolean) =>
      new Promise<{ by: string; connection: string | undefined }>((resolve, reject) => {
        const req = get(
          `http://127.0.0.1:${publicPort}/hello`,
          { agent: pooled ? agent : false },
          (res) => {
            res.resume();
            res.once("end", () =>
              resolve({
                by: String(res.headers["x-served-by"]),
                connection: res.headers.connection,
              }),
            );
          },
        );
        req.once("error", reject);
        req.setTimeout(2000, () => req.destroy(new Error("request timeout")));
      });
    try {
      expect((await read(true)).by).toBe("old");
      for (let generation = 1; generation <= 2; generation++) {
        const handover = path.join(root, `handover-${generation}`);
        await startFixture({
          FIXTURE_ID: `new-${generation}`,
          HARNERY_WEB_PUBLIC_PORT: String(publicPort),
          HARNERY_WEB_HANDOVER_FILE: handover,
          HARNERY_WEB_DRAIN_FILE: drainFiles[generation],
        });
        writeFileSync(handover, "");
        writeFileSync(drainFiles[generation - 1], "");
        const deadline = Date.now() + 2000;
        while (!existsSync(`${handover}.ready`) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(existsSync(`${handover}.ready`)).toBe(true);
        expect((await read(false)).by).toBe(`new-${generation}`);
        // A socket pooled before the switch still receives a complete response
        // from the retiring process, with an explicit request to reconnect.
        expect(await read(true)).toEqual({
          by: generation === 1 ? "old" : "new-1",
          connection: "close",
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(existsSync(`${drainFiles[generation - 1]}.drained`)).toBe(true);
        expect((await read(true)).by).toBe(`new-${generation}`);
      }
    } finally {
      agent.destroy();
    }
  });

  test("takes the public port when the handover file appears, retrying while it is still held", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "harnery-web-handover-"));
    roots.push(root);
    const publicPort = await freePort();
    const handoverFile = path.join(root, "handover");

    // Something else holds the public port at first, as the old process would.
    const holder = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => holder.listen(publicPort, resolve));

    const { port } = await startFixture({
      HARNERY_WEB_PUBLIC_PORT: String(publicPort),
      HARNERY_WEB_HANDOVER_FILE: handoverFile,
    });
    expect(await waitForPort(port, 2_000)).toBe("fixture:ok /hello");

    writeFileSync(handoverFile, "");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(existsSync(`${handoverFile}.ready`)).toBe(false);
    await new Promise<void>((resolve) => holder.close(() => resolve()));

    expect(await waitForPort(publicPort, 5_000)).toBe("fixture:ok /hello");
    expect(existsSync(`${handoverFile}.ready`)).toBe(true);
    const { Agent, get } = await import("node:http");
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const read = () =>
      new Promise<{ reused: boolean; keepalive: string | undefined }>((resolve, reject) => {
        const request = get(`http://127.0.0.1:${publicPort}/reuse`, { agent }, (response) => {
          response.resume();
          response.once("end", () =>
            resolve({
              reused: request.reusedSocket,
              keepalive: response.headers["keep-alive"]?.toString(),
            }),
          );
        });
        request.once("error", reject);
      });
    try {
      expect((await read()).keepalive).toBe("timeout=72");
      expect((await read()).reused).toBe(true);
    } finally {
      agent.destroy();
    }
    const { connect } = await import("node:net");
    const upgraded = await new Promise<string>((resolve, reject) => {
      const socket = connect(publicPort, "127.0.0.1", () => {
        socket.write(
          "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n",
        );
      });
      socket.setTimeout(2000, () => socket.destroy(new Error("upgrade timeout")));
      socket.once("error", reject);
      socket.once("data", (data) => {
        resolve(String(data));
        socket.destroy();
      });
    });
    expect(upgraded).toContain("101 Switching Protocols");
    // The ephemeral listener keeps working beside the public one.
    expect(await waitForPort(port, 2_000)).toBe("fixture:ok /hello");
  });

  test("stays inert without the public port and handover file", async () => {
    const publicPort = await freePort();
    const { port } = await startFixture({ HARNERY_WEB_PUBLIC_PORT: String(publicPort) });
    expect(await waitForPort(port, 2_000)).toBe("fixture:ok /hello");
    expect(await waitForPort(publicPort, 500)).toBeUndefined();
  });
});
