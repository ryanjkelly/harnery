import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  type ExitedThreadLeaseReleaseV3,
  releaseEventV3LeasesHeldByExitedThreadV3,
} from "../../src/core/events/v3/thread-leases.ts";
import { rejectionReason } from "./rejection-reason.ts";
import type { HarneryOpenClawConfig, RecordQueue, RecordQueueStats } from "./types.ts";
import type {
  RecordWorkerData,
  RecordWorkerMessage,
  RecordWorkerMessageBody,
  RecordWorkerReply,
} from "./worker-protocol.ts";

interface WorkerHandle {
  /** Captured at start: Node reports -1 once the thread has exited. */
  readonly threadId: number;
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
  /** Reclaims ledger leases an exited worker thread left held. */
  releaseExitedThreadLeases?: (coordRoot: string, threadId: number) => ExitedThreadLeaseReleaseV3;
  /** Schedules a retry of an unfinished lease release; defaults to an unref'd timer. */
  scheduleRetry?: (retry: () => void, delayMs: number) => void;
}

const RELEASE_RETRY_FIRST_MS = 250;
const RELEASE_RETRY_MAX_MS = 30_000;

interface UnfinishedRelease {
  /** Runs the release once; true when it reported nothing left. */
  attempt(): boolean;
}

/**
 * Exited recorder threads whose lease release has not yet reported clean, by
 * ledger root. Anything the release leaves is a recovery claim of this
 * thread, which other threads and processes must respect while the gateway
 * lives, so only this thread can clear it.
 */
const unfinishedReleases = new Map<string, Map<number, UnfinishedRelease>>();

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
  const releaseExitedThreadLeases =
    dependencies.releaseExitedThreadLeases ?? releaseEventV3LeasesHeldByExitedThreadV3;
  const scheduleRetry = dependencies.scheduleRetry ?? scheduleUnrefTimer;
  // A new recorder must not start behind residue an earlier one left.
  for (const unfinished of [...(unfinishedReleases.get(config.ledgerRoot)?.values() ?? [])]) {
    unfinished.attempt();
  }
  let worker: WorkerHandle;
  try {
    worker = dependencies.createWorker?.(workerData) ?? createWorker(workerData);
  } catch {
    return unavailableQueue(report, "worker_start_failed");
  }

  worker.unref();
  const workerThreadId = worker.threadId;
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
      // The worker already masks paths; mask again so a reply can never
      // put a path in the gateway log.
      report(
        `[harnery] recorder worker rejected ${replyKind(reply.kind)} (${rejectionReason(reply.reason)})`,
      );
    }
    waiter.resolve();
  });
  worker.on("error", () => settleAll("worker_error"));
  worker.on("exit", (code) => {
    // A terminated or crashed worker runs no `finally` block, so a ledger
    // lease it held stays held by this still-running process. Release it
    // before anything else in this process writes to the ledger.
    releaseLeasesOfExitedWorker();
    if (!closed && code !== 0) settleAll("worker_exit");
    else {
      available = false;
      for (const waiter of pending.values()) waiter.resolve();
      pending.clear();
    }
  });

  function releaseLeasesOfExitedWorker(): void {
    if (!Number.isSafeInteger(workerThreadId) || workerThreadId <= 0) return;
    releaseUntilClean(config.ledgerRoot, workerThreadId, {
      release: releaseExitedThreadLeases,
      report,
      scheduleRetry,
    });
  }

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

/**
 * Run the exited-thread release now and, while it reports anything left,
 * again with doubling delays up to a cap until it reports clean. The first
 * failure is logged once; a later success says how many attempts it took.
 */
function releaseUntilClean(
  ledgerRoot: string,
  threadId: number,
  dependencies: {
    release: (coordRoot: string, threadId: number) => ExitedThreadLeaseReleaseV3;
    report: (message: string) => void;
    scheduleRetry: (retry: () => void, delayMs: number) => void;
  },
): void {
  let attempts = 0;
  let reported = false;
  let delay = RELEASE_RETRY_FIRST_MS;
  const forRoot = unfinishedReleases.get(ledgerRoot) ?? new Map<number, UnfinishedRelease>();
  unfinishedReleases.set(ledgerRoot, forRoot);

  const attempt = (): boolean => {
    attempts += 1;
    let failure: string;
    try {
      const { failed } = dependencies.release(ledgerRoot, threadId);
      if (failed.length === 0) {
        forRoot.delete(threadId);
        if (forRoot.size === 0 && unfinishedReleases.get(ledgerRoot) === forRoot) {
          unfinishedReleases.delete(ledgerRoot);
        }
        if (reported) {
          dependencies.report(
            `[harnery] recorder worker ledger leases released after ${attempts} attempts`,
          );
        }
        return true;
      }
      failure = `[harnery] recorder worker exited holding ledger leases it could not release (${failed.join(", ")})`;
    } catch {
      failure = "[harnery] recorder worker exit lease release failed";
    }
    if (!reported) {
      reported = true;
      dependencies.report(failure);
    }
    return false;
  };
  const retry = (): void => {
    // A release run before a new worker started may already have finished it.
    if (!forRoot.has(threadId) || attempt()) return;
    dependencies.scheduleRetry(retry, delay);
    delay = Math.min(delay * 2, RELEASE_RETRY_MAX_MS);
  };
  forRoot.set(threadId, { attempt });
  retry();
}

function scheduleUnrefTimer(retry: () => void, delayMs: number): void {
  setTimeout(retry, delayMs).unref?.();
}

const REPLY_KINDS: ReadonlySet<string> = new Set([
  "record",
  "capture",
  "log",
  "boot",
  "flush",
  "shutdown",
]);

/** The reply's kind from the fixed protocol vocabulary, never free text. */
function replyKind(kind: unknown): string {
  return typeof kind === "string" && REPLY_KINDS.has(kind) ? kind : "message";
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
