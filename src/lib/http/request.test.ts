import { afterEach, describe, expect, test } from "bun:test";
import { backoffDelayMs, requestWithRetries } from "./request.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handlers: Array<() => Response | Error>): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    const handler = handlers[Math.min(calls, handlers.length - 1)];
    calls++;
    if (!handler) throw new Error("mockFetch: no handler");
    const out = handler();
    if (out instanceof Error) throw out;
    return out;
  }) as unknown as typeof fetch;
  return () => calls;
}

const instantDelay = () => 0;

describe("requestWithRetries", () => {
  test("returns ok response with text + headers", async () => {
    mockFetch([() => new Response('{"a":1}', { status: 200, headers: { "x-y": "z" } })]);
    const r = await requestWithRetries("https://api.example.com/x");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.text).toBe('{"a":1}');
    expect(r.headers.get("x-y")).toBe("z");
  });

  test("retries 429 then succeeds; onResponse sees every attempt", async () => {
    const calls = mockFetch([
      () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
      () => new Response("ok", { status: 200 }),
    ]);
    const seen: number[] = [];
    const r = await requestWithRetries("https://api.example.com/x", {
      delayMs: instantDelay,
      onResponse: ({ status }) => seen.push(status),
    });
    expect(r.ok).toBe(true);
    expect(calls()).toBe(2);
    expect(seen).toEqual([429, 200]);
  });

  test("retries 5xx up to maxRetries, then returns the terminal response (no throw)", async () => {
    const calls = mockFetch([() => new Response("boom", { status: 503 })]);
    const r = await requestWithRetries("https://api.example.com/x", {
      maxRetries: 2,
      delayMs: instantDelay,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
    expect(r.text).toBe("boom");
    expect(calls()).toBe(3); // 1 + 2 retries
  });

  test("does NOT retry a 400; returns ok:false for the caller's error taxonomy", async () => {
    const calls = mockFetch([() => new Response("bad", { status: 400 })]);
    const r = await requestWithRetries("https://api.example.com/x", { delayMs: instantDelay });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(calls()).toBe(1);
  });

  test("network failure retries then throws via the networkError factory", async () => {
    class VendorError extends Error {}
    const calls = mockFetch([() => new Error("ECONNRESET")]);
    await expect(
      requestWithRetries("https://api.example.com/x", {
        maxRetries: 1,
        delayMs: instantDelay,
        networkError: (msg) => new VendorError(`wrapped: ${msg}`),
      }),
    ).rejects.toThrow(VendorError);
    expect(calls()).toBe(2);
  });

  test("JSON body gets Content-Type default; explicit content-type wins", async () => {
    let captured: Record<string, string> = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured = { ...(init?.headers as Record<string, string>) };
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    await requestWithRetries("https://api.example.com/x", { method: "POST", body: { a: 1 } });
    expect(captured["Content-Type"]).toBe("application/json");
    await requestWithRetries("https://api.example.com/x", {
      method: "POST",
      body: { a: 1 },
      headers: { "content-type": "application/vnd.api+json" },
    });
    expect(captured["content-type"]).toBe("application/vnd.api+json");
    expect(captured["Content-Type"]).toBeUndefined();
  });
});

describe("backoffDelayMs", () => {
  test("honors a sane Retry-After and ignores an insane one", () => {
    const sane = backoffDelayMs(0, 2);
    expect(sane).toBeGreaterThanOrEqual(2000);
    expect(sane).toBeLessThan(2250 + 1);
    const insane = backoffDelayMs(0, 3600);
    expect(insane).toBeLessThan(1000); // falls back to 500ms curve + jitter
  });

  test("caps the curve at 30s", () => {
    expect(backoffDelayMs(20)).toBeLessThan(30_250 + 1);
  });
});
