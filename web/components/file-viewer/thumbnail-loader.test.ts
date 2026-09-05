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

test("prefetch occupies only one slot and visible work overtakes queued prefetch", async () => {
  const schedule = createThumbnailScheduler(2);
  const signal = new AbortController().signal;
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const work = (name: string) => () =>
    new Promise<void>((resolve) => {
      started.push(name);
      release.set(name, resolve);
    });
  const first = schedule(work("prefetch 1"), signal, "prefetch");
  const second = schedule(work("prefetch 2"), signal, "prefetch");
  const visible = schedule(work("visible 1"), signal, "visible");
  const nextVisible = schedule(work("visible 2"), signal, "visible");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toEqual(["prefetch 1", "visible 1"]);
  release.get("visible 1")!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toEqual(["prefetch 1", "visible 1", "visible 2"]);
  release.get("prefetch 1")!();
  release.get("visible 2")!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  release.get("prefetch 2")!();
  await Promise.all([first, second, visible, nextVisible]);
});

test("the first pending response immediately switches to completion waiting", async () => {
  const times: number[] = [];
  const request = (async (url: string) => {
    times.push(performance.now());
    if (times.length === 1)
      return new Response("pending", { status: 202, headers: { "Retry-After": "1" } });
    expect(url).toContain("priority=prefetch&wait=1000");
    return new Response("preview", { headers: { "Content-Type": "image/webp" } });
  }) as unknown as typeof fetch;
  const result = await loadThumbnail(
    "notes.md",
    "v1",
    new AbortController().signal,
    Date.now() + 1000,
    request,
    "prefetch",
  );
  expect(await result?.text()).toBe("preview");
  expect(times[1] - times[0]).toBeLessThan(100);
});

test("visible completion overtakes initial requests without giving prefetch precedence", async () => {
  const schedule = createThumbnailScheduler(1);
  const signal = new AbortController().signal;
  let release!: () => void;
  const held = schedule(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    signal,
  );
  const started: string[] = [];
  const initial = schedule(
    async () => {
      started.push("visible initial");
    },
    signal,
    "visible",
  );
  const prefetch = schedule(
    async () => {
      started.push("prefetch completion");
    },
    signal,
    "prefetch",
    true,
  );
  const completed = schedule(
    async () => {
      started.push("visible completion");
    },
    signal,
    "visible",
    true,
  );
  await Promise.resolve();
  release();
  await Promise.all([held, initial, prefetch, completed]);
  expect(started).toEqual(["visible completion", "visible initial", "prefetch completion"]);
});

test("two slow completions leave network capacity for new visible files", async () => {
  const schedule = createThumbnailScheduler();
  const signal = new AbortController().signal;
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const work = (name: string) => () =>
    new Promise<void>((resolve) => {
      started.push(name);
      releases.set(name, resolve);
    });
  const first = schedule(work("completion 1"), signal, "visible", true);
  const second = schedule(work("completion 2"), signal, "visible", true);
  const third = schedule(work("completion 3"), signal, "visible", true);
  const initial = schedule(work("initial"), signal, "visible");
  await Promise.resolve();
  expect(started).toEqual(["completion 1", "completion 2", "initial"]);
  releases.get("initial")!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).not.toContain("completion 3");
  releases.get("completion 1")!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toContain("completion 3");
  releases.get("completion 2")!();
  releases.get("completion 3")!();
  await Promise.all([first, second, third, initial]);
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
  expect(urls[0]).toBe("/api/file/thumbnail?path=reports%2Fa%20b.json&v=changed&priority=visible");
  expect(urls[1]).toEndWith("&wait=1000");
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
    return new Response("pending", { status: 503 });
  }) as unknown as typeof fetch;
  expect(
    await loadThumbnail("file.pdf", "", new AbortController().signal, Date.now() + 100, request),
  ).toBeNull();
  expect(calls).toBe(1);
});
