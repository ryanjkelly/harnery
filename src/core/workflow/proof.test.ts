import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorkflowProof,
  createEvidenceRecord,
  deriveRunFailureClass,
  normalizeWorkflowMeta,
  readWorkflowProof,
  renderWorkflowProof,
  rollupAcceptance,
  writeWorkflowProof,
} from "./proof.ts";
import type { WorkflowAgentProof, WorkflowProof } from "./types.ts";

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

describe("harness attestation citation (ADR 0038)", () => {
  const snapshot = { cwd: "/repo", dirty_paths: [] as string[] };
  function journal(): string {
    const path = join(root, ".harnery", "workflows", "wf-test", "journal.jsonl");
    writeFileSync(path, "{}\n");
    return path;
  }
  const baseInput = {
    runId: "wf-attest",
    meta: { name: "attest", acceptance: [] },
    status: "succeeded" as const,
    startedAt: "2026-07-24T19:00:00.000Z",
    endedAt: "2026-07-24T19:00:01.000Z",
    durationMs: 1_000,
    journalPath: "",
    before: snapshot,
    after: snapshot,
    evidence: [],
    agents: [
      {
        id: "a1",
        label: "probe",
        harness: "claude-code",
        status: "succeeded" as const,
        attempts: 1,
        duration_ms: 10,
        session_id: "s-1",
        cost_usd: 0.01,
      },
    ],
    harnessEvidence: { "claude-code": { toolEvidence: { support: "unsupported" as const } } },
  };

  test("a run cites the attestation backing the harness it used", () => {
    const proof = buildWorkflowProof({
      ...baseInput,
      journalPath: journal(),
      harnessAttestations: {
        "claude-code": {
          binary_version: "2.1.197",
          observed_at: "2026-07-24T19:00:00.000Z",
          record_digest: "abc123",
        },
      },
    });
    expect(proof.harnesses[0]?.attestation).toEqual({
      binary_version: "2.1.197",
      observed_at: "2026-07-24T19:00:00.000Z",
      record_digest: "abc123",
    });
  });

  test("no attestation means no citation and no new unknown", () => {
    const proof = buildWorkflowProof({ ...baseInput, journalPath: journal() });
    expect(proof.harnesses[0]?.attestation).toBeUndefined();
    // Deliberate: an unattested host must not have every run gated on a new
    // unknown it cannot clear without spending tokens.
    expect(proof.unknowns.map((item) => item.code)).toEqual(["tool_evidence_unavailable"]);
  });

  test("a citation for an unused harness is not attached", () => {
    const proof = buildWorkflowProof({
      ...baseInput,
      journalPath: journal(),
      harnessAttestations: {
        cursor: { binary_version: "x", observed_at: "y", record_digest: "z" },
      },
    });
    expect(proof.harnesses).toHaveLength(1);
    expect(proof.harnesses[0]?.attestation).toBeUndefined();
  });
});

describe("sandbox projection evidence (ADR 0039)", () => {
  const snapshot = { cwd: "/repo", dirty_paths: [] as string[] };
  function journalFile(): string {
    const path = join(root, ".harnery", "workflows", "wf-test", "journal.jsonl");
    writeFileSync(path, "{}\n");
    return path;
  }
  const input = {
    runId: "wf-projection",
    meta: { name: "projection", acceptance: [] },
    status: "succeeded" as const,
    startedAt: "2026-07-25T00:00:00.000Z",
    endedAt: "2026-07-25T00:00:01.000Z",
    durationMs: 1_000,
    before: snapshot,
    after: snapshot,
    evidence: [],
    agents: [],
  };

  test("an applied projection is recorded so the run can be audited", () => {
    const proof = buildWorkflowProof({
      ...input,
      journalPath: journalFile(),
      sandboxProjection: {
        mode: "workspace-write",
        writable_roots: ["/srv/ws/repo/.git"],
        git_grant: "shared-repository",
      },
    });
    expect(proof.sandbox_projection).toEqual({
      mode: "workspace-write",
      writable_roots: ["/srv/ws/repo/.git"],
      git_grant: "shared-repository",
    });
  });

  test("no projection leaves the field absent rather than empty", () => {
    const proof = buildWorkflowProof({ ...input, journalPath: journalFile() });
    expect(proof.sandbox_projection).toBeUndefined();
  });
});

