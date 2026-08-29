import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStorageCatalog } from "../storage/catalog.ts";
import type { HarneryLogRecordV1 } from "../storage/jsonl.ts";
import { encodeLogRecord } from "../storage/jsonl.ts";
import { FileSegmentSink } from "../storage/segments.ts";
import { governorServiceLogPath, readGovernorServiceLogs } from "./service-read.ts";

const roots: string[] = [];
const originalSharedLogs = process.env.HARNERY_SHARED_LOGS;

afterEach(() => {
  if (originalSharedLogs === undefined) delete process.env.HARNERY_SHARED_LOGS;
  else process.env.HARNERY_SHARED_LOGS = originalSharedLogs;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("governor service log reader", () => {
  test("prefers the shared active generation and falls back to untouched history", () => {
    delete process.env.HARNERY_SHARED_LOGS;
    const root = fixture();
    const legacy = join(root, ".harnery", "governor-service", "service.log");
    const active = join(root, ".harnery", "logs", "governor-service", "active.jsonl");
    write(legacy, "historical\n");
    expect(governorServiceLogPath(root)).toBe(legacy);
    write(active, '{"schema":"harnery.log-record/v1"}\n');
    expect(governorServiceLogPath(root)).toBe(active);
  });

  test("uses only the legacy service log when the process rollback is set", () => {
    process.env.HARNERY_SHARED_LOGS = "0";
    const root = fixture();
    const legacy = join(root, ".harnery", "governor-service", "service.log");
    write(join(root, ".harnery", "logs", "governor-service", "active.jsonl"), "shared\n");
    expect(governorServiceLogPath(root)).toBe(legacy);
  });

  test("replays a rotated sealed generation without an active file and deduplicates history", async () => {
    delete process.env.HARNERY_SHARED_LOGS;
    const root = fixture();
    const family = createStorageCatalog({ coord_root: root }).require("governor-service-log");
    const directory = join(root, ".harnery", "logs", "governor-service");
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    const first = sharedRecord(family, 1, "2026-08-29T10:00:00.000Z", "service.started", {
      goals: 1,
    });
    await sink.append([first]);
    await sink.append([
      sharedRecord(family, 2, "2026-08-29T10:01:00.000Z", "service.stopped", { sweeps: 1 }),
    ]);
    rmSync(join(directory, "active.jsonl"), { force: true });
    write(
      join(root, ".harnery", "governor-service", "events.jsonl"),
      `${JSON.stringify({
        schema_version: 1,
        ts: "2026-08-29T09:59:00.000Z",
        event: "historical",
      })}\n${JSON.stringify({
        schema_version: 1,
        ts: "2026-08-29T10:00:00.000Z",
        event: "service.started",
        goals: 1,
      })}\n`,
    );

    const result = readGovernorServiceLogs(root);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toContain('"event":"historical"');
    expect(result.lines[1]).toContain('"event":"service.started"');
    expect(result.lines.join("\n").match(/service\.started/g)).toHaveLength(1);
  });

  test("tails an oversized legacy file within the aggregate byte ceiling", () => {
    process.env.HARNERY_SHARED_LOGS = "0";
    const root = fixture();
    write(
      join(root, ".harnery", "governor-service", "service.log"),
      `${"x".repeat(2_048)}\nlatest bounded line\n`,
    );
    const result = readGovernorServiceLogs(root, { max_bytes: 64, max_records: 10 });
    expect(result).toMatchObject({
      lines: ["latest bounded line"],
      bytes_read: 64,
      truncated: true,
    });
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-governor-service-read-"));
  roots.push(root);
  return root;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function sharedRecord(
  family: ReturnType<typeof createStorageCatalog>["families"][number],
  sequence: number,
  emittedAt: string,
  event: string,
  fields: HarneryLogRecordV1["fields"],
): Buffer {
  return encodeLogRecord(
    {
      schema: "harnery.log-record/v1",
      kind: "record",
      emitted_at: emittedAt,
      family_id: family.id,
      policy_version: family.policy.policy_version,
      component_id: "governor-service",
      level: "info",
      event,
      writer_id: "fixture",
      writer_seq: sequence,
      context: {},
      fields,
    },
    family,
  );
}
