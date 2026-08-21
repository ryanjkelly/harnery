import { describe, expect, test } from "bun:test";

import {
  createLiveSignalController,
  type LiveSignalControllerDeps,
  type LiveSignalEvent,
  type LiveSignalSource,
} from "./live-signal-controller";

class Source implements LiveSignalSource {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  listeners = new Map<string, Array<(event: LiveSignalEvent) => void>>();
  addEventListener(name: string, handler: (event: LiveSignalEvent) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]);
  }
  emit(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener({ type: name });
  }
  close(): void {
    this.closed = true;
  }
}

class Scheduler {
  now = 0;
  next = 1;
  jobs = new Map<number, { at: number; every?: number; callback: () => void }>();
  setTimeout = (callback: () => void, ms: number): number => {
    const id = this.next++;
    this.jobs.set(id, { at: this.now + ms, callback });
    return id;
  };
  setInterval = (callback: () => void, ms: number): number => {
    const id = this.next++;
    this.jobs.set(id, { at: this.now + ms, every: ms, callback });
    return id;
  };
  clear = (handle: unknown): void => {
    this.jobs.delete(handle as number);
  };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.jobs.entries()]
        .filter(([, job]) => job.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, job] = due;
      this.now = job.at;
      if (job.every) job.at += job.every;
      else this.jobs.delete(id);
      job.callback();
    }
    this.now = end;
  }
}

function harness(initialVisibility: "hidden" | "visible" = "visible") {
  const scheduler = new Scheduler();
  const sources: Source[] = [];
  const versions: string[] = [];
  let visibility = initialVisibility;
  let visibilityHandler: (() => void) | undefined;
  const deps: LiveSignalControllerDeps = {
    createSource: () => {
      const source = new Source();
      sources.push(source);
      return source;
    },
    fetchVersion: async () => versions.shift(),
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clear,
    setInterval: scheduler.setInterval,
    clearInterval: scheduler.clear,
    visibility: () => visibility,
    onVisibilityChange: (handler) => {
      visibilityHandler = handler;
      return () => {
        visibilityHandler = undefined;
      };
    },
  };
  return {
    deps,
    scheduler,
    sources,
    versions,
    setVisibility(next: "hidden" | "visible") {
      visibility = next;
      visibilityHandler?.();
    },
  };
}

function options(statuses: string[], changes: string[]) {
  return {
    streamUrl: "/api/live",
    versionUrl: "/api/version",
    watchdogMs: 5_000,
    staleMs: 60_000,
    pollMs: 5_000,
    maxRetries: 2,
    enabled: true,
    fetchOnFallbackStart: false,
    eventNames: () => ["ready", "change"],
    onEvent: (name: string) => changes.push(name),
    onFallbackChange: () => changes.push("fallback"),
    onStatus: (status: string) => statuses.push(status),
  };
}

describe("live signal controller", () => {
  test("a local SSE event marks the transport live and avoids polling", () => {
    const h = harness();
    const statuses: string[] = [];
    const changes: string[] = [];
    const controller = createLiveSignalController(options(statuses, changes), h.deps);
    controller.start();
    h.sources[0]?.onopen?.(new Event("open"));
    h.sources[0]?.emit("ready");
    h.scheduler.advance(5_000);
    expect(statuses).toEqual(["live"]);
    expect(changes).toEqual(["ready"]);
    expect(h.sources[0]?.closed).toBe(false);
    controller.stop();
  });

  test("a silent open stream falls back to version polling", async () => {
    const h = harness();
    h.versions.push("one", "two");
    const statuses: string[] = [];
    const changes: string[] = [];
    const controller = createLiveSignalController(options(statuses, changes), h.deps);
    controller.start();
    h.sources[0]?.onopen?.(new Event("open"));
    h.scheduler.advance(5_000);
    await Promise.resolve();
    expect(statuses.at(-1)).toBe("polling");
    expect(h.sources[0]?.closed).toBe(true);
    h.scheduler.advance(5_000);
    await Promise.resolve();
    expect(changes).toEqual(["fallback"]);
    controller.stop();
  });

  test("retry exhaustion enters polling fallback", () => {
    const h = harness();
    const statuses: string[] = [];
    const controller = createLiveSignalController(options(statuses, []), h.deps);
    controller.start();
    h.sources[0]?.onerror?.(new Event("error"));
    h.scheduler.advance(2_000);
    h.sources[1]?.onerror?.(new Event("error"));
    expect(statuses.at(-1)).toBe("polling");
    controller.stop();
  });

  test("hidden tabs release the stream and reconnect when visible", () => {
    const h = harness("hidden");
    const statuses: string[] = [];
    const controller = createLiveSignalController(options(statuses, []), h.deps);
    controller.start();
    expect(h.sources).toHaveLength(0);
    h.setVisibility("visible");
    expect(h.sources).toHaveLength(1);
    h.setVisibility("hidden");
    expect(h.sources[0]?.closed).toBe(true);
    controller.stop();
  });
});
