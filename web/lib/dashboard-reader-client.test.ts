import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { DashboardReaderClient, type ReaderWorker } from "./dashboard-reader-client";
import type { DashboardRequest, DashboardResponse } from "./dashboard-reader-protocol";
import type { PaletteCatalog } from "./palette/catalog";

class FakeWorker extends EventEmitter {
  requests: DashboardRequest[] = [];
  terminated = false;
  postMessage(request: DashboardRequest) {
    this.requests.push(request);
  }
  ref() {}
  unref() {}
  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }
  respond(response: DashboardResponse) {
    this.emit("message", response);
  }
}

const clients: DashboardReaderClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});
const catalog: PaletteCatalog = {
  agents: [],
  councils: [],
  decisions: [],
  work: [],
  workflows: [],
  goals: [],
};

function fixture(options: ConstructorParameters<typeof DashboardReaderClient>[1] = {}) {
  const workers: FakeWorker[] = [];
  const client = new DashboardReaderClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as ReaderWorker;
  }, options);
  clients.push(client);
  return { client, workers };
}

test("starts lazily and coalesces simultaneous catalog requests", async () => {
  const { client, workers } = fixture();
  expect(workers).toHaveLength(0);
  const first = client.read("palette");
  const second = client.read("palette");
  expect(first).toBe(second);
  expect(workers).toHaveLength(1);
  expect(workers[0].requests).toHaveLength(1);
  workers[0].respond({ id: workers[0].requests[0].id, ok: true, value: catalog });
  expect(await first).toEqual(catalog);
  expect(await second).toEqual(catalog);
});

test("catalog freshness starts at completion and expires without serving a false empty result", async () => {
  let now = 0;
  const { client, workers } = fixture({ now: () => now, paletteTtlMs: 10 });
  const first = client.read("palette");
  now = 100;
  workers[0].respond({ id: 1, ok: true, value: catalog });
  await first;
  now = 109;
  expect(await client.read("palette")).toBe(catalog);
  expect(workers[0].requests).toHaveLength(1);
  now = 110;
  const expired = client.read("palette");
  workers[0].respond({ id: 2, ok: false, error: "read_failed" });
  await expect(expired).rejects.toThrow("read_failed");
  const retry = client.read("palette");
  workers[0].respond({ id: 3, ok: true, value: catalog });
  expect(await retry).toEqual(catalog);
});

test("worker crash rejects all queued reads and the next request starts a fresh worker", async () => {
  const { client, workers } = fixture();
  const first = client.read("palette");
  const second = client.read("agents");
  const failures = Promise.all([first.catch((error) => error), second.catch((error) => error)]);
  workers[0].emit("error", new Error("crashed"));
  for (const error of await failures) expect(error.message).toContain("unavailable");
  expect(workers[0].terminated).toBe(true);
  const retry = client.read("palette");
  expect(workers).toHaveLength(2);
  workers[0].respond({ id: 3, ok: false, error: "late_old_worker_message" });
  workers[1].respond({ id: 3, ok: true, value: catalog });
  expect(await retry).toEqual(catalog);
});

test("a timeout terminates a stuck worker and permits recovery", async () => {
  const { client, workers } = fixture({ timeoutMs: 15 });
  await expect(client.read("palette")).rejects.toThrow("timeout");
  expect(workers[0].terminated).toBe(true);
  const retry = client.read("palette");
  workers[1].respond({ id: 2, ok: true, value: catalog });
  expect(await retry).toEqual(catalog);
});

test("bounds distinct pending work while allowing existing subscribers to join", async () => {
  const { client, workers } = fixture({ maxPending: 1 });
  const first = client.read("palette");
  expect(client.read("palette")).toBe(first);
  await expect(client.read("agents")).rejects.toThrow("busy");
  expect(workers[0].requests).toHaveLength(1);
  workers[0].respond({ id: 1, ok: true, value: catalog });
  await first;
});

test("aborting one subscriber preserves a read needed by another", async () => {
  const { client, workers } = fixture();
  const abort = new AbortController();
  const first = client.read("palette", undefined, { signal: abort.signal });
  const second = client.read("palette");
  abort.abort();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  expect(workers[0].terminated).toBe(false);
  workers[0].respond({ id: 1, ok: true, value: catalog });
  expect(await second).toEqual(catalog);
  await expect(client.read("palette", undefined, { signal: abort.signal })).rejects.toMatchObject({
    name: "AbortError",
  });
});

test("idle workers are retired and recreated on demand", async () => {
  const { client, workers } = fixture({ idleMs: 5, paletteTtlMs: 0 });
  const first = client.read("palette");
  workers[0].respond({ id: 1, ok: true, value: catalog });
  await first;
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(workers[0].terminated).toBe(true);
  const second = client.read("palette");
  expect(workers).toHaveLength(2);
  workers[1].respond({ id: 2, ok: true, value: catalog });
  await second;
});
