import type {
  DashboardInputs,
  DashboardReadKind,
  DashboardRequest,
  DashboardResponse,
  DashboardResults,
} from "./dashboard-reader-protocol";

export interface ReaderWorker {
  postMessage(value: DashboardRequest): void;
  on(event: "message", listener: (value: DashboardResponse) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
  unref(): void;
  ref(): void;
}

interface PendingRead {
  key: string;
  kind: DashboardReadKind;
  resolve: (value: DashboardResults[DashboardReadKind]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One lazy worker, a bounded queue, and shared promises for identical reads. */
export class DashboardReaderClient {
  private worker: ReaderWorker | undefined;
  private nextId = 0;
  private pending = new Map<number, PendingRead>();
  private inFlight = new Map<string, Promise<DashboardResults[DashboardReadKind]>>();
  private paletteCache: { at: number; value: DashboardResults["palette"] } | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly createWorker: () => ReaderWorker,
    private readonly options: {
      timeoutMs?: number;
      idleMs?: number;
      maxPending?: number;
      paletteTtlMs?: number;
      now?: () => number;
    } = {},
  ) {}

  read<K extends DashboardReadKind>(
    kind: K,
    input?: DashboardInputs[K],
    options: { signal?: AbortSignal } = {},
  ): Promise<DashboardResults[K]> {
    if (options.signal?.aborted)
      return Promise.reject(new DOMException("Read cancelled", "AbortError"));
    const now = (this.options.now ?? Date.now)();
    if (
      kind === "palette" &&
      this.paletteCache &&
      now - this.paletteCache.at < (this.options.paletteTtlMs ?? 10_000)
    ) {
      return Promise.resolve(this.paletteCache.value as DashboardResults[K]);
    }
    const key = JSON.stringify([kind, input ?? null]);
    let shared = this.inFlight.get(key);
    if (!shared) {
      if (this.pending.size >= (this.options.maxPending ?? 32)) {
        return Promise.reject(new Error("dashboard_reader_busy"));
      }
      let worker: ReaderWorker;
      try {
        worker = this.ensureWorker();
      } catch {
        return Promise.reject(new Error("dashboard_reader_unavailable"));
      }
      if (this.idleTimer) clearTimeout(this.idleTimer);
      worker.ref();
      const id = ++this.nextId;
      shared = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => this.failWorker(worker, new Error("dashboard_reader_timeout")),
          this.options.timeoutMs ?? 30_000,
        );
        this.pending.set(id, { key, kind, resolve, reject, timer });
      });
      this.inFlight.set(key, shared);
      try {
        worker.postMessage({ id, kind, input } as DashboardRequest);
      } catch {
        this.failWorker(worker, new Error("dashboard_reader_unavailable"));
      }
    }
    return this.withSignal(shared as Promise<DashboardResults[K]>, options.signal);
  }

  close(): void {
    if (this.worker) this.failWorker(this.worker, new Error("dashboard_reader_closed"));
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.paletteCache = undefined;
  }

  private ensureWorker(): ReaderWorker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.worker = worker;
    worker.on("message", (response) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      this.inFlight.delete(pending.key);
      if (response.ok) {
        if (pending.kind === "palette") {
          this.paletteCache = {
            at: (this.options.now ?? Date.now)(),
            value: response.value as DashboardResults["palette"],
          };
        }
        pending.resolve(response.value);
      } else {
        pending.reject(new Error(response.error));
      }
      if (this.pending.size === 0) {
        worker.unref();
        this.idleTimer = setTimeout(() => {
          if (this.worker === worker && this.pending.size === 0) {
            this.worker = undefined;
            void worker.terminate().catch(() => {});
          }
        }, this.options.idleMs ?? 60_000);
        this.idleTimer.unref?.();
      }
    });
    worker.on("error", () => this.failWorker(worker, new Error("dashboard_reader_unavailable")));
    worker.on("exit", () => this.failWorker(worker, new Error("dashboard_reader_exited")));
    return worker;
  }

  private failWorker(worker: ReaderWorker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.inFlight.clear();
    void worker.terminate().catch(() => {});
  }

  private withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("Read cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
}
