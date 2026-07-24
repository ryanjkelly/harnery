import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowProof } from "harnery/core/workflow";
import { writeWorkflowRunManifest } from "harnery/core/workflow";
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
  test("keeps a durable approval park distinct from stale and clears it on resume", () => {
    writeFileSync(
      join(runDir, "journal.jsonl"),
      `${JSON.stringify({ ts: "2026-07-21T12:00:00.000Z", event: "run.start", name: "reader" })}\n` +
        `${JSON.stringify({ ts: "2026-07-21T12:00:01.000Z", event: "run.parked", approval_id: "apr-123" })}\n`,
      "utf8",
    );
    expect(readWorkflowRun(root, "wf-reader")).toMatchObject({
      status: "parked",
      parkedApprovalId: "apr-123",
    });
    writeFileSync(
      join(runDir, "journal.jsonl"),
      `${JSON.stringify({ ts: "2026-07-21T12:00:02.000Z", event: "run.resume" })}\n`,
      { encoding: "utf8", flag: "a" },
    );
    expect(readWorkflowRun(root, "wf-reader")?.status).toBe("running");
  });

  test("attaches a matching terminal proof packet to the journal summary", () => {
    writeFileSync(join(runDir, "proof.json"), JSON.stringify(sampleProof()), "utf8");
    const run = readWorkflowRun(root, "wf-reader");
    expect(run?.proof?.run.objective).toBe("Show proof in the dashboard");
    expect(run?.proof?.acceptance.summary.satisfied).toBe(1);
    expect(run?.proof?.policy?.decisions[0]?.verdict).toBe("allow");
  });

  test("uses total retry cost instead of only the final attempt cost", () => {
    writeFileSync(
      join(runDir, "journal.jsonl"),
      `${JSON.stringify({ ts: "2026-07-21T12:00:00.000Z", event: "run.start", name: "reader" })}\n` +
        `${JSON.stringify({ ts: "2026-07-21T12:00:00.100Z", event: "agent.start", id: "a1", label: "retry" })}\n` +
        `${JSON.stringify({ ts: "2026-07-21T12:00:01.000Z", event: "agent.end", id: "a1", cost_usd: 0.2, total_cost_usd: 0.45 })}\n` +
        `${JSON.stringify({ ts: "2026-07-21T12:00:02.000Z", event: "run.end", ok: true })}\n`,
      "utf8",
    );
    const run = readWorkflowRun(root, "wf-reader");
    expect(run?.costUsd).toBe(0.45);
    expect(run?.agents[0]?.costUsd).toBe(0.45);
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

  test("attaches the validated workspace projection and preserves invalid authority", () => {
    writeSharedManifest();
    writeFileSync(join(runDir, "proof.json"), JSON.stringify(sampleProof()), "utf8");
    expect(readWorkflowRun(root, "wf-reader")?.workspace).toMatchObject({
      ok: true,
      value: {
        selection: "shared",
        requested_isolation: "shared",
        effective_isolation: "shared",
      },
    });

    writeFileSync(join(runDir, "proof.json"), "{bad", "utf8");
    expect(readWorkflowRun(root, "wf-reader")?.workspace).toMatchObject({
      ok: false,
      run_id: "wf-reader",
    });
  });
});

function writeSharedManifest(): void {
  writeWorkflowRunManifest({
    coordRoot: root,
    manifest: {
      schema_version: 1,
      run_id: "wf-reader",
      name: "reader",
      started_at: "2026-07-21T12:00:00.000Z",
      script: { path: join(root, "workflow.mjs"), sha256: "b".repeat(64) },
      repository_before: { cwd: root, dirty_paths: [] },
      execution: {
        cwd: root,
        default_harness: "claude-code",
        max_agents: 1,
        concurrency: 1,
        subscription_only: false,
        allow_api_billing: false,
        approval_mode: "deny",
        approval_addressee: "operator",
        isolation: "shared",
        network_access: "unknown",
      },
    },
  });
}

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
    policy: {
      schema_version: 1,
      name: "dashboard policy",
      sha256: "b".repeat(64),
      isolation: "worktree",
      network_access: "enabled",
      config: {
        schema_version: 1,
        name: "dashboard policy",
        unknown_cost: "deny",
        network: "allow",
        external_actions: "deny",
      },
      decisions: [
        {
          id: "p1",
          checked_at: "2026-07-21T12:00:00.500Z",
          policy: "dashboard policy",
          phase: "dispatch",
          initial_verdict: "allow",
          verdict: "allow",
          resolved_by: "policy",
          reason: "all configured rules allow",
          rule_codes: ["policy_allow"],
          request: {
            phase: "dispatch",
            action: "spawn agent",
            isolation: "worktree",
            network_access: "enabled",
          },
        },
      ],
      summary: { allowed: 1, denied: 0, asked: 0, total: 1 },
    },
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
