import { describe, expect, test } from "bun:test";

import {
  createLiveRefreshScheduler,
  HEAVY_REFRESH_INTERVAL_MS,
  LIGHT_REFRESH_INTERVAL_MS,
  liveRefreshIntervalMs,
} from "./live-refresh-scheduler";

class Clock {
  now = 0;
  next = 1;
  jobs = new Map<number, { at: number; callback: () => void }>();

  setTimeout = (callback: () => void, ms: number): number => {
    const id = this.next++;
    this.jobs.set(id, { at: this.now + ms, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.jobs.delete(handle as number);
  };

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.jobs.entries()]
        .filter(([, job]) => job.at <= end)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      const [id, job] = due;
      this.jobs.delete(id);
      this.now = job.at;
      job.callback();
    }
    this.now = end;
  }
}

describe("live refresh route policy", () => {
  test("complete-ledger pages use the wide refresh window", () => {
    expect(liveRefreshIntervalMs("/")).toBe(HEAVY_REFRESH_INTERVAL_MS);
    expect(liveRefreshIntervalMs("/agents/inst_123")).toBe(HEAVY_REFRESH_INTERVAL_MS);
    expect(liveRefreshIntervalMs("/workflows/run-1")).toBe(HEAVY_REFRESH_INTERVAL_MS);
  });

  test("self-live pages never request a global server render", () => {
    expect(liveRefreshIntervalMs("/browse")).toBeNull();
    expect(liveRefreshIntervalMs("/images")).toBeNull();
    expect(liveRefreshIntervalMs("/codec/review")).toBeNull();
    expect(liveRefreshIntervalMs("/diagnostics")).toBeNull();
    expect(liveRefreshIntervalMs("/diagnostics/bundles/bundle_123")).toBeNull();
    expect(liveRefreshIntervalMs("/live")).toBeNull();
  });

  test("lightweight pages keep a shorter coalescing window", () => {
    expect(liveRefreshIntervalMs("/files/view")).toBe(LIGHT_REFRESH_INTERVAL_MS);
  });
});

describe("live refresh scheduler", () => {
  test("coalesces a burst into one trailing refresh", () => {
    const clock = new Clock();
    let refreshes = 0;
    const scheduler = createLiveRefreshScheduler(() => refreshes++, 120_000, {
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    for (let index = 0; index < 1_000; index++) scheduler.request();
    clock.advance(119_999);
    expect(refreshes).toBe(0);
    clock.advance(1);
    expect(refreshes).toBe(1);
  });

  test("bounds a continuous event storm to one refresh per window", () => {
    const clock = new Clock();
    let refreshes = 0;
    const scheduler = createLiveRefreshScheduler(() => refreshes++, 120_000, {
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    for (let second = 0; second < 600; second++) {
      scheduler.request();
      clock.advance(1_000);
    }
    expect(refreshes).toBe(5);
  });

  test("refreshes immediately after an idle window", () => {
    const clock = new Clock();
    let refreshes = 0;
    const scheduler = createLiveRefreshScheduler(() => refreshes++, 30_000, {
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    clock.advance(30_000);
    scheduler.request();
    expect(refreshes).toBe(1);
  });

  test("cancellation drops a queued refresh", () => {
    const clock = new Clock();
    let refreshes = 0;
    const scheduler = createLiveRefreshScheduler(() => refreshes++, 30_000, {
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    scheduler.request();
    scheduler.cancel();
    clock.advance(30_000);
    expect(refreshes).toBe(0);
  });
});
