import { describe, expect, test } from "bun:test";
import type { FetchResult } from "./client";
import { createPreviewCache } from "./preview-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const ok = (data: string): FetchResult<string> => ({ ok: true, data });

function controlled() {
  const requests: {
    path: string;
    signal: AbortSignal;
    reply: ReturnType<typeof deferred<FetchResult<string>>>;
  }[] = [];
  const cache = createPreviewCache<string>({
    load: (path, signal) => {
      const reply = deferred<FetchResult<string>>();
      requests.push({ path, signal, reply });
      return reply.promise;
    },
  });
  return { cache, requests };
}

describe("preview requests", () => {
  test("selecting another file cancels the previous result even when transport ignores abort", async () => {
    const { cache, requests } = controlled();
    const first = new AbortController();
    const old = cache.get("old.md", first.signal);
    await Promise.resolve();
    first.abort();
    const current = cache.get("current.md");
    await Promise.resolve();
    expect(requests[0].signal.aborted).toBe(true);
    requests[1].reply.resolve(ok("current body"));
    expect(await current).toEqual(ok("current body"));
    requests[0].reply.resolve(ok("obsolete body"));
    expect(await old).toMatchObject({ ok: false, code: "aborted" });
    expect(await cache.get("current.md")).toEqual(ok("current body"));
    const reopened = cache.get("old.md");
    await Promise.resolve();
    expect(requests).toHaveLength(3);
    requests[2].reply.resolve(ok("updated old body"));
    expect(await reopened).toEqual(ok("updated old body"));
  });

  test("concurrent readers share a request without sharing cancellation", async () => {
    const { cache, requests } = controlled();
    const one = new AbortController();
    const first = cache.get("same.md", one.signal);
    const second = cache.get("same.md");
    await Promise.resolve();
    one.abort();
    expect(requests).toHaveLength(1);
    expect(requests[0].signal.aborted).toBe(false);
    requests[0].reply.resolve(ok("body"));
    expect(await first).toMatchObject({ code: "aborted" });
    expect(await second).toEqual(ok("body"));
  });

  test("refresh detaches pending generation so its late response cannot replace refreshed cache", async () => {
    const { cache, requests } = controlled();
    const old = cache.get("same.md");
    await Promise.resolve();
    cache.invalidate("same.md");
    const refreshed = cache.get("same.md");
    await Promise.resolve();
    requests[1].reply.resolve(ok("new"));
    expect(await refreshed).toEqual(ok("new"));
    requests[0].reply.resolve(ok("old"));
    await old;
    expect(await cache.get("same.md")).toEqual(ok("new"));
  });

  test("errors are retried, and already aborted callers never start transport", async () => {
    let calls = 0;
    const cache = createPreviewCache<string>({
      load: async () => {
        calls++;
        return { ok: false, status: 500, code: "transport", detail: null };
      },
    });
    await cache.get("a");
    await cache.get("a");
    expect(calls).toBe(2);
    const controller = new AbortController();
    controller.abort();
    expect(await cache.get("b", controller.signal)).toMatchObject({ code: "aborted" });
    expect(calls).toBe(2);
  });

  test("responses expire and explicit invalidation refreshes before expiry", async () => {
    let clock = 0;
    let calls = 0;
    const cache = createPreviewCache<string>({
      now: () => clock,
      ttlMs: 10,
      load: async () => ok(String(++calls)),
    });
    expect(await cache.get("a")).toEqual(ok("1"));
    clock = 9;
    expect(await cache.get("a")).toEqual(ok("1"));
    clock = 10;
    expect(await cache.get("a")).toEqual(ok("2"));
    cache.invalidate("a");
    expect(await cache.get("a")).toEqual(ok("3"));
  });

  test("evicts least recently read paths at the entry limit", async () => {
    const counts = new Map<string, number>();
    const cache = createPreviewCache<string>({
      maxEntries: 2,
      load: async (path) => {
        counts.set(path, (counts.get(path) ?? 0) + 1);
        return ok(path);
      },
    });
    await cache.get("a");
    await cache.get("b");
    await cache.get("a");
    await cache.get("c");
    await cache.get("a");
    expect(counts.get("a")).toBe(1);
    await cache.get("b");
    expect(counts.get("b")).toBe(2);
  });

  test("bounds retained content weight and does not cache oversized responses", async () => {
    let calls = 0;
    const cache = createPreviewCache<string>({
      maxWeight: 5,
      weight: (body) => body.length,
      load: async (path) => {
        calls++;
        return ok(path);
      },
    });
    await cache.get("aaa");
    await cache.get("bbb");
    await cache.get("aaa");
    expect(calls).toBe(3);
    await cache.get("too large");
    await cache.get("too large");
    expect(calls).toBe(5);
    await cache.get("aaa");
    expect(calls).toBe(5);
  });
});
