import { describe, expect, test } from "bun:test";
import type { EventRow, EventsResponse } from "./coord-reader";
import { createEventsStreamResponse, startEventPolling } from "./events-stream";

function result(...ids: string[]): EventsResponse {
  return {
    rows: ids.map((event_id) => ({ event_id }) as EventRow),
    meta: { path: "fixture", total_lines: ids.length, returned: ids.length },
  };
}

function deferred() {
  let resolve!: (value: EventsResponse) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<EventsResponse>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function harness() {
  const controller = new AbortController();
  const messages: Array<{ event: string; data: unknown }> = [];
  const reads: ReturnType<typeof deferred>[] = [];
  const jobs = new Map<number, () => void>();
  let nextJob = 0;
  const stop = startEventPolling({
    signal: controller.signal,
    initialLines: 2,
    read: () => {
      const read = deferred();
      reads.push(read);
      return read.promise;
    },
    send: (event, data) => messages.push({ event, data }),
    setTimeout: ((callback: () => void) => {
      jobs.set(++nextJob, callback);
      return nextJob;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => jobs.delete(id)) as unknown as typeof clearTimeout,
  });
  const tick = () => {
    const pending = [...jobs.values()];
    jobs.clear();
    for (const callback of pending) callback();
  };
  return { controller, messages, reads, jobs, tick, stop };
}

describe("asynchronous event polling", () => {
  test("serializes slow initial and subsequent reads and preserves event ordering", async () => {
    const h = harness();
    try {
      h.tick();
      h.tick();
      expect(h.reads).toHaveLength(1);
      expect(h.jobs.size).toBe(0);
      h.reads[0].resolve(result("c", "b", "a"));
      await Promise.resolve();
      expect(h.messages.map((m) => m.event)).toEqual(["snapshot", "ready"]);
      expect(h.messages[0].data).toEqual({ events: [{ event_id: "c" }, { event_id: "b" }] });
      expect(h.jobs.size).toBe(1);
      h.tick();
      h.tick();
      expect(h.reads).toHaveLength(2);
      h.reads[1].resolve(result("e", "d", "c", "b", "a"));
      await Promise.resolve();
      expect(h.messages.slice(2)).toEqual([
        { event: "event", data: { event_id: "d" } },
        { event: "event", data: { event_id: "e" } },
      ]);
    } finally {
      h.stop();
    }
  });

  test("reports initial failure honestly and sends a snapshot after recovery", async () => {
    const h = harness();
    try {
      h.reads[0].reject(new Error("worker unavailable"));
      await Promise.resolve();
      expect(h.messages.map((m) => m.event)).toEqual(["stale", "ready"]);
      expect(h.messages[0].data).toEqual({ reason: "v3_ledger_read_failed" });
      h.tick();
      h.reads[1].resolve(result("b", "a"));
      await Promise.resolve();
      expect(h.messages.map((m) => m.event)).toEqual(["stale", "ready", "snapshot"]);
      h.tick();
      h.reads[2].reject(new Error("worker restarted"));
      await Promise.resolve();
      h.tick();
      h.reads[3].resolve(result("c", "b", "a"));
      await Promise.resolve();
      expect(h.messages.slice(3)).toEqual([
        { event: "stale", data: { reason: "v3_ledger_read_failed" } },
        { event: "event", data: { event_id: "c" } },
      ]);
    } finally {
      h.stop();
    }
  });

  test("aborting an in-flight read suppresses late output and further polling", async () => {
    const h = harness();
    h.controller.abort();
    h.reads[0].resolve(result("a"));
    await Promise.resolve();
    h.tick();
    expect(h.messages).toEqual([]);
    expect(h.reads).toHaveLength(1);
    expect(h.jobs.size).toBe(0);
  });

  test("aborting between reads cancels the pending timer", async () => {
    const h = harness();
    h.reads[0].resolve(result());
    await Promise.resolve();
    expect(h.jobs.size).toBe(1);
    h.controller.abort();
    expect(h.jobs.size).toBe(0);
    h.tick();
    expect(h.reads).toHaveLength(1);
  });
});

describe("event stream lifetime", () => {
  test("reader cancellation aborts its worker subscription", async () => {
    const pending = deferred();
    let signal: AbortSignal | undefined;
    const response = createEventsStreamResponse(new Request("http://localhost/events"), 2, (s) => {
      signal = s;
      return pending.promise;
    });
    const reader = response.body!.getReader();
    await reader.cancel();
    expect(signal?.aborted).toBe(true);
    pending.resolve(result("a"));
    await Promise.resolve();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  test("request abort closes the response and aborts the active read", async () => {
    const pending = deferred();
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const response = createEventsStreamResponse(
      new Request("http://localhost/events", { signal: controller.signal }),
      2,
      (s) => {
        signal = s;
        return pending.promise;
      },
    );
    const next = response.body!.getReader().read();
    controller.abort();
    expect(signal?.aborted).toBe(true);
    expect(await next).toEqual({ done: true, value: undefined });
    pending.reject(new Error("aborted"));
    await Promise.resolve();
  });

  test("an already aborted request never starts a read", async () => {
    const controller = new AbortController();
    controller.abort();
    let reads = 0;
    const response = createEventsStreamResponse(
      new Request("http://localhost/events", { signal: controller.signal }),
      2,
      async () => {
        reads++;
        return result();
      },
    );
    expect(await response.text()).toBe("");
    expect(reads).toBe(0);
  });
});
