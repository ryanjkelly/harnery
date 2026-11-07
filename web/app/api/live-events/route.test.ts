import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";

const calls: number[] = [];
let release: (() => void) | null = null;

// mock.module is process-wide: keep every real export and restore them after
// this file so later test files in the same process see the real module.
const real = { ...(await import("@/lib/session-events")) };
afterAll(() => {
  mock.module("@/lib/session-events", () => real);
});

mock.module("@/lib/session-events", () => ({
  ...real,
  readSessionEventsTail: async ({ lines }: { lines: number }) => {
    calls.push(lines);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return [];
  },
}));

const { GET } = await import("./route");
const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  calls.length = 0;
  release = null;
});

describe("/api/live-events lifetime", () => {
  test("an abort during the initial read starts no timers and caps ?initial=", async () => {
    const controller = new AbortController();
    const setTimer = spyOn(globalThis, "setInterval");
    spies.push(setTimer);
    const response = await GET(
      new Request("http://localhost/api/live-events?initial=999999", {
        signal: controller.signal,
      }),
    );
    const reader = response.body!.getReader();
    const done = reader.read();
    await Promise.resolve();
    expect(calls).toEqual([5000]);

    controller.abort();
    release?.();
    expect((await done).done).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setTimer).not.toHaveBeenCalled();
  });

  test("an already-aborted request reads nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await GET(
      new Request("http://localhost/api/live-events", { signal: controller.signal }),
    );
    expect((await response.body!.getReader().read()).done).toBe(true);
    expect(calls).toEqual([]);
  });
});
