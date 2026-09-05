import { expect, test } from "bun:test";
import { createThumbnailScheduler, loadThumbnail } from "./thumbnail-loader";

test("the shared scheduler starts at most four requests and cancels queued work", async () => {
  const schedule = createThumbnailScheduler();
  const controller = new AbortController();
  const releases: Array<() => void> = [];
  let running = 0;
  let peak = 0;
  let started = 0;
  const work = () =>
    new Promise<number>((resolve) => {
      started += 1;
      running += 1;
      peak = Math.max(peak, running);
      releases.push(() => {
        running -= 1;
        resolve(started);
      });
    });
  const requests = Array.from({ length: 4 }, () => schedule(work, controller.signal));
  const canceled = new AbortController();
  const fifth = schedule(work, canceled.signal).catch(() => "canceled");
  await Promise.resolve();
  expect(started).toBe(4);
  canceled.abort();
  for (const release of releases) release();
  await Promise.all(requests);
  expect(await fifth).toBe("canceled");
  expect(peak).toBe(4);
  expect(started).toBe(4);
});

test("a failed request releases its slot to the next thumbnail", async () => {
  const schedule = createThumbnailScheduler(1);
  const controller = new AbortController();
  const first = schedule(async () => {
    throw new Error("failed");
  }, controller.signal).catch(() => null);
  const second = schedule(async () => "next", controller.signal);
  expect(await first).toBeNull();
  expect(await second).toBe("next");
});

test("busy queues and pending conversion retry within the budget", async () => {
  const urls: string[] = [];
  const request = (async (url: string) => {
    urls.push(url);
    return urls.length <= 2
      ? new Response('{"status":"queued"}', {
          status: urls.length === 1 ? 503 : 202,
          headers: { "Retry-After": "0" },
        })
      : new Response("image bytes", { headers: { "Content-Type": "image/webp" } });
  }) as unknown as typeof fetch;
  const blob = await loadThumbnail(
    "reports/a b.json",
    "changed",
    new AbortController().signal,
    Date.now() + 2000,
    request,
  );
  expect(await blob?.text()).toBe("image bytes");
  expect(urls).toHaveLength(3);
  expect(urls[0]).toBe("/api/file/thumbnail?path=reports%2Fa%20b.json&v=changed");
});

test("unsupported content does not retry and expired budgets never request", async () => {
  let calls = 0;
  const request = (async () => {
    calls += 1;
    return new Response("unsupported", { status: 415 });
  }) as unknown as typeof fetch;
  const signal = new AbortController().signal;
  expect(await loadThumbnail("file.bin", "", signal, Date.now() + 1000, request)).toBeNull();
  expect(await loadThumbnail("file.bin", "", signal, Date.now() - 1, request)).toBeNull();
  expect(calls).toBe(1);
});

test("pending work stops when the viewport consumer aborts", async () => {
  const controller = new AbortController();
  let calls = 0;
  const request = (async () => {
    calls += 1;
    queueMicrotask(() => controller.abort());
    return new Response("pending", { status: 202 });
  }) as unknown as typeof fetch;
  await expect(
    loadThumbnail("file.txt", "", controller.signal, Date.now() + 1000, request),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

test("a conversion retry cannot extend the original deadline", async () => {
  let calls = 0;
  const request = (async () => {
    calls += 1;
    return new Response("pending", { status: 202 });
  }) as unknown as typeof fetch;
  expect(
    await loadThumbnail("file.pdf", "", new AbortController().signal, Date.now() + 100, request),
  ).toBeNull();
  expect(calls).toBe(1);
});
