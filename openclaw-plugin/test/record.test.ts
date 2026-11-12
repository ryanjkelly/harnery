import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import { createRecordQueue, type WorkerHandle } from "../src/record.ts";
import {
  createRecordWorkerProcessor,
  eventPlatform,
  rejectionReason,
} from "../src/record-worker-runtime.ts";
import type { HarneryOpenClawConfig, OpenClawTranslation } from "../src/types.ts";
import type {
  RecordWorkerData,
  RecordWorkerMessage,
  RecordWorkerReply,
} from "../src/worker-protocol.ts";

const config: HarneryOpenClawConfig = {
  mode: "record",
  ledgerRoot: "/tmp/harnery-openclaw-record-test",
  logRoot: "/tmp/harnery-openclaw-record-test-logs",
  agents: ["main"],
  debug: true,
  recorderFault: false,
  queueCapacity: 2,
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

describe("OpenClaw recorder worker runtime", () => {
  test("maps the host platform without assuming the deployment operating system", () => {
    expect(eventPlatform("linux")).toBe("linux");
    expect(eventPlatform("darwin")).toBe("macos");
    expect(eventPlatform("win32")).toBe("windows");
    expect(eventPlatform("aix")).toBe("unknown");
  });

  test("serializes interleaved sessions through one gateway instance", () => {
    const recorded: Array<Record<string, unknown>> = [];
    let ensured = 0;
    const processor = createRecordWorkerProcessor(workerData(), {
      appendDebug: () => undefined,
      appendBoot: () => undefined,
      ensureLedger: () => {
        ensured += 1;
      },
      recordSignal: (input) => {
        recorded.push(input as unknown as Record<string, unknown>);
        return { state: "ignored" };
      },
    });

    processor.process(message(1, "session-a"));
    processor.process(message(2, "session-b"));
    processor.process(message(3, "session-a"));

    expect(recorded.map((row) => (row.payload as { session_id: string }).session_id)).toEqual([
      "session-a",
      "session-b",
      "session-a",
    ]);
    expect(new Set(recorded.map((row) => row.instance_id)).size).toBe(1);
    expect(recorded.every((row) => row.adapter === "openclaw")).toBe(true);
    expect(recorded.every((row) => row.hook_duration_ms === undefined)).toBe(true);
    expect(recorded.every((row) => row.intake === "memory_only")).toBe(true);
    expect(ensured).toBe(1);
  });

  test("reports a busy memory-only recorder without exposing payload content", () => {
    const logs: Array<Record<string, unknown>> = [];
    const processor = createRecordWorkerProcessor(workerData(), {
      appendDebug: (row) => logs.push(row),
      appendBoot: () => undefined,
      ensureLedger: () => undefined,
      recordSignal: () => ({ state: "busy" }),
    });

    expect(processor.process(message(1, "private-session"))).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: "record_failure", error_name: "RecorderBusyError" });
    expect(JSON.stringify(logs)).not.toContain("private-session");
    expect(JSON.stringify(logs)).not.toContain("openclaw_recorder_busy");
  });

  test("swallows recorder exceptions, omits error text, and continues", () => {
    const logs: Array<Record<string, unknown>> = [];
    let calls = 0;
    const processor = createRecordWorkerProcessor(workerData(), {
      appendDebug: (row) => logs.push(row),
      appendBoot: () => undefined,
      ensureLedger: () => undefined,
      recordSignal: () => {
        calls += 1;
        if (calls === 1) throw new Error("private recorder failure detail");
        return { state: "ignored" };
      },
    });

    expect(processor.process(message(1, "session-a"))).toBe(false);
    expect(processor.process(message(2, "session-b"))).toBe(true);

    expect(calls).toBe(2);
    expect(logs.map((row) => row.event)).toEqual(["record_failure", "record_result"]);
    expect(logs[0]).toMatchObject({ error_name: "Error" });
    expect(JSON.stringify(logs)).not.toContain("private recorder failure detail");
  });

  test("recorderFault fails open before invoking the canonical recorder", () => {
    const logs: Array<Record<string, unknown>> = [];
    let calls = 0;
    const processor = createRecordWorkerProcessor(workerData({ recorderFault: true }), {
      appendDebug: (row) => logs.push(row),
      appendBoot: () => undefined,
      ensureLedger: () => undefined,
      recordSignal: () => {
        calls += 1;
        return { state: "ignored" };
      },
    });

    expect(processor.process(message(1, "session-a"))).toBe(false);
    expect(calls).toBe(0);
    expect(logs.map((row) => row.event)).toEqual(["record_failure"]);
    expect(logs[0]).toMatchObject({ error_name: "RecorderFaultInjectedError" });
  });
});

