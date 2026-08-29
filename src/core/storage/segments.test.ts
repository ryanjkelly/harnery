import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageCatalog } from "./catalog.ts";
import { encodeLogRecord, type HarneryLogRecordV1 } from "./jsonl.ts";
import { queryLogs, readLogFollow, rotationFollowCursor } from "./query.ts";
import { FileSegmentSink, HarneryLogLeaseError, readSegmentManifest } from "./segments.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shared log segments and query", () => {
  test("rotates through a sealed manifest and queries with global budgets", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-segments-"));
    roots.push(root);
    const family = createStorageCatalog({ coord_root: root }).require("agent-hook-debug-log");
    const directory = join(root, ".harnery", "logs", "agent-hook-debug");
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    await sink.append([record(family, 1, "first")]);
    await sink.append([record(family, 2, "second")]);
    expect(readSegmentManifest(directory, family).segments).toHaveLength(1);
    const result = await queryLogs([family], { max_records: 10, max_bytes: 100_000 });
    expect(result.records.map((item) => item.event)).toEqual(["first", "second"]);
    const bounded = await queryLogs([family], { max_records: 1, max_bytes: 100_000 });
    expect(bounded.truncated).toBeTrue();
  });

  test("follows an active file across rotation and rejects a wrong-type lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-follow-"));
    roots.push(root);
    const family = createStorageCatalog({ coord_root: root }).require("agent-hook-debug-log");
    const directory = join(root, ".harnery", "logs", "agent-hook-debug");
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    await sink.append([record(family, 1, "first")]);
    const cursor = rotationFollowCursor(family);
    await sink.append([record(family, 2, "second")]);
    const followed = await readLogFollow(family, cursor, 100_000);
    expect(followed.rotated).toBeTrue();
    expect(followed.records[0]?.event).toBe("second");
    writeFileSync(join(directory, ".append-lease"), "wrong type");
    await expect(sink.append([record(family, 3, "third")])).rejects.toBeInstanceOf(
      HarneryLogLeaseError,
    );
    expect(readFileSync(join(directory, "active.jsonl"), "utf8")).toContain("second");
  });
});

function record(
  family: ReturnType<typeof createStorageCatalog>["families"][number],
  sequence: number,
  event: string,
): Buffer {
  const value: HarneryLogRecordV1 = {
    schema: "harnery.log-record/v1",
    kind: "record",
    emitted_at: new Date(sequence * 1_000).toISOString(),
    family_id: family.id,
    policy_version: family.policy.policy_version,
    component_id: "canary",
    level: "info",
    event,
    writer_id: "writer",
    writer_seq: sequence,
    context: {},
    fields: {},
  };
  return encodeLogRecord(value, family);
}
