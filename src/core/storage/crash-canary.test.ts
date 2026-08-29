import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { HarneryInboxService } from "../inbox/service.ts";
import { createStorageCatalog } from "./catalog.ts";
import { appendDurableHistoryRecord, readDurableHistorySync } from "./durable-history.ts";
import type { HarneryMaintenanceProvider } from "./maintenance.ts";
import {
  createAutomaticMaintenanceComposition,
  runAutomaticMaintenancePass,
} from "./maintenance-providers.ts";
import { queryLogs } from "./query.ts";
import { readSegmentManifest } from "./segments.ts";

const WORKER = fileURLToPath(new URL("./__fixtures__/crash-worker.ts", import.meta.url));
const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited(child).catch(() => undefined);
  }
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("storage framework real-process crash canary", () => {
  test("multi-process shared JSONL remains complete across termination and rotation", async () => {
    const root = fixture("logs");
    const killed = launch("log", root, "killed-writer", "100", "10");
    const survivor = launch("log", root, "survivor", "20", "1");
    expect(await killed.next((line) => line.startsWith("ACK "))).toBe("ACK 1");
    killed.process.kill("SIGKILL");
    await exited(killed.process);
    expect(await survivor.next((line) => line === "COMPLETE")).toBe("COMPLETE");
    await exited(survivor.process);

    const family = createStorageCatalog({ coord_root: root }).require("agent-hook-debug-log");
    const directory = join(root, ".harnery", "logs", "agent-hook-debug");
    expect(readSegmentManifest(directory, family).segments.length).toBeGreaterThan(0);
    const result = await queryLogs([family], { max_records: 1_000, max_bytes: 1_000_000 });
    const survivorRecords = result.records.filter(({ writer_id }) => writer_id === "survivor");
    expect(survivorRecords).toHaveLength(20);
    expect(survivorRecords.map(({ writer_seq }) => writer_seq)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(
      result.records.some(
        ({ writer_id, writer_seq }) => writer_id === "killed-writer" && writer_seq === 1,
      ),
    ).toBeTrue();
  });

  test("durable-history kill before append preserves accepted history and later rotation", async () => {
    const objectDir = join(fixture("history"), ".harnery", "work", "object");
    const options = { max_record_bytes: 128, max_segment_bytes: 128 };
    appendDurableHistoryRecord(objectDir, { sequence: 1, payload: "x".repeat(60) }, options);
    const worker = launch("history-before", objectDir);
    expect(await worker.next((line) => line === "READY")).toBe("READY");
    worker.process.kill("SIGKILL");
    await exited(worker.process);
    expect(
      appendDurableHistoryRecord(objectDir, { sequence: 3, payload: "z".repeat(60) }, options)
        .rotated,
    ).toBeTrue();
    expect(
      readDurableHistorySync<{ sequence: number }>(objectDir, {
        max_record_bytes: 128,
        max_records: 10,
      }).map(({ sequence }) => sequence),
    ).toEqual([1, 3]);
  });

  test("inbox kills before and after durable acknowledgement preserve prior records", async () => {
    const root = fixture("inbox");
    const service = inbox(root, "prior");
    expect(service.send(message("prior")).synced).toBeTrue();

    const before = launch("inbox-before", root, "before");
    expect(await before.next((line) => line === "READY")).toBe("READY");
    before.process.kill("SIGKILL");
    await exited(before.process);
    expect(service.pending("recipient").map(({ body }) => body)).toEqual(["prior"]);

    const after = launch("inbox-after", root, "after");
    expect(await after.next((line) => line.startsWith("ACK "))).toBe("ACK msg_after");
    after.process.kill("SIGKILL");
    await exited(after.process);
    expect(service.pending("recipient").map(({ body }) => body)).toEqual(["prior", "after-after"]);
  });

  test("interrupted automatic claim resumes without destructive callback", async () => {
    const root = fixture("maintenance");
    const worker = launch("maintenance-claim", root);
    expect(await worker.next((line) => line === "CLAIMED")).toBe("CLAIMED");
    worker.process.kill("SIGKILL");
    await exited(worker.process);
    const daily = join(root, ".harnery", "maintenance", "cursors", "daily.json");
    expect(JSON.parse(readFileSync(daily, "utf8")).state).toBe("running");

    let destructiveApplied = false;
    const provider: HarneryMaintenanceProvider = {
      family_id: "storage-maintenance-run-log",
      destructive_scope: "fixture-owner-delete",
      plan: () => ({
        actions: [
          {
            action_id: "delete-canary",
            family_id: "storage-maintenance-run-log",
            kind: "delete",
            target_ref: "fixture",
            files: 1,
            bytes: 10,
            destructive: true,
            authorization_scope: "fixture-owner-delete",
          },
        ],
      }),
      apply: () => {
        destructiveApplied = true;
        return { outcome: "applied" };
      },
    };
    const composition = createAutomaticMaintenanceComposition(root, {
      journal: () => {},
      images: () => {},
      artifacts: () => {},
    });
    const result = await runAutomaticMaintenancePass(
      { ...composition, providers: [provider] },
      { now: new Date("2026-08-29T12:11:00.000Z") },
    );
    expect(result).toMatchObject({ ran: true, reason: "planned", actions: 1 });
    expect(destructiveApplied).toBeFalse();
    expect(JSON.parse(readFileSync(daily, "utf8")).state).toBe("complete");
    expect(
      readdirSync(dirname(daily)).some((name) => name.startsWith("daily.interrupted-")),
    ).toBeTrue();
    expect(existsSync(join(root, "claim.marker"))).toBeTrue();
  });
});

interface Worker {
  process: ChildProcessWithoutNullStreams;
  lines: Interface;
  next(predicate: (line: string) => boolean): Promise<string>;
}

function launch(...args: string[]): Worker {
  const child = spawn(process.execPath, [WORKER, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HARNERY_STORAGE_MAINTENANCE: "1" },
  });
  children.add(child);
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    process: child,
    lines,
    async next(predicate) {
      const deadline = setTimeout(() => child.kill("SIGKILL"), 3_000);
      deadline.unref?.();
      try {
        while (true) {
          const item = await iterator.next();
          if (item.done) {
            const stderr = await streamText(child.stderr);
            throw new Error(`crash worker exited before marker: ${stderr}`);
          }
          if (predicate(item.value)) return item.value;
        }
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

function fixture(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `harnery-crash-${label}-`));
  roots.push(root);
  return root;
}

function inbox(root: string, id: string): HarneryInboxService {
  return new HarneryInboxService({
    coord_root: root,
    limits: {
      max_message_body_bytes: 256,
      max_pending_count: 10,
      max_pending_bytes: 1_024,
      max_history_bytes: 16_384,
      max_history_records: 100,
      warning_pressure_ratio: 0.8,
      max_surface_count: 4,
      max_surface_bytes: 512,
      max_surface_tokens: 128,
      surfaced_grace_ms: 1_000,
      terminal_grace_ms: 5_000,
    },
    id: () => id,
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  });
}

function message(body: string) {
  return {
    sender_instance_id: "sender",
    sender_display_name: "Sender",
    recipient_instance_id: "recipient",
    recipient_display_name: "Recipient",
    body,
  };
}

function exited(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child process did not exit within 3 seconds"));
    }, 3_000);
    timeout.unref?.();
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
