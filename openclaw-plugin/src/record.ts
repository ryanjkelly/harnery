import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { HarneryOpenClawConfig, RecordQueue, RecordQueueStats } from "./types.ts";
import type {
  RecordWorkerData,
  RecordWorkerMessage,
  RecordWorkerMessageBody,
  RecordWorkerReply,
} from "./worker-protocol.ts";

interface WorkerHandle {
  postMessage(message: RecordWorkerMessage): void;
  on(event: "message", listener: (reply: RecordWorkerReply) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  unref(): void;
  terminate(): Promise<number>;
}

export interface RecordQueueDependencies {
  packageVersion: string;
  createWorker?: (data: RecordWorkerData) => WorkerHandle;
  report?: (message: string) => void;
}

interface PendingMessage {
  resolve(): void;
}

export function createRecordQueue(
  config: HarneryOpenClawConfig,
  dependencies: RecordQueueDependencies,
): RecordQueue {
  const report = dependencies.report ?? ((message: string) => process.stderr.write(`${message}\n`));
  const workerData: RecordWorkerData = {
    config,
    packageVersion: dependencies.packageVersion,
    instanceId: `inst_openclaw-${randomUUID()}`,
  };
  let worker: WorkerHandle;
  try {
    worker = dependencies.createWorker?.(workerData) ?? createWorker(workerData);
  } catch {
    return unavailableQueue(report, "worker_start_failed");
  }

  worker.unref();
  const pending = new Map<number, PendingMessage>();
  let nextId = 1;
  let accepted = 0;
  let dropped = 0;
  let failures = 0;
  let available = true;
  let closed = false;
  let overloadReported = false;

  const settleAll = (reason: string): void => {
    if (!available) return;
    available = false;
    failures += 1;
    for (const waiter of pending.values()) waiter.resolve();
    pending.clear();
    report(`[harnery] recorder worker unavailable (${reason})`);
  };

  worker.on("message", (reply) => {
    if (!reply || typeof reply.id !== "number") return;
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if (!reply.ok) {
      failures += 1;
      report(`[harnery] recorder worker rejected ${reply.kind}`);
    }
    waiter.resolve();
  });
  worker.on("error", () => settleAll("worker_error"));
  worker.on("exit", (code) => {
    if (!closed && code !== 0) settleAll("worker_exit");
    else {
      available = false;
      for (const waiter of pending.values()) waiter.resolve();
      pending.clear();
    }
  });

  const submit = (
    body: RecordWorkerMessageBody,
    options: { control?: boolean } = {},
  ): Promise<void> => {
    if (!available || closed) {
      if (!options.control) dropped += 1;
      return Promise.resolve();
    }
    if (!options.control && pending.size >= config.queueCapacity) {
      dropped += 1;
      if (!overloadReported) {
        overloadReported = true;
        report(
          `[harnery] recorder queue full; dropping new evidence (capacity=${config.queueCapacity})`,
        );
      }
      return Promise.resolve();
    }

    const id = nextId++;
    const settled = new Promise<void>((resolve) => pending.set(id, { resolve }));
    try {
      worker.postMessage({ ...body, id } as RecordWorkerMessage);
      if (!options.control) accepted += 1;
    } catch {
      pending.delete(id);
      failures += 1;
      report("[harnery] recorder worker post failed");
      return Promise.resolve();
    }
    return settled;
  };

  const stats = (): RecordQueueStats => ({
    accepted,
    dropped,
    failures,
    pending: pending.size,
    closed,
  });

  return {
    enqueue(hook, translation) {
      return submit({ kind: "record", hook, translation });
    },
    capture(hook, skeleton) {
      void submit({ kind: "capture", hook, skeleton });
    },
    log(event, detail = {}) {
      void submit({ kind: "log", event, detail });
    },
    boot(row) {
      void submit({ kind: "boot", row });
    },
    flush() {
      return submit({ kind: "flush" }, { control: true });
    },
    async close() {
      if (closed) return;
      const shutdown = submit({ kind: "shutdown" }, { control: true });
      closed = true;
      await shutdown;
      available = false;
      await worker.terminate().catch(() => 0);
    },
    stats,
  };
}

function createWorker(data: RecordWorkerData): WorkerHandle {
  const sourceExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new Worker(new URL(`./record-worker.${sourceExtension}`, import.meta.url), {
    workerData: data,
  }) as unknown as WorkerHandle;
}

function unavailableQueue(report: (message: string) => void, reason: string): RecordQueue {
  let dropped = 0;
  report(`[harnery] recorder worker unavailable (${reason})`);
  return {
    enqueue() {
      dropped += 1;
      return Promise.resolve();
    },
    capture() {
      dropped += 1;
    },
    log() {
      dropped += 1;
    },
    boot() {
      dropped += 1;
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
    stats: () => ({ accepted: 0, dropped, failures: 1, pending: 0, closed: true }),
  };
}

export type { WorkerHandle };
