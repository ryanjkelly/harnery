export type ThumbnailPriority = "visible" | "prefetch";

/** Keep speculative work to one slot and always admit queued visible work first. */
export function createThumbnailScheduler(limit = 4, queueLimit = 128) {
  let active = 0;
  let prefetchActive = 0;
  let visibleCompletions = 0;
  const queue: Array<{
    priority: ThumbnailPriority;
    completion: boolean;
    start: () => void;
    cancel: () => void;
  }> = [];
  const pump = () => {
    while (active < limit && queue.length) {
      let next =
        visibleCompletions < 2
          ? queue.findIndex((item) => item.priority === "visible" && item.completion)
          : -1;
      if (next < 0)
        next = queue.findIndex((item) => item.priority === "visible" && !item.completion);
      if (next < 0) {
        if (prefetchActive >= 1) return;
        next = queue.findIndex((item) => item.priority === "prefetch" && item.completion);
        if (next < 0) next = queue.findIndex((item) => item.priority === "prefetch");
        if (next < 0) return;
      }
      queue.splice(next, 1)[0].start();
    }
  };
  return function schedule<T>(
    work: () => Promise<T>,
    signal: AbortSignal,
    priority: ThumbnailPriority = "visible",
    completion = false,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      if (queue.length >= queueLimit) return reject(new Error("Thumbnail queue is full"));
      const item = {
        priority,
        completion,
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
          if (priority === "prefetch") prefetchActive += 1;
          if (priority === "visible" && completion) visibleCompletions += 1;
          void Promise.resolve()
            .then(work)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              if (priority === "prefetch") prefetchActive -= 1;
              if (priority === "visible" && completion) visibleCompletions -= 1;
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
  priority: ThumbnailPriority = "visible",
): Promise<Blob | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(remaining))]);
  const url = `/api/file/thumbnail?path=${encodeURIComponent(path)}&v=${encodeURIComponent(version)}&priority=${priority}`;
  let completing = false;
  while (!bounded.aborted && Date.now() < deadline) {
    const result = await schedule(
      async () => {
        const started = Date.now();
        const response = await request(`${url}${completing ? "&wait=1000" : ""}`, {
          signal: bounded,
        });
        if (response.status === 202 || response.status === 503) {
          // Consume the small status body before releasing the network slot.
          await response.text();
          const seconds = Number(response.headers.get("Retry-After") ?? "1");
          return {
            // Queue saturation backs off; pending work switches immediately to one bounded
            // completion wait. Guard a broken/older server that returns 202 immediately.
            retry:
              response.status === 503
                ? Number.isFinite(seconds)
                  ? Math.max(100, Math.min(5000, seconds * 1000))
                  : 1000
                : completing
                  ? Math.max(0, 100 - (Date.now() - started))
                  : 0,
          };
        }
        if (!response.ok || !response.headers.get("Content-Type")?.startsWith("image/")) {
          await response.body?.cancel();
          return { blob: null };
        }
        return { blob: await response.blob() };
      },
      bounded,
      priority,
      completing,
    );
    bounded.throwIfAborted();
    if ("blob" in result) return result.blob ?? null;
    completing = true;
    if (Date.now() + result.retry >= deadline) return null;
    if (result.retry) await pause(result.retry, bounded);
  }
  return null;
}
