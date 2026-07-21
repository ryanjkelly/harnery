import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowProof } from "harnery/core/workflow";
import { readWorkflowRun } from "./workflow-reader";

let root: string;
let runDir: string;

beforeEach(() => {
  root = join("/tmp", `workflow-reader-test-${process.pid}-${Date.now()}-${Math.random()}`);
  runDir = join(root, ".harnery", "workflows", "wf-reader");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "journal.jsonl"),
    `${JSON.stringify({ ts: "2026-07-21T12:00:00.000Z", event: "run.start", name: "reader" })}\n` +
      `${JSON.stringify({ ts: "2026-07-21T12:00:01.000Z", event: "run.end", ok: true })}\n`,
    "utf8",
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("workflow proof reader", () => {
  test("attaches a matching terminal proof packet to the journal summary", () => {
    writeFileSync(join(runDir, "proof.json"), JSON.stringify(sampleProof()), "utf8");
    const run = readWorkflowRun(root, "wf-reader");
    expect(run?.proof?.run.objective).toBe("Show proof in the dashboard");
    expect(run?.proof?.acceptance.summary.satisfied).toBe(1);
  });

  test("ignores malformed and mismatched packets without hiding the journal run", () => {
    writeFileSync(join(runDir, "proof.json"), "{bad", "utf8");
    expect(readWorkflowRun(root, "wf-reader")?.proof).toBeUndefined();
    writeFileSync(
      join(runDir, "proof.json"),
      JSON.stringify({ ...sampleProof(), run: { ...sampleProof().run, id: "wf-other" } }),
      "utf8",
    );
    expect(readWorkflowRun(root, "wf-reader")?.proof).toBeUndefined();
  });
});

function sampleProof(): WorkflowProof {
  return {
    schema_version: 1,
    run: {
      id: "wf-reader",
      name: "reader",
      status: "succeeded",
      started_at: "2026-07-21T12:00:00.000Z",
      ended_at: "2026-07-21T12:00:01.000Z",
      duration_ms: 1_000,
      objective: "Show proof in the dashboard",
    },
    acceptance: {
      criteria: [
        {
          id: "visible",
          statement: "Proof is visible",
          status: "satisfied",
          evidence_ids: ["e1"],
          sources: ["workflow"],
        },
      ],
      summary: { satisfied: 1, unsatisfied: 0, unknown: 0, total: 1 },
    },
    agents: [],
    evidence: [],
    repository: {
      source: "engine",
      before: { cwd: root, dirty_paths: [] },
      after: { cwd: root, dirty_paths: [] },
      drift: {
        branch_changed: false,
        head_changed: false,
        dirty_paths_added: [],
        dirty_paths_cleared: [],
        dirty_paths_retained: [],
        incomplete: false,
      },
    },
    harnesses: [],
    unknowns: [],
    integrity: { journal: { path: "journal.jsonl", sha256: "a".repeat(64), bytes: 10 } },
  };
}
