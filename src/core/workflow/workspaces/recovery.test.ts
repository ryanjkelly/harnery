import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkflowLiveness } from "./recovery.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(runId = "run"): { root: string; runId: string; runDir: string } {
  const root = join(tmpdir(), `harnery-recovery-${crypto.randomUUID()}`);
  const runDir = join(root, ".harnery", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  roots.push(root);
  return { root, runId, runDir };
}

function journal(runDir: string, records: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(runDir, "journal.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

describe("workspace recovery liveness", () => {
  test("treats durable reattachment failure as terminal without waiting for proof", () => {
    const { root, runId, runDir } = fixture();
    journal(runDir, [
      { event: "run.start", run_id: runId },
      { event: "run.parked", run_id: runId },
      { event: "run.resume", run_id: runId },
      { event: "workspace.reattach.failed", run_id: runId, status: "blocked" },
    ]);
    expect(readWorkflowLiveness(root, runId)).toBe("inactive");
  });

  test("fails closed on malformed terminal journal evidence", () => {
    const { root, runId, runDir } = fixture();
    journal(runDir, [
      { event: "run.start", run_id: runId },
      { event: "run.end", run_id: runId },
    ]);
    expect(readWorkflowLiveness(root, runId)).toBe("unknown");
  });

  test("rejects a minimally forged proof instead of treating the run as inactive", () => {
    const { root, runId, runDir } = fixture();
    writeFileSync(
      join(runDir, "proof.json"),
      `${JSON.stringify({ schema_version: 1, run: { id: runId, status: "succeeded" } })}\n`,
    );
    writeFileSync(join(runDir, "run.json"), "{}\n");
    expect(readWorkflowLiveness(root, runId)).toBe("unknown");
  });
});
