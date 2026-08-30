import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageCatalog } from "../storage/catalog.ts";
import type { HarneryLogRecordV1 } from "../storage/jsonl.ts";
import { encodeLogRecord } from "../storage/jsonl.ts";
import { FileSegmentSink } from "../storage/segments.ts";
import { SupervisorLogCollector } from "./log-feed.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("supervisor log collector", () => {
  test("seeds recent records and follows only appended complete records", async () => {
    const root = mkdtempSync(join(tmpdir(), "harn-supervisor-logs-"));
    roots.push(root);
    const family = createStorageCatalog({ coord_root: root }).require("supervisor-log");
    const sink = new FileSegmentSink({
      directory: join(root, ".harnery", "logs", "supervisor"),
      family,
    });
    await sink.append([encodedRecord(family, "supervisor.started", 1)], {}, true);
    const collector = new SupervisorLogCollector(root);
    const first = await collector.collect(new Date("2026-08-30T12:00:00.000Z"));
    expect(first.lanes.find((lane) => lane.family_id === "supervisor-log")?.records).toHaveLength(
      1,
    );
    await sink.append([encodedRecord(family, "supervisor.sample", 2)], {}, true);
    const second = await collector.collect(new Date("2026-08-30T12:00:02.000Z"));
    expect(
      second.lanes
        .find((lane) => lane.family_id === "supervisor-log")
        ?.records.map((row) => row.event),
    ).toEqual(["supervisor.started", "supervisor.sample"]);
    expect(second.sequence).toBeGreaterThan(first.sequence);
  });
});

function encodedRecord(
  family: ReturnType<typeof createStorageCatalog>["families"][number],
  event: string,
  sequence: number,
): Buffer {
  const value: HarneryLogRecordV1 = {
    schema: "harnery.log-record/v1",
    kind: "record",
    emitted_at: new Date().toISOString(),
    family_id: family.id,
    policy_version: family.policy.policy_version,
    component_id: "test",
    level: "info",
    event,
    writer_id: "test-writer",
    writer_seq: sequence,
    context: {},
    fields: {},
  };
  return encodeLogRecord(value, family);
}
