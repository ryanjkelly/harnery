import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BrowserSessionInspection,
  BrowserSessionLocator,
  BrowserSessionScreenshot,
  BrowserSessionStatus,
  BrowserSessionTab,
} from "./client.ts";
import {
  BROWSER_SESSION_MAX_FRAME_BYTES,
  BROWSER_SESSION_PROTOCOL_VERSION,
  type BrowserSessionDescriptor,
  BrowserSessionError,
  type BrowserSessionRequest,
  type BrowserSessionServer,
  type BrowserSessionTarget,
  browserSessionTransport,
  readBrowserSessionDescriptor,
  sendBrowserSessionRequest,
  sendRequestToDescriptor,
  startBrowserSessionServer,
} from "./session-control.ts";

class FakeTarget implements BrowserSessionTarget {
  revision = 0;
  activeActions = 0;
  maxActiveActions = 0;
  actionDelayMs = 0;
  neverSettle = false;
  filled = "";

  private navigation() {
    return {
      sequence: 1,
      occurred_at: "2026-08-09T12:00:00.000Z",
      url: "https://example.test/",
      type: "navigate" as const,
    };
  }

  private async mutate(): Promise<{ revision: number }> {
    this.activeActions++;
    this.maxActiveActions = Math.max(this.maxActiveActions, this.activeActions);
    if (this.neverSettle) return await new Promise(() => {});
    try {
      if (this.actionDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.actionDelayMs));
      }
      this.revision++;
      return { revision: this.revision };
    } finally {
      this.activeActions--;
    }
  }

  async sessionStatus(): Promise<BrowserSessionStatus> {
    return {
      phase: "ready",
      active_tab: 0,
      tab_count: 1,
      revision: this.revision,
      navigation: this.navigation(),
    };
  }
  async sessionInspect(): Promise<BrowserSessionInspection> {
    return {
      active_tab: 0,
      url: "https://example.test/",
      title: "Fixture",
      text: "Fixture",
      controls: [],
      focus: null,
      revision: this.revision,
      navigation: this.navigation(),
      truncated: false,
    };
  }
  async sessionScreenshot(out: string): Promise<BrowserSessionScreenshot> {
    return { path: out, width: 10, height: 10, revision: ++this.revision };
  }
  async sessionTabs(): Promise<BrowserSessionTab[]> {
    return [await this.tab()];
  }
  async sessionSelectTab(): Promise<BrowserSessionTab> {
    return this.tab(true);
  }
  async sessionOpenTab(): Promise<BrowserSessionTab> {
    return this.tab(true);
  }
  async sessionCloseTab(): Promise<BrowserSessionTab> {
    return this.tab(true);
  }
  async sessionGoto(): Promise<BrowserSessionTab> {
    return this.tab(true);
  }
  async sessionReload(): Promise<BrowserSessionTab> {
    return this.tab(true);
  }
  async sessionClick(_locator: BrowserSessionLocator): Promise<{ revision: number }> {
    return this.mutate();
  }
  async sessionFill(_locator: BrowserSessionLocator, value: string): Promise<{ revision: number }> {
    this.filled = value;
    return this.mutate();
  }
  async sessionPress(): Promise<{ revision: number }> {
    return this.mutate();
  }
  async sessionWait(): Promise<{ revision: number }> {
    return this.mutate();
  }

  private async tab(mutate = false): Promise<BrowserSessionTab> {
    if (mutate) await this.mutate();
    return {
      index: 0,
      title: "Fixture",
      url: "https://example.test/",
      active: true,
      revision: this.revision,
      navigation: this.navigation(),
    };
  }
}

const servers: BrowserSessionServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.cleanup()));
});

function privateDir(): string {
  // Keep the macOS /var/folders prefix plus the random socket suffix below
  // the Unix-domain socket path limit enforced by session-control.
  const dir = mkdtempSync(join(tmpdir(), "hbs-"));
  chmodSync(dir, 0o700);
  return dir;
}

async function start(
  target = new FakeTarget(),
  options: { actionTimeoutMs?: number; shortActionTimeoutMs?: number } = {},
): Promise<{ target: FakeTarget; server: BrowserSessionServer; controlFile: string }> {
  const controlFile = join(privateDir(), "control.json");
  const server = await startBrowserSessionServer(controlFile, target, options);
  servers.push(server);
  return { target, server, controlFile };
}

