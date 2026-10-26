import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { CodecScene } from "@/lib/codec/contracts";
import type { CodecSceneConnection, CodecSceneService } from "@/lib/codec/scene-service";

import { GET } from "./route";

const processGlobal = globalThis as typeof globalThis & {
  __harneryCodecSceneServiceV1?: CodecSceneService;
};
const snapshot = { panels: [], generated_at: "2026-08-16T12:00:00.000Z" } as unknown as CodecScene;
let previousService: CodecSceneService | undefined;
const requests: AbortController[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function useConnection(connect: CodecSceneService["connect"]): void {
  processGlobal.__harneryCodecSceneServiceV1 = {
    connect,
    getScene: async () => snapshot,
    refresh: async () => snapshot,
    close() {},
  };
}

function request(): { controller: AbortController; value: Request } {
  const controller = new AbortController();
  requests.push(controller);
  return {
    controller,
    value: new Request("http://localhost/api/codec-stream", { signal: controller.signal }),
  };
}

beforeEach(() => {
  previousService = processGlobal.__harneryCodecSceneServiceV1;
});

afterEach(() => {
  for (const controller of requests.splice(0)) controller.abort();
  for (const spy of spies.splice(0)) spy.mockRestore();
  if (previousService === undefined) delete processGlobal.__harneryCodecSceneServiceV1;
  else processGlobal.__harneryCodecSceneServiceV1 = previousService;
});

describe("Codec stream lifetime", () => {
  test("reader cancellation closes its subscription, heartbeat, and abort listener once", async () => {
    let closes = 0;
    useConnection(async () => ({
      snapshot,
      close: () => {
        closes += 1;
      },
    }));
    const req = request();
    const removeListener = spyOn(req.value.signal, "removeEventListener");
    const clearHeartbeat = spyOn(globalThis, "clearInterval");
    spies.push(removeListener, clearHeartbeat);
    const response = await GET(req.value);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(
      `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
    );

    await reader.cancel();
    req.controller.abort();

    expect(closes).toBe(1);
    expect(clearHeartbeat).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(removeListener.mock.calls[0]?.[0]).toBe("abort");
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  test("cancellation while connecting closes a late subscription without sending a snapshot", async () => {
    const pending = deferred<CodecSceneConnection>();
    const closed = deferred<void>();
    let closes = 0;
    useConnection(() => pending.promise);
    const req = request();
    const response = await GET(req.value);
    const reader = response.body!.getReader();

    const canceled = reader.cancel();
    pending.resolve({
      snapshot,
      close: () => {
        closes += 1;
        closed.resolve();
      },
    });
    await canceled;
    await closed.promise;

    expect(closes).toBe(1);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  test("request abort closes an in-flight response and releases a late subscription", async () => {
    const pending = deferred<CodecSceneConnection>();
    const closed = deferred<void>();
    let closes = 0;
    useConnection(() => pending.promise);
    const req = request();
    const response = await GET(req.value);
    const reader = response.body!.getReader();
    const next = reader.read();

    req.controller.abort();
    expect(await next).toEqual({ done: true, value: undefined });
    pending.resolve({
      snapshot,
      close: () => {
        closes += 1;
        closed.resolve();
      },
    });
    await closed.promise;

    expect(closes).toBe(1);
  });

  test("an already aborted request never joins the shared scene service", async () => {
    let connects = 0;
    useConnection(async () => {
      connects += 1;
      return { snapshot, close() {} };
    });
    const req = request();
    req.controller.abort();

    const response = await GET(req.value);

    expect(await response.text()).toBe("");
    expect(connects).toBe(0);
  });

  test("a connection failure emits stale and closes without a heartbeat", async () => {
    useConnection(async () => {
      throw new Error("scene unavailable");
    });
    const req = request();
    const clearHeartbeat = spyOn(globalThis, "clearInterval");
    spies.push(clearHeartbeat);

    const response = await GET(req.value);

    expect(await response.text()).toBe(
      'event: stale\ndata: {"reason":"scene_build_failed"}\n\n',
    );
    expect(clearHeartbeat).not.toHaveBeenCalled();
  });
});