describe("OpenClaw recorder rejection reasons", () => {
  test("a rejected record carries the error code or masked first message line", () => {
    const processor = createRecordWorkerProcessor(workerData(), {
      appendDebug: () => undefined,
      appendBoot: () => undefined,
      ensureLedger: () => undefined,
      recordSignal: () => {
        throw new Error(
          "lease path is not a directory: /srv/private/ledger/lease\nsecond line with session-a",
        );
      },
    });
    expect(processor.processDetailed(message(1, "session-a"))).toEqual({
      ok: false,
      reason: "lease path is not a directory: <path>",
    });
    expect(processor.process(message(2, "session-a"))).toBe(false);
  });

  test("reasons prefer a code, mask paths, and stay short", () => {
    const coded = Object.assign(new Error("open /srv/private/file failed"), { code: "EACCES" });
    expect(rejectionReason(coded)).toBe("EACCES");
    // Text after the first path is dropped: a path's end cannot be known.
    expect(rejectionReason(new Error("cannot read C:\\Users\\someone\\ledger or ~/state/x"))).toBe(
      "cannot read <path>",
    );
    expect(rejectionReason(new Error(`bad ${"x".repeat(300)}`))).toHaveLength(120);
    expect(rejectionReason("plain string")).toBe("plain string");
    expect(rejectionReason(undefined)).toBe("unknown");
  });

  test("F3: no part of a path with spaces reaches the reason", () => {
    const posix = rejectionReason(
      new Error("lease path is not a directory: /srv/private customer/ledger/lease"),
    );
    expect(posix).toBe("lease path is not a directory: <path>");
    expect(posix).not.toContain("customer");

    const windows = rejectionReason(
      new Error("cannot open C:\\Users\\First Last\\state dir\\ledger\\lease for writing"),
    );
    expect(windows).toBe("cannot open <path>");
    expect(windows).not.toContain("Last");
    expect(windows).not.toContain("writing");

    expect(rejectionReason(new Error("lstat '/var/first last/x' failed"))).toBe("lstat '<path>");
    expect(rejectionReason(new Error("bad file:///opt/my state/ledger"))).toBe("bad <path>");
    expect(rejectionReason(new Error("missing ledgers/v3 private/epoch"))).toBe("missing <path>");
    expect(rejectionReason(new Error("share \\\\server\\team share\\ledger offline"))).toBe(
      "share <path>",
    );

    expect(rejectionReason(new Error("event_v3_publication_lease_busy"))).toBe(
      "event_v3_publication_lease_busy",
    );
    expect(rejectionReason(new Error("lease event-v3-append is held by a live owner"))).toBe(
      "lease event-v3-append is held by a live owner",
    );
  });

  test("F3: a code is reported only when it is a plain identifier", () => {
    const pathCode = Object.assign(new Error("boom"), { code: "/srv/private customer/x" });
    expect(rejectionReason(pathCode)).toBe("boom");
    const coded = Object.assign(new Error("open /srv/a b/c failed"), { code: "ERR_LEASE_BUSY" });
    expect(rejectionReason(coded)).toBe("ERR_LEASE_BUSY");
  });

  test("the real worker thread replies with the reason and the gateway logs it", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-openclaw-reject-"));
    roots.push(root);
    const reports: string[] = [];
    const queue = createRecordQueue(
      {
        ...config,
        ledgerRoot: join(root, "ledger"),
        logRoot: join(root, "logs"),
        debug: false,
        recorderFault: true,
      },
      { packageVersion: "0.1.0", report: (line) => reports.push(line) },
    );
    await queue.enqueue("session_start", translation("session-start", "private-session"));
    await queue.close();
    expect(reports).toEqual([
      "[harnery] recorder worker rejected record (recorder_fault_injected)",
    ]);
    expect(JSON.stringify(reports)).not.toContain("private-session");
  });
});

