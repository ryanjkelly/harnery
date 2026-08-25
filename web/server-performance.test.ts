import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(new URL("./server-performance.mjs", import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("web server performance preload", () => {
  test("records a slow request and its overlapping event-loop delay under Node", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "harnery-web-preload-"));
    roots.push(root);
    const fixture = `
      const http = require("node:http");
      const server = http.createServer((_request, response) => {
        const until = Date.now() + 120;
        while (Date.now() < until) {}
        setImmediate(() => {
          response.end("ok");
          setTimeout(() => server.close(), 150);
        });
      });
      server.listen(0, "127.0.0.1", () => console.log(server.address().port));
    `;
    // The test suite runs under Bun, but the dashboard runs under Node. Invoke
    // Node explicitly so this covers the runtime whose diagnostics channels we
    // rely on instead of accidentally testing Bun's `--import` behavior.
    const child = spawn("node", ["--import", modulePath, "-e", fixture], {
      env: {
        ...process.env,
        HARNERY_COORD_ROOT: root,
        HARNERY_WEB_MODE: "test",
        HARNERY_WEB_SLOW_REQUEST_MS: "20",
        HARNERY_WEB_EVENT_LOOP_DELAY_MS: "20",
        HARNERY_WEB_MEMORY_SAMPLE_MS: "25",
        HARNERY_WEB_GC_PAUSE_MS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const port = await new Promise<number>((resolve, reject) => {
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        const firstLine = stdout.split("\n")[0]?.trim();
        if (firstLine && /^\d+$/.test(firstLine)) resolve(Number(firstLine));
      });
      child.once("error", reject);
    });
    expect(await (await fetch(`http://127.0.0.1:${port}/slow?secret=omitted`)).text()).toBe("ok");
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(exitCode).toBe(0);

    const log = readFileSync(path.join(root, ".harnery", "logs", "web-performance.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const request = log.find((event) => event.event === "request_complete");
    const delay = log.find((event) => event.event === "event_loop_delay");
    const memory = log.find((event) => event.event === "memory_sample");
    expect(request).toMatchObject({
      route: "/slow",
      slow: true,
      stream: false,
      outcome: "finished",
    });
    expect(request.duration_ms).toBeGreaterThanOrEqual(100);
    expect(delay.delay_ms).toBeGreaterThanOrEqual(20);
    expect(delay.active_requests[0]).toMatchObject({ route: "/slow" });
    expect(delay).toMatchObject({
      rss_bytes: expect.any(Number),
      heap_used_bytes: expect.any(Number),
    });
    expect(memory).toMatchObject({
      reason: "started",
      rss_bytes: expect.any(Number),
      heap_used_bytes: expect.any(Number),
      heap_limit_bytes: expect.any(Number),
      gc_count: expect.any(Number),
    });
    expect(JSON.stringify(log)).not.toContain("secret=omitted");
  });

  test("does not implicate an idle event stream in a later event-loop delay", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "harnery-web-preload-stream-"));
    roots.push(root);
    const fixture = `
      const http = require("node:http");
      let streamResponse;
      const server = http.createServer((request, response) => {
        if (request.url === "/stream") {
          streamResponse = response;
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write("event: ready\\ndata: {}\\n\\n");
          return;
        }
        const until = Date.now() + 100;
        while (Date.now() < until) {}
        setImmediate(() => {
          response.end("ok");
          streamResponse.end();
          setTimeout(() => server.close(), 150);
        });
      });
      server.listen(0, "127.0.0.1", () => console.log(server.address().port));
    `;
    const child = spawn("node", ["--import", modulePath, "-e", fixture], {
      env: {
        ...process.env,
        HARNERY_COORD_ROOT: root,
        HARNERY_WEB_MODE: "test",
        HARNERY_WEB_SLOW_REQUEST_MS: "20",
        HARNERY_WEB_EVENT_LOOP_DELAY_MS: "20",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const port = await new Promise<number>((resolve, reject) => {
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        const firstLine = stdout.split("\n")[0]?.trim();
        if (firstLine && /^\d+$/.test(firstLine)) resolve(Number(firstLine));
      });
      child.once("error", reject);
    });

    const stream = fetch(`http://127.0.0.1:${port}/stream`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await (await fetch(`http://127.0.0.1:${port}/blocking`)).text()).toBe("ok");
    await stream;
    expect(await new Promise<number | null>((resolve) => child.once("exit", resolve))).toBe(0);

    const log = readFileSync(path.join(root, ".harnery", "logs", "web-performance.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const delay = log.find((event) => event.event === "event_loop_delay");
    expect(delay.active_requests.map((request: { route: string }) => request.route)).toEqual([
      "/blocking",
    ]);
  });
});
