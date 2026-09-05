export type ThumbnailPriority = "visible" | "prefetch" | "background";
export type ThumbnailCost = "fast" | "expensive";
const rank: Record<ThumbnailPriority, number> = { visible: 0, prefetch: 1, background: 2 };

interface Job<T> {
  key: string;
  priority: ThumbnailPriority;
  cost: ThumbnailCost;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  promise: Promise<T>;
}

/** Reserve capacity for visible work and keep one slot available to cheap renderers. */
export function createThumbnailQueue<T>() {
  const pending = new Map<string, Job<T>>();
  const waiting: Job<T>[] = [];
  let active = 0;
  let expensive = 0;

  function drain() {
    while (active < 2) {
      waiting.sort((a, b) => rank[a.priority] - rank[b.priority]);
      const index = waiting.findIndex((job) => job.cost === "fast" || expensive === 0);
      if (index < 0) return;
      const [job] = waiting.splice(index, 1);
      active++;
      if (job.cost === "expensive") expensive++;
      void Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          active--;
          if (job.cost === "expensive") expensive--;
          pending.delete(job.key);
          drain();
        });
    }
  }

  return {
    get size() {
      return pending.size;
    },
    get hasVisibleWork() {
      return [...pending.values()].some((job) => job.priority === "visible");
    },
    submit(key: string, priority: ThumbnailPriority, cost: ThumbnailCost, run: () => Promise<T>) {
      const existing = pending.get(key);
      if (existing) {
        if (rank[priority] < rank[existing.priority]) existing.priority = priority;
        drain();
        return { created: false, promise: existing.promise };
      }
      const limit = priority === "background" ? 8 : priority === "prefetch" ? 24 : 32;
      if (pending.size >= limit) return null;
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // An abandoned HTTP request must not turn a failed background job into an unhandled rejection.
      void promise.catch(() => {});
      const job = { key, priority, cost, run, promise, resolve, reject };
      pending.set(key, job);
      waiting.push(job);
      drain();
      return { created: true, promise };
    },
    async idle() {
      while (pending.size) {
        await Promise.allSettled([...pending.values()].map((job) => job.promise));
        await Promise.resolve();
      }
    },
  };
}

/** Wait for completion without extending a request past its deadline or abort. */
export function awaitThumbnail<T>(
  work: Promise<T>,
  ms: number,
  signal: AbortSignal,
): Promise<T | undefined> {
  if (ms <= 0 || signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const finish = (value?: T, error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const abort = () => finish();
    const timer = setTimeout(() => finish(), ms);
    signal.addEventListener("abort", abort, { once: true });
    void work.then(
      (value) => finish(value),
      (error) => finish(undefined, error),
    );
  });
}
