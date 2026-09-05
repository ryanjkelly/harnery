import type { FetchResult } from "./client";

const aborted = (): FetchResult<never> => ({ ok: false, status: 0, code: "aborted", detail: null });

/** A small recent-response cache. Concurrent viewers share transport, but each
 * owns its subscription: closing one viewer cannot cancel another viewer. */
export function createPreviewCache<T>({
  load,
  weight = () => 1,
  maxWeight = 64,
  maxEntries = 24,
  ttlMs = 15_000,
  now = Date.now,
}: {
  load: (path: string, signal: AbortSignal) => Promise<FetchResult<T>>;
  weight?: (value: T) => number;
  maxWeight?: number;
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}) {
  type Pending = {
    controller: AbortController;
    subscribers: Set<(value: FetchResult<T>) => void>;
  };
  const recent = new Map<string, { value: T; expires: number; weight: number }>();
  const pending = new Map<string, Pending>();
  let totalWeight = 0;
  const remove = (path: string) => {
    const old = recent.get(path);
    if (old) totalWeight -= old.weight;
    recent.delete(path);
  };
  const invalidate = (path: string) => {
    remove(path);
    // Detach an older generation. Existing subscribers can finish, but that
    // response cannot overwrite a newer fetch or repopulate the cache.
    pending.delete(path);
  };
  const get = (path: string, signal?: AbortSignal): Promise<FetchResult<T>> => {
    if (signal?.aborted) return Promise.resolve(aborted());
    const cached = recent.get(path);
    if (cached && cached.expires > now()) {
      recent.delete(path);
      recent.set(path, cached);
      return Promise.resolve({ ok: true, data: cached.value });
    }
    remove(path);
    let request = pending.get(path);
    if (!request) {
      request = { controller: new AbortController(), subscribers: new Set() };
      pending.set(path, request);
      const current = request;
      void Promise.resolve()
        .then(() => load(path, current.controller.signal))
        .then(
          (result) => {
            if (pending.get(path) === current) {
              pending.delete(path);
              if (result.ok && !current.controller.signal.aborted) {
                const size = weight(result.data);
                if (size <= maxWeight) {
                  remove(path);
                  recent.set(path, { value: result.data, expires: now() + ttlMs, weight: size });
                  totalWeight += size;
                  while (recent.size > maxEntries || totalWeight > maxWeight) {
                    remove(recent.keys().next().value!);
                  }
                }
              }
            }
            for (const finish of current.subscribers) finish(result);
          },
          (error: unknown) => {
            if (pending.get(path) === current) pending.delete(path);
            const result: FetchResult<T> = current.controller.signal.aborted
              ? aborted()
              : {
                  ok: false,
                  status: 0,
                  code: "transport",
                  detail: String(error),
                };
            for (const finish of current.subscribers) finish(result);
          },
        );
    }
    const current = request;
    return new Promise((resolve) => {
      const finish = (result: FetchResult<T>) => {
        signal?.removeEventListener("abort", cancel);
        current.subscribers.delete(finish);
        resolve(signal?.aborted ? aborted() : result);
      };
      const cancel = () => {
        finish(aborted());
        if (current.subscribers.size === 0) {
          current.controller.abort();
          if (pending.get(path) === current) pending.delete(path);
        }
      };
      current.subscribers.add(finish);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  };
  return { get, invalidate };
}
