import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendWorkflowJournalEvent,
  fitWorkflowJournalRecord,
  WORKFLOW_JOURNAL_EVENT_BYTES,
  WORKFLOW_JOURNAL_OMITTED,
  workflowJournalPath,
} from "./journal.ts";

const envelope = {
  schema_version: 1,
  run_id: "wf-test",
  ts: "2026-07-25T00:00:00.000Z",
  event: "e",
};

describe("workflow journal records", () => {
  test("a record that fits is written unchanged", () => {
    const record = fitWorkflowJournalRecord(envelope, { id: "a1", result: "short" });
    expect(record.result).toBe("short");
    expect(record[WORKFLOW_JOURNAL_OMITTED]).toBeUndefined();
  });

  test("an oversized field is dropped for a digest instead of raising", () => {
    const big = "x".repeat(25_000); // the largest real record observed in production
    const record = fitWorkflowJournalRecord(envelope, { id: "a1", result: big });
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(
      WORKFLOW_JOURNAL_EVENT_BYTES,
    );
    expect(record.result).toBeUndefined();
    expect(record.id).toBe("a1"); // small fields survive
    expect(record.event).toBe("e"); // the envelope is never dropped
    const omitted = record[WORKFLOW_JOURNAL_OMITTED] as Array<Record<string, unknown>>;
    expect(omitted).toHaveLength(1);
    expect(omitted[0].field).toBe("result");
    expect(omitted[0].bytes).toBeGreaterThan(WORKFLOW_JOURNAL_EVENT_BYTES);
    expect(omitted[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("the largest field goes first, so smaller detail survives", () => {
    const record = fitWorkflowJournalRecord(envelope, {
      small: "keep me",
      huge: "x".repeat(30_000),
      medium: "y".repeat(200),
    });
    expect(record.small).toBe("keep me");
    expect(record.medium).toBe("y".repeat(200));
    expect(record.huge).toBeUndefined();
  });

  test("a valid maximum-size run.start is written rather than failing the run", () => {
    // Harnery's own validators permit a 4 KiB objective plus 50 acceptance
    // strings, which together exceed the record limit. Refusing that record
    // would make a valid workflow fail on its opening line.
    const root = mkdtempSync(join(tmpdir(), "harnery-journal-"));
    try {
      appendWorkflowJournalEvent(root, "wf-test", "run.start", {
        work_context: {
          objective: "o".repeat(4_000),
          acceptance: Array.from({ length: 50 }, (_, i) => `criterion ${i} ${"c".repeat(500)}`),
        },
      });
      const lines = readFileSync(workflowJournalPath(root, "wf-test"), "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(Buffer.byteLength(lines[0])).toBeLessThanOrEqual(WORKFLOW_JOURNAL_EVENT_BYTES);
      expect(JSON.parse(lines[0]).event).toBe("run.start");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
