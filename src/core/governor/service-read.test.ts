import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { processStartToken } from "../agents/state/proc-start.ts";
import { installedHarneryBuild } from "../events/v3/runtime-build.ts";
import { createStorageCatalog } from "../storage/catalog.ts";
import type { HarneryLogRecordV1 } from "../storage/jsonl.ts";
import { encodeLogRecord } from "../storage/jsonl.ts";
import { FileSegmentSink } from "../storage/segments.ts";
import type { GovernorServiceStatusRecord } from "./service.ts";
import {
  governorServiceLogPath,
  readGovernorServiceLogs,
  readGovernorServiceStatus,
} from "./service-read.ts";

const roots: string[] = [];
const originalSharedLogs = process.env.HARNERY_SHARED_LOGS;

afterEach(() => {
  if (originalSharedLogs === undefined) delete process.env.HARNERY_SHARED_LOGS;
  else process.env.HARNERY_SHARED_LOGS = originalSharedLogs;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("governor service status reader", () => {
  test("reports the generation and running build", () => {
    const root = fixture();
    const record = statusFixture(root);
    const status = readGovernorServiceStatus(root);
    expect(status).toMatchObject({
      running: true,
      liveness: "running",
      generation: "same",
      running_build: record.running_build,
      installed_build: installedHarneryBuild(),
      restart_needed: false,
      build_status: "current",
    });
  });

  test("a missing token or failed probe stays unknown", () => {
    const root = fixture();
    statusFixture(root, { start_token: undefined, running_build: undefined });
    expect(readGovernorServiceStatus(root)).toMatchObject({
      running: false,
      generation: "unknown",
      liveness: "unknown",
      running_build: null,
      restart_needed: true,
      build_status: "running build unknown; restart needed",
    });
    statusFixture(root);
    const dependencies = { readToken: () => null, probePid: () => true };
    expect(readGovernorServiceStatus(root, dependencies)).toMatchObject({
      running: false,
      generation: "unknown",
      liveness: "unknown",
    });
  });

  test("a reused PID is stopped without claiming the replacement is owned", () => {
    const root = fixture();
    statusFixture(root, { start_token: "different-generation" });
    expect(readGovernorServiceStatus(root)).toMatchObject({
      running: false,
      stale: true,
      generation: "different",
      liveness: "stopped",
    });
  });

  test("permission errors are unknown while ESRCH proves the process stopped", () => {
    const root = fixture();
    statusFixture(root);
    const permission = {
      probePid: () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
    };
    expect(readGovernorServiceStatus(root, permission)).toMatchObject({
      running: false,
      generation: "unknown",
      liveness: "unknown",
    });
    const gone = {
      probePid: () => {
        throw Object.assign(new Error("missing"), { code: "ESRCH" });
      },
    };
    expect(readGovernorServiceStatus(root, gone)).toMatchObject({
      running: false,
      liveness: "stopped",
    });
  });

  test("a foreign-host process remains unknown even with a fresh heartbeat", () => {
    const root = fixture();
    statusFixture(root, { host: `other-${hostname()}` });
    expect(readGovernorServiceStatus(root)).toMatchObject({
      running: false,
      generation: "unknown",
      liveness: "unknown",
    });
  });

  test("both package and source revision changes need a restart", () => {
    const root = fixture();
    const installed = installedHarneryBuild();
    statusFixture(root, { running_build: { ...installed, version: "older-version" } });
    expect(readGovernorServiceStatus(root)).toMatchObject({
      restart_needed: true,
      build_status: "restart needed",
    });
    statusFixture(root, { running_build: { ...installed, revision: "older-revision" } });
    expect(readGovernorServiceStatus(root)).toMatchObject({
      restart_needed: true,
      build_status: "restart needed",
    });
  });

  test("an unreadable status is unknown rather than absent", () => {
    const root = fixture();
    write(join(root, ".harnery", "governor-service", "status.json"), "{bad");
    expect(readGovernorServiceStatus(root)).toMatchObject({
      running: false,
      generation: "unknown",
      liveness: "unknown",
    });
  });
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

function statusFixture(root: string, overrides: Partial<GovernorServiceStatusRecord> = {}) {
  const now = new Date().toISOString();
  const record: GovernorServiceStatusRecord = {
    schema_version: 1,
    pid: process.pid,
    host: hostname(),
    nonce: "reader-fixture",
    state: "running",
    started_at: now,
    heartbeat_at: now,
    config_created_at: now,
    sweep_count: 0,
    start_token: processStartToken(process.pid) ?? undefined,
    running_build: installedHarneryBuild(),
    ...overrides,
  };
  write(join(root, ".harnery", "governor-service", "status.json"), JSON.stringify(record));
  return record;
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
