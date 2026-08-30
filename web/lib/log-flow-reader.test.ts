import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageCatalog } from "../../src/core/storage/catalog";
import type { HarneryLogRecordV1 } from "../../src/core/storage/jsonl";
import { encodeLogRecord } from "../../src/core/storage/jsonl";
import { FileSegmentSink } from "../../src/core/storage/segments";
import { readLogFlowSnapshot } from "./log-flow-reader";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("log flow reader", () => {
  test("isolates an invalid family while keeping healthy lanes visible", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-log-flow-"));
    roots.push(root);
    const catalog = createStorageCatalog({ coord_root: root });
    const healthy = catalog.require("resource-observer-log");
    const healthyDirectory = join(root, ".harnery", "logs", "resource-observer");
    await new FileSegmentSink({ directory: healthyDirectory, family: healthy }).append(
      [encodedRecord(healthy, "resource_observer.sample")],
      {},
      true,
    );

    const invalidDirectory = join(root, ".harnery", "logs", "web-performance");
    mkdirSync(invalidDirectory, { recursive: true });
    writeFileSync(join(invalidDirectory, "active.jsonl"), '{"schema":"legacy"}\n');

    const snapshot = readLogFlowSnapshot(root);
    expect(
      snapshot.lanes.find((lane) => lane.familyId === "resource-observer-log")?.records,
    ).toHaveLength(1);
    expect(snapshot.lanes.find((lane) => lane.familyId === "web-performance-log")?.error).toContain(
      "unsupported log record schema",
    );
    expect(snapshot.unavailableFamilies).toBe(1);
  });
});

function encodedRecord(
  family: ReturnType<typeof createStorageCatalog>["families"][number],
  event: string,
  sequence = 1,
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
