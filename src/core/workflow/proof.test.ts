import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEvidenceRecord,
  normalizeWorkflowMeta,
  readWorkflowProof,
  renderWorkflowProof,
  rollupAcceptance,
  writeWorkflowProof,
} from "./proof.ts";
import type { WorkflowProof } from "./types.ts";

let root: string;

beforeEach(() => {
  const tempRoot = process.platform === "linux" ? "/tmp" : tmpdir();
  root = join(tempRoot, `workflow-proof-test-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(join(root, ".harnery", "workflows", "wf-test"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("workflow proof contract", () => {
  test("normalizes criteria and rejects duplicate or malformed ids", () => {
    expect(
      normalizeWorkflowMeta(
        {
          name: " proof ",
          objective: " objective ",
          acceptance: [{ id: "tests-pass", statement: " Tests pass " }],
        },
        "fallback",
      ),
    ).toEqual({
      name: "proof",
      objective: "objective",
      acceptance: [{ id: "tests-pass", statement: "Tests pass" }],
      description: undefined,
    });
    expect(() =>
      normalizeWorkflowMeta(
        {
          name: "proof",
          acceptance: [
            { id: "same", statement: "One" },
            { id: "same", statement: "Two" },
          ],
        },
        "fallback",
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      normalizeWorkflowMeta(
        { name: "proof", acceptance: [{ id: "not valid", statement: "No" }] },
        "fallback",
      ),
    ).toThrow(/must match/);
  });

  test("evidence is bounded, source-stamped, and cannot cite undeclared acceptance", () => {
    const record = createEvidenceRecord({
      value: {
        kind: "test",
        status: "passed",
        label: "Focused suite",
        acceptanceIds: ["tests", "tests"],
      },
      sequence: 1,
      acceptanceIds: new Set(["tests"]),
      stage: "verify",
      recordedAt: "2026-07-21T12:00:00.000Z",
    });
    expect(record).toMatchObject({
      id: "e1",
      source: "workflow",
      stage: "verify",
      acceptance_ids: ["tests"],
    });
    expect(() =>
      createEvidenceRecord({
        value: {
          kind: "test",
          status: "passed",
          label: "Unknown criterion",
          acceptanceIds: ["missing"],
        },
        sequence: 2,
        acceptanceIds: new Set(["tests"]),
      }),
    ).toThrow(/unknown acceptance id/);
    expect(() =>
      createEvidenceRecord({
        value: { kind: "test", status: "passed", label: "One too many" },
        sequence: 201,
        acceptanceIds: new Set(),
      }),
    ).toThrow(/exceeds 200/);
  });

  test("failed evidence wins; observed evidence alone leaves acceptance unknown", () => {
    const criteria = [
      { id: "a", statement: "A" },
      { id: "b", statement: "B" },
      { id: "c", statement: "C" },
    ];
    const base = {
      source: "workflow" as const,
      recorded_at: "2026-07-21T12:00:00.000Z",
      kind: "test" as const,
      label: "check",
    };
    const rolled = rollupAcceptance(criteria, [
      { ...base, id: "e1", status: "passed", acceptance_ids: ["a", "b"] },
      { ...base, id: "e2", status: "failed", acceptance_ids: ["b"] },
      { ...base, id: "e3", status: "observed", acceptance_ids: ["c"] },
    ]);
    expect(rolled.criteria.map((item) => item.status)).toEqual([
      "satisfied",
      "unsatisfied",
      "unknown",
    ]);
    expect(rolled.summary).toEqual({ satisfied: 1, unsatisfied: 1, unknown: 1, total: 3 });
  });

  test("writes, reads, validates, and renders a version-1 proof-only packet", () => {
    const path = join(root, ".harnery", "workflows", "wf-test", "proof.json");
    const proof = sampleProof();
    writeWorkflowProof(path, proof);
    expect(readWorkflowProof(root, "wf-test")).toEqual(proof);
    expect(renderWorkflowProof(proof)).toContain("PASS tests: Tests pass [e1]");
    expect(() => readWorkflowProof(root, "../escape")).toThrow(/invalid workflow run id/);
  });
});

function sampleProof(): WorkflowProof {
  return {
    schema_version: 1,
    run: {
      id: "wf-test",
      name: "sample",
      status: "succeeded",
      started_at: "2026-07-21T12:00:00.000Z",
      ended_at: "2026-07-21T12:00:01.000Z",
      duration_ms: 1_000,
    },
    acceptance: {
      criteria: [
        {
          id: "tests",
          statement: "Tests pass",
          status: "satisfied",
          evidence_ids: ["e1"],
          sources: ["workflow"],
        },
      ],
      summary: { satisfied: 1, unsatisfied: 0, unknown: 0, total: 1 },
    },
    agents: [],
    evidence: [
      {
        id: "e1",
        source: "workflow",
        recorded_at: "2026-07-21T12:00:00.500Z",
        kind: "test",
        status: "passed",
        label: "Focused suite",
        acceptance_ids: ["tests"],
      },
    ],
    repository: {
      source: "engine",
      before: { cwd: "/tmp/project", dirty_paths: [] },
      after: { cwd: "/tmp/project", dirty_paths: [] },
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
