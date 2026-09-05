/** Share a small request budget across every mounted thumbnail. */
export function createThumbnailScheduler(limit = 4, queueLimit = 128) {
  let active = 0;
  const queue: Array<{ start: () => void; cancel: () => void }> = [];
  const pump = () => {
    while (active < limit && queue.length) queue.shift()?.start();
  };
  return function schedule<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      if (queue.length >= queueLimit) return reject(new Error("Thumbnail queue is full"));
      const item = {
        cancel: () => {
          const index = queue.indexOf(item);
          if (index >= 0) queue.splice(index, 1);
          reject(signal.reason);
        },
        start: () => {
          signal.removeEventListener("abort", item.cancel);
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          active += 1;
          void Promise.resolve()
            .then(work)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              pump();
            });
        },
      };
      signal.addEventListener("abort", item.cancel, { once: true });
      queue.push(item);
      pump();
    });
  };
}

const schedule = createThumbnailScheduler();

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** A 202 completes one queued conversion request; retries stop at the original deadline. */
export async function loadThumbnail(
  path: string,
  version: string,
  signal: AbortSignal,
  deadline: number,
  request: typeof fetch = fetch,
): Promise<Blob | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(remaining))]);
  const url = `/api/file/thumbnail?path=${encodeURIComponent(path)}&v=${encodeURIComponent(version)}`;
  while (!bounded.aborted && Date.now() < deadline) {
    const result = await schedule(async () => {
      const response = await request(url, { signal: bounded });
      if (response.status === 202 || response.status === 503) {
        // Consume the small status body before releasing the network slot.
        await response.text();
        const seconds = Number(response.headers.get("Retry-After") ?? "1");
        return {
          retry: Number.isFinite(seconds) ? Math.max(250, Math.min(5000, seconds * 1000)) : 1000,
        };
      }
      if (!response.ok || !response.headers.get("Content-Type")?.startsWith("image/")) {
        await response.body?.cancel();
        return { blob: null };
      }
      return { blob: await response.blob() };
    }, bounded);
    bounded.throwIfAborted();
    if ("blob" in result) return result.blob ?? null;
    if (Date.now() + result.retry >= deadline) return null;
    await pause(result.retry, bounded);
  }
  return null;
}
