import { expect, test } from "bun:test";

import { CODEC_SCHEMA_VERSION, type CodecScene } from "@/lib/codec/contracts";

import { createCodecSnapshotLoader } from "./CodecView";

function scene(generatedAt: string): CodecScene {
  return { schema_version: CODEC_SCHEMA_VERSION, generated_at: generatedAt } as CodecScene;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function requestQueue() {
  const requests: Array<{
    url: string;
    options: { cache: "no-store"; signal: AbortSignal };
    response: ReturnType<typeof deferred<Pick<Response, "ok" | "json">>>;
  }> = [];
  return {
    requests,
    fetchSnapshot: (url: string, options: { cache: "no-store"; signal: AbortSignal }) => {
      const response = deferred<Pick<Response, "ok" | "json">>();
      requests.push({ url, options, response });
      return response.promise;
    },
  };
}

test("a newer poll wins even when the aborted request still returns", async () => {
  const { requests, fetchSnapshot } = requestQueue();
  const accepted: CodecScene[] = [];
  const failures: string[] = [];
  const loader = createCodecSnapshotLoader(
    (next) => accepted.push(next),
    () => failures.push("failed"),
    fetchSnapshot,
  );
  const older = loader.load();
  const newer = loader.load();
  expect(requests[0]!.options.signal.aborted).toBe(true);
  expect(requests[1]!.url).toBe("/api/codec-scene");
  expect(requests[1]!.options.cache).toBe("no-store");
  const latest = scene("2026-10-26T18:00:02.000Z");
  requests[1]!.response.resolve({ ok: true, json: async () => latest });
  await newer;
  requests[0]!.response.resolve({
    ok: true,
    json: async () => scene("2026-10-26T18:00:01.000Z"),
  });
  await older;
  expect(accepted).toEqual([latest]);
  expect(failures).toEqual([]);
});

test("stream replacement or unmount cancels a snapshot already decoding", async () => {
  const body = deferred<unknown>();
  const decoding = deferred<void>();
  const accepted: CodecScene[] = [];
  const failures: string[] = [];
  let signal: AbortSignal | undefined;
  const loader = createCodecSnapshotLoader(
    (next) => accepted.push(next),
    () => failures.push("failed"),
    async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        json: () => {
          decoding.resolve();
          return body.promise;
        },
      };
    },
  );
  const pending = loader.load();
  await decoding.promise;
  loader.cancel();
  expect(signal?.aborted).toBe(true);
  body.resolve(scene("2026-10-26T18:00:01.000Z"));
  await pending;
  expect(accepted).toEqual([]);
  expect(failures).toEqual([]);
});

test("a canceled request failure cannot mark the current feed stale", async () => {
  const { requests, fetchSnapshot } = requestQueue();
  const failures: string[] = [];
  const loader = createCodecSnapshotLoader(() => {}, () => failures.push("failed"), fetchSnapshot);
  const pending = loader.load();
  loader.cancel();
  requests[0]!.response.reject(new Error("late network failure"));
  await pending;
  expect(failures).toEqual([]);
});

test("failed or unsupported snapshots report a feed fault and permit recovery", async () => {
  const failures: string[] = [];
  const accepted: CodecScene[] = [];
  const responses = [
    { ok: false, json: async () => null },
    { ok: true, json: async () => ({ schema_version: CODEC_SCHEMA_VERSION + 1 }) },
    { ok: true, json: async () => scene("2026-10-26T18:00:03.000Z") },
  ];
  const loader = createCodecSnapshotLoader(
    (next) => accepted.push(next),
    () => failures.push("failed"),
    async () => responses.shift()!,
  );
  await loader.load();
  await loader.load();
  await loader.load();
  expect(failures).toHaveLength(2);
  expect(accepted).toEqual([scene("2026-10-26T18:00:03.000Z")]);
});