describe("run failure class derivation (ADR 0046)", () => {
  function agent(
    status: WorkflowAgentProof["status"],
    cls?: "environment" | "upstream",
  ): WorkflowAgentProof {
    return {
      id: "a",
      label: "worker",
      harness: "codex",
      status,
      attempts: 1,
      duration_ms: 1,
      ...(cls ? { class: cls } : {}),
    };
  }

  test("a succeeded run is never classed", () => {
    expect(deriveRunFailureClass("succeeded", [agent("failed", "environment")])).toBeUndefined();
  });

  test("all agents failed on a missing binary -> environment", () => {
    expect(deriveRunFailureClass("failed", [agent("failed", "environment")])).toBe("environment");
  });

  test("a failed run whose agents refused upstream -> upstream", () => {
    expect(deriveRunFailureClass("failed", [agent("failed", "upstream")])).toBe("upstream");
  });

  test("environment wins over upstream when both are present", () => {
    // A missing binary means nothing ran at all; it is the operator-chosen hard
    // stop, so it takes precedence over a co-occurring upstream refusal.
    expect(
      deriveRunFailureClass("failed", [
        agent("failed", "upstream"),
        agent("failed", "environment"),
      ]),
    ).toBe("environment");
  });

  test("any productive segment charges the attempt (resumed-run protection)", () => {
    // If any agent produced a result the attempt WAS informative about the work,
    // even if a later agent hit a missing binary. Charge it — default-to-charging.
    expect(
      deriveRunFailureClass("failed", [agent("succeeded"), agent("failed", "environment")]),
    ).toBeUndefined();
    expect(
      deriveRunFailureClass("failed", [agent("cached"), agent("failed", "upstream")]),
    ).toBeUndefined();
  });

  test("an unclassed failure defaults to charged", () => {
    // The safety property: anything not positively environment/upstream charges.
    expect(deriveRunFailureClass("failed", [agent("failed")])).toBeUndefined();
    expect(deriveRunFailureClass("failed", [])).toBeUndefined();
  });
});

describe("run-level class in the proof packet (ADR 0046)", () => {
  const snapshot = { cwd: "/repo", dirty_paths: [] as string[] };
  function journalFile(): string {
    const path = join(root, ".harnery", "workflows", "wf-test", "journal.jsonl");
    writeFileSync(path, "{}\n");
    return path;
  }
  const failing = {
    runId: "wf-class",
    meta: { name: "classed", acceptance: [] },
    status: "failed" as const,
    startedAt: "2026-07-25T00:00:00.000Z",
    endedAt: "2026-07-25T00:00:01.000Z",
    durationMs: 1_000,
    before: snapshot,
    after: snapshot,
    evidence: [],
    error: "agent worker: codex not found on PATH",
  };

  test("a failed run whose only agent hit a missing binary records run.class environment", () => {
    const proof = buildWorkflowProof({
      ...failing,
      journalPath: journalFile(),
      agents: [
        {
          id: "a1",
          label: "worker",
          harness: "codex",
          status: "failed",
          attempts: 1,
          duration_ms: 1,
          class: "environment",
        },
      ],
    });
    expect(proof.run.class).toBe("environment");
  });

  test("a failed run with no classifiable agent leaves run.class absent (charged)", () => {
    const proof = buildWorkflowProof({
      ...failing,
      journalPath: journalFile(),
      agents: [
        {
          id: "a1",
          label: "worker",
          harness: "codex",
          status: "failed",
          attempts: 1,
          duration_ms: 1,
        },
      ],
    });
    expect(proof.run.class).toBeUndefined();
  });

  test("readWorkflowProof rejects a proof carrying an unknown run.class", () => {
    const path = join(root, ".harnery", "workflows", "wf-test", "proof.json");
    const proof = sampleProof();
    (proof.run as Record<string, unknown>).class = "bogus";
    writeFileSync(path, `${JSON.stringify(proof)}\n`, "utf8");
    expect(() => readWorkflowProof(root, "wf-test")).toThrow(/schema/);
  });

  test("a pre-ADR-0046 proof with no run.class still reads (back-compat)", () => {
    // The live coord root holds proofs written before the field existed; they
    // must load unchanged and read as charged.
    const path = join(root, ".harnery", "workflows", "wf-test", "proof.json");
    const proof = sampleProof();
    expect("class" in proof.run).toBe(false);
    writeFileSync(path, `${JSON.stringify(proof)}\n`, "utf8");
    expect(readWorkflowProof(root, "wf-test").run.class).toBeUndefined();
  });
});
