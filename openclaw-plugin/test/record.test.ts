import { describe, expect, test } from "bun:test";
import { createRecordQueue, type WorkerHandle } from "../src/record.ts";
import { createRecordWorkerProcessor, eventPlatform } from "../src/record-worker-runtime.ts";
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
    expect(logs[0]).toMatchObject({ event: "record_failure", error_name: "Error" });
    expect(JSON.stringify(logs)).not.toContain("private-session");
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
  });
});

describe("OpenClaw gateway queue", () => {
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

class FakeWorker implements WorkerHandle {
  messages: RecordWorkerMessage[] = [];
  terminated = false;
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
