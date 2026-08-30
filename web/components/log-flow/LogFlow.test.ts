import { describe, expect, test } from "bun:test";
import type { HarneryLogRecordV1 } from "../../../src/core/storage/jsonl";
import { compactMarkers } from "./LogFlow";

describe("log flow marker compaction", () => {
  test("keeps dense lanes clickable by preserving a minimum time gap", () => {
    const records = Array.from({ length: 60 }, (_, index) => record(index * 2_000));

    const compacted = compactMarkers(records);

    expect(compacted.length).toBeLessThanOrEqual(12);
    for (let index = 1; index < compacted.length; index += 1) {
      const previous = Date.parse(compacted[index - 1]!.emitted_at);
      const current = Date.parse(compacted[index]!.emitted_at);
      expect(current - previous).toBeGreaterThanOrEqual(120_000 / 11);
    }
  });

  test("leaves sparse lanes unchanged", () => {
    const records = [record(0), record(30_000), record(60_000)];
    expect(compactMarkers(records)).toEqual(records);
  });
});

function record(offsetMs: number): HarneryLogRecordV1 {
  return {
    schema: "harnery.log-record/v1",
    kind: "record",
    emitted_at: new Date(Date.UTC(2026, 7, 30) + offsetMs).toISOString(),
    family_id: "supervisor-log",
    policy_version: "test",
    component_id: "supervisor",
    level: "info",
    event: "supervisor.sample",
    writer_id: "test",
    writer_seq: offsetMs + 1,
    context: {},
    fields: {},
  };
}