describe("OpenClaw gateway queue", () => {
  test("logs the worker's rejection reason", async () => {
    const fake = new FakeWorker();
    const reports: string[] = [];
    const queue = createRecordQueue(config, {
      packageVersion: "0.1.0",
      createWorker: () => fake,
      report: (line) => reports.push(line),
      releaseExitedThreadLeases: () => ({ released: [], failed: [] }),
    });
    const settled = queue.enqueue("session_start", translation("session-start", "session-a"));
    fake.reply({ id: fake.messages[0]?.id ?? 0, kind: "record", ok: false, reason: "EACCES" });
    await settled;
    expect(reports).toEqual(["[harnery] recorder worker rejected record (EACCES)"]);
  });

  test("F3: the gateway masks a path in a worker's reason before logging it", async () => {
    const fake = new FakeWorker();
    const reports: string[] = [];
    const queue = createRecordQueue(config, {
      packageVersion: "0.1.0",
      createWorker: () => fake,
      report: (line) => reports.push(line),
      releaseExitedThreadLeases: () => ({ released: [], failed: [] }),
    });
    const settled = queue.enqueue("session_start", translation("session-start", "session-a"));
    fake.reply({
      id: fake.messages[0]?.id ?? 0,
      kind: "record",
      ok: false,
      reason: "cannot open /srv/private customer/ledger\nsecond line",
    });
    await settled;
    expect(reports).toEqual(["[harnery] recorder worker rejected record (cannot open <path>)"]);
  });

  test("a worker exit releases the ledger leases its thread left held", async () => {
    const fake = new FakeWorker(7);
    const scheduler = manualScheduler();
    const reports: string[] = [];
    const calls: Array<[string, number]> = [];
    const queue = createRecordQueue(config, {
      packageVersion: "0.1.0",
      createWorker: () => fake,
      report: (line) => reports.push(line),
      releaseExitedThreadLeases: (coordRoot, threadId) => {
        calls.push([coordRoot, threadId]);
        return calls.length === 1
          ? { released: ["event-v3-append"], failed: ["event-v3-publication"] }
          : { released: ["event-v3-publication"], failed: [] };
      },
      scheduleRetry: scheduler.schedule,
    });
    const pending = queue.enqueue("session_start", translation("session-start", "session-a"));
    fake.exit(1);
    await pending;

    expect(calls).toEqual([[config.ledgerRoot, 7]]);
    expect(reports).toEqual([
      "[harnery] recorder worker exited holding ledger leases it could not release (event-v3-publication)",
      "[harnery] recorder worker unavailable (worker_exit)",
    ]);
    expect(queue.stats()).toMatchObject({ pending: 0, failures: 1 });
    scheduler.runNext();
    expect(calls).toEqual([
      [config.ledgerRoot, 7],
      [config.ledgerRoot, 7],
    ]);
    expect(scheduler.pending()).toBe(0);
  });

  test("a clean shutdown exit also releases, and a failing release is reported", async () => {
    const fake = new FakeWorker(9);
    const scheduler = manualScheduler();
    const reports: string[] = [];
    const calls: number[] = [];
    const queue = createRecordQueue(config, {
      packageVersion: "0.1.0",
      createWorker: () => fake,
      report: (line) => reports.push(line),
      releaseExitedThreadLeases: (_root, threadId) => {
        calls.push(threadId);
        if (calls.length === 1) throw new Error("cannot inspect /srv/private/lease");
        return { released: [], failed: [] };
      },
      scheduleRetry: scheduler.schedule,
    });
    const close = queue.close();
    fake.ackAll();
    await close;
    fake.exit(0);
    expect(calls).toEqual([9]);
    expect(reports).toEqual(["[harnery] recorder worker exit lease release failed"]);
    scheduler.runNext();
    expect(calls).toEqual([9, 9]);
    expect(scheduler.pending()).toBe(0);
  });

  test("F4: a release that leaves residue is retried with backoff until clean, then stops", async () => {
    const fake = new FakeWorker(11);
    const scheduler = manualScheduler();
    const reports: string[] = [];
    const outcomes: Array<string[] | "throw"> = [
      ["event-v3-append"],
      "throw",
      ["event-v3-append"],
      [],
    ];
    let calls = 0;
    createRecordQueue(
      { ...config, ledgerRoot: temporaryLedgerRoot() },
      {
        packageVersion: "0.1.0",
        createWorker: () => fake,
        report: (line) => reports.push(line),
        releaseExitedThreadLeases: () => {
          const outcome = outcomes[calls++] ?? [];
          if (outcome === "throw") throw new Error("cannot inspect /srv/private/lease");
          return { released: [], failed: outcome };
        },
        scheduleRetry: scheduler.schedule,
      },
    );
    fake.exit(1);
    expect(calls).toBe(1);
    expect(scheduler.delays).toEqual([250]);
    scheduler.runNext();
    scheduler.runNext();
    scheduler.runNext();
    expect(calls).toBe(4);
    expect(scheduler.delays).toEqual([250, 500, 1_000]);
    expect(scheduler.pending()).toBe(0);
    expect(reports).toEqual([
      "[harnery] recorder worker exited holding ledger leases it could not release (event-v3-append)",
      "[harnery] recorder worker unavailable (worker_exit)",
      "[harnery] recorder worker ledger leases released after 4 attempts",
    ]);
  });

  test("F4: the retry delay is capped while residue persists", () => {
    const fake = new FakeWorker(12);
    const scheduler = manualScheduler();
    createRecordQueue(
      { ...config, ledgerRoot: temporaryLedgerRoot() },
      {
        packageVersion: "0.1.0",
        createWorker: () => fake,
        report: () => undefined,
        releaseExitedThreadLeases: () => ({ released: [], failed: ["event-v3-append"] }),
        scheduleRetry: scheduler.schedule,
      },
    );
    fake.exit(1);
    for (let index = 0; index < 12; index += 1) scheduler.runNext();
    expect(scheduler.pending()).toBe(1);
    expect(Math.max(...scheduler.delays)).toBe(30_000);
    expect(scheduler.delays.slice(-3)).toEqual([30_000, 30_000, 30_000]);
  });

  test("F4: the default retry timer does not keep the gateway alive", () => {
    const fake = new FakeWorker(13);
    const original = globalThis.setTimeout;
    const timers: Array<{ delay: number; unrefed: boolean }> = [];
    globalThis.setTimeout = ((_callback: () => void, delay: number) => {
      const timer = { delay, unrefed: false, unref: () => undefined };
      timer.unref = () => {
        timer.unrefed = true;
        return undefined;
      };
      timers.push(timer);
      return timer;
    }) as unknown as typeof setTimeout;
    try {
      createRecordQueue(
        { ...config, ledgerRoot: temporaryLedgerRoot() },
        {
          packageVersion: "0.1.0",
          createWorker: () => fake,
          report: () => undefined,
          releaseExitedThreadLeases: () => ({ released: [], failed: ["event-v3-append"] }),
        },
      );
      fake.exit(1);
    } finally {
      globalThis.setTimeout = original;
    }
    expect(timers.map(({ delay, unrefed }) => ({ delay, unrefed }))).toEqual([
      { delay: 250, unrefed: true },
    ]);
  });

  test("F4: an unfinished release runs again before a new recorder worker starts", () => {
    const ledgerRoot = temporaryLedgerRoot();
    const scheduler = manualScheduler();
    const order: string[] = [];
    let clean = false;
    const dependencies = (fake: FakeWorker) => ({
      packageVersion: "0.1.0",
      createWorker: () => {
        order.push(`start ${fake.threadId}`);
        return fake;
      },
      report: () => undefined,
      releaseExitedThreadLeases: (_root: string, threadId: number) => {
        order.push(`release ${threadId}`);
        return { released: [], failed: clean ? [] : ["event-v3-append"] };
      },
      scheduleRetry: scheduler.schedule,
    });
    const first = new FakeWorker(21);
    createRecordQueue({ ...config, ledgerRoot }, dependencies(first));
    first.exit(1);
    clean = true;
    createRecordQueue({ ...config, ledgerRoot }, dependencies(new FakeWorker(22)));
    expect(order).toEqual(["start 21", "release 21", "release 21", "start 22"]);
    // Cleared before the new worker started, so the scheduled retry does nothing.
    scheduler.runNext();
    expect(order).toHaveLength(4);
    expect(scheduler.pending()).toBe(0);
  });

  test("bounds outstanding work, reports backpressure, and drains deterministically", async () => {
    const fake = new FakeWorker();
    const reports: string[] = [];
    const queue = createRecordQueue(config, {
      packageVersion: "0.1.0",
      createWorker: () => fake,
      report: (line) => reports.push(line),
    });

    void queue.enqueue("session_start", translation("session-start", "session-a"));
    void queue.enqueue("session_start", translation("session-start", "session-b"));
    await queue.enqueue("session_start", translation("session-start", "session-c"));

    expect(fake.messages).toHaveLength(2);
    expect(queue.stats()).toMatchObject({ accepted: 2, dropped: 1, pending: 2 });
    expect(reports).toEqual(["[harnery] recorder queue full; dropping new evidence (capacity=2)"]);

    fake.ackAll();
    const flush = queue.flush();
    expect(fake.messages.at(-1)?.kind).toBe("flush");
    fake.ackAll();
    await flush;
    expect(queue.stats().pending).toBe(0);

    const close = queue.close();
    expect(fake.messages.at(-1)?.kind).toBe("shutdown");
    fake.ackAll();
    await close;
    expect(queue.stats().closed).toBe(true);
    expect(fake.terminated).toBe(true);
  });

  test("a worker startup failure leaves a fail-open observable queue", async () => {
    const reports: string[] = [];
    const queue = createRecordQueue(config, {
      packageVersion: "0.1.0",
      createWorker: () => {
        throw new Error("private startup detail");
      },
      report: (line) => reports.push(line),
    });

    await queue.enqueue("session_start", translation("session-start", "session-a"));
    expect(queue.stats()).toEqual({
      accepted: 0,
      dropped: 1,
      failures: 1,
      pending: 0,
      closed: true,
    });
    expect(reports).toEqual(["[harnery] recorder worker unavailable (worker_start_failed)"]);
    expect(JSON.stringify(reports)).not.toContain("private startup detail");
  });
});

