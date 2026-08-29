import { describe, expect, test } from "bun:test";
import { createStorageCatalog } from "./catalog.ts";
import {
  encodeLogRecord,
  type HarneryLogRecordV1,
  parseLogRecord,
  toOpenTelemetryLogRecord,
  validateLogFields,
} from "./jsonl.ts";

const family = createStorageCatalog({ coord_root: "/tmp/harnery-jsonl-test" }).require(
  "agent-hook-debug-log",
);

describe("structured JSONL", () => {
  test("rejects forbidden and non-bounded field shapes", () => {
    expect(() => validateLogFields({ prompt: "secret" }, family.policy)).toThrow("private field");
    expect(() => validateLogFields({ values: ["one", 2] }, family.policy)).toThrow("heterogeneous");
  });

  test("round-trips one canonical record and maps to OpenTelemetry", () => {
    const record: HarneryLogRecordV1 = {
      schema: "harnery.log-record/v1",
      kind: "record",
      emitted_at: "2026-08-29T00:00:00.000Z",
      family_id: family.id,
      policy_version: family.policy.policy_version,
      component_id: "agent-hook",
      level: "warn",
      event: "hook.canary",
      writer_id: "writer",
      writer_seq: 1,
      context: { session_id: "one" },
      fields: { count: 2 },
    };
    const parsed = parseLogRecord(encodeLogRecord(record, family).toString("utf8"));
    expect(parsed.event).toBe("hook.canary");
    expect(toOpenTelemetryLogRecord(parsed).severityText).toBe("WARN");
  });
});
