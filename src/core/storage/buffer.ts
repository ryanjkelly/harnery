export interface BufferedLogItem<T> {
  value: T;
  bytes: number;
  high_priority: boolean;
}

export interface BoundedLogBufferOptions<T> {
  max_bytes: number;
  max_records: number;
  high_severity_reserve_bytes: number;
  flush_interval_ms: number;
  minimum_high_priority_drain_interval_ms?: number;
  drain(items: readonly BufferedLogItem<T>[]): Promise<void>;
  on_drop?(reason: "normal_capacity" | "total_capacity" | "closed", item: T): void;
  on_drain_error?(error: unknown): void;
}

export class BoundedLogBuffer<T> {
  readonly #options: BoundedLogBufferOptions<T>;
  #items: BufferedLogItem<T>[] = [];
  #bytes = 0;
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #draining: Promise<void> = Promise.resolve();
  #lastHighPriorityDrain = 0;

  constructor(options: BoundedLogBufferOptions<T>) {
    if (
      !Number.isSafeInteger(options.max_bytes) ||
      options.max_bytes <= 0 ||
      !Number.isSafeInteger(options.max_records) ||
      options.max_records <= 0 ||
      options.high_severity_reserve_bytes < 0 ||
      options.high_severity_reserve_bytes >= options.max_bytes ||
      options.flush_interval_ms <= 0
    ) {
      throw new Error("invalid bounded log buffer policy");
    }
    this.#options = options;
  }

  get size(): { records: number; bytes: number; capacity_bytes: number } {
    return {
      records: this.#items.length,
      bytes: this.#bytes,
      capacity_bytes: this.#options.max_bytes,
    };
  }

  enqueue(item: BufferedLogItem<T>): boolean {
    if (this.#closed) return this.#drop("closed", item.value);
    if (!Number.isSafeInteger(item.bytes) || item.bytes <= 0) {
      throw new Error("buffer item bytes must be a positive safe integer");
    }
    const byteLimit = item.high_priority
      ? this.#options.max_bytes
      : this.#options.max_bytes - this.#options.high_severity_reserve_bytes;
    if (this.#items.length >= this.#options.max_records) {
      return this.#drop(item.high_priority ? "total_capacity" : "normal_capacity", item.value);
    }
    if (this.#bytes + item.bytes > byteLimit) {
      return this.#drop(item.high_priority ? "total_capacity" : "normal_capacity", item.value);
    }
    this.#items.push(item);
    this.#bytes += item.bytes;
    this.#scheduleTimer();
    if (item.high_priority) this.#scheduleHighPriorityDrain();
    return true;
  }

  async flush(): Promise<void> {
    this.#cancelTimer();
    const batch = this.#take();
    if (batch.length > 0) {
      this.#draining = this.#draining.then(() => this.#options.drain(batch));
    }
    await this.#draining;
  }

  async close(): Promise<void> {
    if (this.#closed) return this.#draining;
    this.#closed = true;
    await this.flush();
  }

  #take(): BufferedLogItem<T>[] {
    const batch = this.#items;
    this.#items = [];
    this.#bytes = 0;
    return batch;
  }

  #scheduleTimer(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush().catch((error) => this.#options.on_drain_error?.(error));
    }, this.#options.flush_interval_ms);
    this.#timer.unref?.();
  }

  #scheduleHighPriorityDrain(): void {
    const minimum = this.#options.minimum_high_priority_drain_interval_ms ?? 25;
    const now = Date.now();
    const delay = Math.max(0, minimum - (now - this.#lastHighPriorityDrain));
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#lastHighPriorityDrain = Date.now();
      void this.flush().catch((error) => this.#options.on_drain_error?.(error));
    }, delay);
    this.#timer.unref?.();
  }

  #cancelTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #drop(reason: "normal_capacity" | "total_capacity" | "closed", item: T): false {
    this.#options.on_drop?.(reason, item);
    return false;
  }
}