function manualScheduler() {
  const queued: Array<() => void> = [];
  const delays: number[] = [];
  return {
    delays,
    schedule: (retry: () => void, delayMs: number) => {
      queued.push(retry);
      delays.push(delayMs);
    },
    runNext: () => queued.shift()?.(),
    pending: () => queued.length,
  };
}

function temporaryLedgerRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-openclaw-release-"));
  roots.push(root);
  return root;
}

class FakeWorker implements WorkerHandle {
  messages: RecordWorkerMessage[] = [];
  terminated = false;
  threadId: number;

  constructor(threadId = 1) {
    this.threadId = threadId;
  }

  private messageListeners: Array<(reply: RecordWorkerReply) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  private exitListeners: Array<(code: number) => void> = [];

  postMessage(message: RecordWorkerMessage): void {
    this.messages.push(message);
  }

  on(event: "message" | "error" | "exit", listener: (value: never) => void): this {
    if (event === "message") {
      this.messageListeners.push(listener as (reply: RecordWorkerReply) => void);
    } else if (event === "error") {
      this.errorListeners.push(listener as (error: Error) => void);
    } else {
      this.exitListeners.push(listener as (code: number) => void);
    }
    return this;
  }

  unref(): void {}

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }

  reply(reply: RecordWorkerReply): void {
    for (const listener of this.messageListeners) listener(reply);
  }

  /** Node reports -1 once the thread is gone; the queue must use the id captured at start. */
  exit(code: number): void {
    this.threadId = -1;
    for (const listener of this.exitListeners) listener(code);
  }

  ackAll(): void {
    for (const message of this.messages) {
      for (const listener of this.messageListeners) {
        listener({ id: message.id, kind: message.kind, ok: true });
      }
    }
  }
}

function workerData(overrides: Partial<HarneryOpenClawConfig> = {}): RecordWorkerData {
  return {
    config: { ...config, ...overrides },
    packageVersion: "0.1.0",
    instanceId: "inst_openclaw-fixture",
  };
}

function message(id: number, sessionId: string): RecordWorkerMessage {
  return {
    id,
    kind: "record",
    hook: "session_start",
    translation: translation("session-start", sessionId),
  };
}

function translation(
  signal: OpenClawTranslation["signal"],
  sessionId: string,
): OpenClawTranslation {
  return { signal, payload: { raw: {}, session_id: sessionId } };
}
