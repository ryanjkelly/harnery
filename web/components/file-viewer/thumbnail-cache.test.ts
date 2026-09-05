import { expect, test } from "bun:test";
import { createThumbnailCache } from "./thumbnail-cache";

function setup(options: { maxEntries?: number; maxBytes?: number; ttlMs?: number } = {}) {
  let now = 0;
  let loads = 0;
  let decodes = 0;
  const disposed: string[] = [];
  const cache = createThumbnailCache({
    ...options,
    now: () => now,
    load: async () => {
      loads++;
      return new Blob(["image"]);
    },
    decode: async () => {
      const url = `blob:${++decodes}`;
      return { url, bytes: 10, dispose: () => disposed.push(url) };
    },
  });
  const acquire = (path = "a", version = "1", scope = "origin") =>
    cache.acquire(scope, path, version, 30_000);
  return {
    cache,
    acquire,
    disposed,
    loads: () => loads,
    decodes: () => decodes,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("Back and repeated scroll reuse the same decoded object without another request", async () => {
  const state = setup();
  const first = state.acquire();
  const image = await first.ready;
  first.release();
  const second = state.acquire();
  expect(await second.ready).toBe(image);
  expect(state.loads()).toBe(1);
  expect(state.decodes()).toBe(1);
  second.release();
  state.cache.clear();
  expect(state.disposed).toEqual([image!.url]);
});

test("concurrent cards share loading and one release never revokes another card", async () => {
  const state = setup();
  const first = state.acquire();
  const second = state.acquire();
  first.release();
  expect(await second.ready).not.toBeNull();
  state.cache.clear();
  expect(state.disposed).toEqual([]);
  second.release();
  second.release();
  expect(state.disposed).toEqual(["blob:1"]);
  expect(state.loads()).toBe(1);
});

test("last canceled subscriber aborts in-flight work and does not cache a late decode", async () => {
  let finish!: () => void;
  let signal!: AbortSignal;
  let disposed = 0;
  const cache = createThumbnailCache({
    load: async (_path, _version, abort) => {
      signal = abort;
      return new Blob(["image"]);
    },
    decode: () =>
      new Promise((resolve) => {
        finish = () => resolve({ url: "blob:1", bytes: 1, dispose: () => disposed++ });
      }),
  });
  const lease = cache.acquire("origin", "a", "1", 30_000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  lease.release();
  expect(signal.aborted).toBe(true);
  finish();
  expect(await lease.ready).toBeNull();
  expect(disposed).toBe(1);
  cache.clear();
});

test("source version and project origin changes never reuse old bytes", async () => {
  const state = setup();
  const a = state.acquire();
  await a.ready;
  const b = state.acquire("a", "2");
  await b.ready;
  expect(state.disposed).toEqual([]);
  a.release();
  expect(state.disposed).toEqual(["blob:1"]);
  const c = state.acquire("a", "2", "another-origin");
  await c.ready;
  expect(state.loads()).toBe(3);
  b.release();
  c.release();
  state.cache.clear();
});

test("absolute TTL expires despite recent reuse and does not revoke visible images", async () => {
  const state = setup({ ttlMs: 30_000 });
  const first = state.acquire();
  await first.ready;
  state.advance(29_000);
  const recent = state.acquire();
  await recent.ready;
  recent.release();
  state.advance(1001);
  const expired = state.acquire();
  await expired.ready;
  expect(state.loads()).toBe(2);
  expect(state.disposed).toEqual([]);
  first.release();
  expired.release();
  state.cache.clear();
  expect(state.disposed).toEqual(["blob:1", "blob:2"]);
});

test("entry and decoded-byte limits evict the oldest retained images", async () => {
  for (const limits of [{ maxEntries: 2 }, { maxBytes: 20 }]) {
    const state = setup(limits);
    for (const path of ["a", "b", "c"]) {
      const item = state.acquire(path);
      await item.ready;
      item.release();
    }
    expect(state.disposed).toEqual(["blob:1"]);
    const retained = state.acquire("b");
    await retained.ready;
    retained.release();
    expect(state.loads()).toBe(3);
    state.cache.clear();
  }
});

test("refresh or hidden-tab clear retires pinned entries and clears idle ones", async () => {
  const state = setup();
  const pinned = state.acquire();
  await pinned.ready;
  const idle = state.acquire("b");
  await idle.ready;
  idle.release();
  state.cache.clear();
  expect(state.disposed).toEqual(["blob:2"]);
  const afterRefresh = state.acquire();
  await afterRefresh.ready;
  expect(state.loads()).toBe(3);
  pinned.release();
  afterRefresh.release();
  state.cache.clear();
  expect(state.disposed).toEqual(["blob:2", "blob:1", "blob:3"]);
});

test("denied files and decoder failures are never cached", async () => {
  let calls = 0;
  const cache = createThumbnailCache({
    load: async () => (++calls === 1 ? null : new Blob(["bad"])),
    decode: async () => {
      throw new Error("invalid image");
    },
  });
  const denied = cache.acquire("origin", "a", "1", 30_000);
  expect(await denied.ready).toBeNull();
  denied.release();
  const invalid = cache.acquire("origin", "a", "1", 30_000);
  await expect(invalid.ready).rejects.toThrow("invalid image");
  invalid.release();
  expect(calls).toBe(2);
  cache.clear();
});