describe("browser session control transport", () => {
  test("publishes owner-only descriptor and Unix socket, then cleans up idempotently", async () => {
    const { server, controlFile } = await start();
    const descriptor = readBrowserSessionDescriptor(controlFile);

    expect(descriptor.transport.kind).toBe("unix");
    expect(statSync(controlFile).mode & 0o777).toBe(0o600);
    if (descriptor.transport.kind === "unix") {
      expect(statSync(descriptor.transport.address).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(controlFile, "utf8")).not.toContain("Fixture");

    await server.cleanup();
    await server.cleanup();
    expect(existsSync(controlFile)).toBe(false);
    if (descriptor.transport.kind === "unix")
      expect(existsSync(descriptor.transport.address)).toBe(false);
  });

  test("constructs a random local named pipe for Windows without opening TCP", () => {
    const transport = browserSessionTransport("C:\\private\\control.json", "win32");
    expect(transport.kind).toBe("pipe");
    expect(transport.address).toMatch(/^\\\\\.\\pipe\\harnery-browser-/);
    expect(transport.address).not.toContain("://");
  });

  test("refuses insecure parents and stale descriptors", async () => {
    const insecure = mkdtempSync(join(tmpdir(), "harnery-browser-insecure-"));
    chmodSync(insecure, 0o755);
    await expect(
      startBrowserSessionServer(join(insecure, "control.json"), new FakeTarget()),
    ).rejects.toMatchObject({ code: "parent_mode" });

    const dir = privateDir();
    const controlFile = join(dir, "control.json");
    writeFileSync(controlFile, "stale", { mode: 0o600 });
    await expect(startBrowserSessionServer(controlFile, new FakeTarget())).rejects.toMatchObject({
      code: "descriptor_exists",
    });
  });
});

describe("browser session control protocol", () => {
  test("authenticates requests without exposing the token", async () => {
    const { controlFile } = await start();
    const descriptor = readBrowserSessionDescriptor(controlFile);
    const request: BrowserSessionRequest = {
      version: BROWSER_SESSION_PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      token: `${descriptor.token.slice(0, -1)}x`,
      action: "status",
      args: {},
    };
    const response = await sendRequestToDescriptor(descriptor, request);
    expect(response).toMatchObject({ ok: false, error: { code: "auth_failed" } });
    expect(JSON.stringify(response)).not.toContain(descriptor.token);

    const status = await sendBrowserSessionRequest(controlFile, "status", {});
    expect(status).toMatchObject({ phase: "ready", tab_count: 1 });
  });

  test("serializes concurrent actions even when separate clients connect", async () => {
    const target = new FakeTarget();
    target.actionDelayMs = 40;
    const { controlFile } = await start(target);
    const locator = { kind: "text", value: "Run", partial: false } as const;
    await Promise.all([
      sendBrowserSessionRequest(controlFile, "click", { locator }),
      sendBrowserSessionRequest(controlFile, "click", { locator }),
      sendBrowserSessionRequest(controlFile, "press", { key: "Enter" }),
    ]);
    expect(target.maxActiveActions).toBe(1);
    expect(target.revision).toBe(3);
  });

  test("keeps timed-out actions in the serialization queue until they settle", async () => {
    const target = new FakeTarget();
    target.actionDelayMs = 80;
    const { controlFile } = await start(target, { actionTimeoutMs: 20 });
    const locator = { kind: "text", value: "Run", partial: false } as const;

    await expect(
      sendBrowserSessionRequest(controlFile, "click", { locator }),
    ).rejects.toMatchObject({
      code: "action_timeout",
    });
    target.actionDelayMs = 0;
    await expect(
      sendBrowserSessionRequest(controlFile, "press", { key: "Enter" }),
    ).rejects.toMatchObject({
      code: "action_timeout",
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(target.maxActiveActions).toBe(1);
    expect(target.revision).toBe(2);
  });

  test("client disconnect and malformed frames do not close the session", async () => {
    const { controlFile } = await start();
    const descriptor = readBrowserSessionDescriptor(controlFile);
    const partial = createConnection(descriptor.transport.address);
    await new Promise<void>((resolve) => partial.once("connect", resolve));
    partial.write('{"version":1');
    partial.destroy();

    const malformed = await rawFrame(descriptor, "{bad}\n");
    expect(malformed).toMatchObject({ ok: false, error: { code: "malformed_json" } });
    const status = await sendBrowserSessionRequest(controlFile, "status", {});
    expect(status).toMatchObject({ phase: "ready" });
  });

  test("idle connections and stuck actions cannot block bounded cleanup", async () => {
    const idle = await start();
    const idleDescriptor = readBrowserSessionDescriptor(idle.controlFile);
    const socket = createConnection(idleDescriptor.transport.address);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    await expect(idle.server.cleanup()).resolves.toBeUndefined();
    expect(existsSync(idle.controlFile)).toBe(false);

    const target = new FakeTarget();
    target.neverSettle = true;
    const stuck = await start(target, { actionTimeoutMs: 20 });
    const locator = { kind: "text", value: "Run", partial: false } as const;
    await expect(
      sendBrowserSessionRequest(stuck.controlFile, "click", { locator }),
    ).rejects.toMatchObject({ code: "action_timeout" });
    const started = Date.now();
    await stuck.server.cleanup();
    expect(Date.now() - started).toBeLessThan(250);
    expect(existsSync(stuck.controlFile)).toBe(false);
  });

  test("rejects oversized frames without accepting a follow-up action", async () => {
    const { controlFile } = await start();
    const descriptor = readBrowserSessionDescriptor(controlFile);
    const response = await rawFrame(
      descriptor,
      `${"x".repeat(BROWSER_SESSION_MAX_FRAME_BYTES + 1)}\n`,
    );
    expect(response).toMatchObject({ ok: false, error: { code: "frame_too_large" } });
    expect(await sendBrowserSessionRequest(controlFile, "status", {})).toMatchObject({
      phase: "ready",
    });
  });

  test("fill value travels only in the authenticated frame", async () => {
    const secret = "fixture-secret-never-print";
    const { target, controlFile } = await start();
    const response = await sendBrowserSessionRequest(controlFile, "fill", {
      locator: { kind: "label", value: "Password", partial: false },
      value: secret,
    });
    expect(response).toMatchObject({ revision: 1 });
    expect(target.filled).toBe(secret);
    expect(readFileSync(controlFile, "utf8")).not.toContain(secret);
    expect(JSON.stringify(response)).not.toContain(secret);
  });

  test("close resolves the lifecycle signal but a dropped client does not", async () => {
    const { server, controlFile } = await start();
    let closed = false;
    server.closeRequested.then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);

    expect(await sendBrowserSessionRequest(controlFile, "close", {})).toEqual({ closing: true });
    await server.closeRequested;
    expect(closed).toBe(true);
  });
});

async function rawFrame(
  descriptor: BrowserSessionDescriptor,
  frame: string,
): Promise<Record<string, unknown>> {
  const socket = createConnection(descriptor.transport.address);
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(frame);
  const chunks: Buffer[] = [];
  for await (const chunk of socket) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new BrowserSessionError("empty_response", "Expected a server response.");
  return JSON.parse(text);
}
