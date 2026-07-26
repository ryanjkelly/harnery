import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { WorkflowProof } from "harnery/core/workflow";
import { writeWorkflowRunManifest } from "harnery/core/workflow";
import {
  readWorkflowChildSessions,
  readWorkflowRun,
  readWorkflowRuns,
  resolveRunCoordRoot,
} from "./workflow-reader";

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

  test("keeps a run with a live child running however long the journal stays quiet", () => {
    // The failure this locks: liveness read from journal mtime alone, so an
    // agent working longer than STALE_MS badged the run STALE. The quiet is the
    // work, not a dead orchestrator.
    writeFileSync(
      join(runDir, "journal.jsonl"),
      `${JSON.stringify({ ts: "2026-07-21T12:00:00.000Z", event: "run.start", name: "reader" })}\n` +
        `${JSON.stringify({ ts: "2026-07-21T12:00:00.100Z", event: "agent.start", id: "a1", label: "slow" })}\n`,
      "utf8",
    );
    // Journal untouched for an hour, well past STALE_MS.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(join(runDir, "journal.jsonl"), hourAgo, hourAgo);
    expect(readWorkflowRun(root, "wf-reader")?.status).toBe("stale");

    writeHeartbeat("child-live", { workflow_run_id: "wf-reader", session_id: "s-live" });
    expect(readWorkflowRun(root, "wf-reader")?.status).toBe("running");

    // An ended child stops vouching for the run.
    writeHeartbeat("child-live", {
      workflow_run_id: "wf-reader",
      session_id: "s-live",
      ended_at: "2026-07-21T12:30:00.000Z",
    });
    expect(readWorkflowRun(root, "wf-reader")?.status).toBe("stale");
  });

  test("records the agent start and end timestamps a live elapsed timer needs", () => {
    writeFileSync(
      join(runDir, "journal.jsonl"),
      `${JSON.stringify({ ts: "2026-07-21T12:00:00.000Z", event: "run.start", name: "reader" })}\n` +
        `${JSON.stringify({ ts: "2026-07-21T12:00:00.100Z", event: "agent.start", id: "a1", label: "one" })}\n` +
        `${JSON.stringify({ ts: "2026-07-21T12:00:00.200Z", event: "agent.start", id: "a2", label: "two" })}\n` +
        `${JSON.stringify({ ts: "2026-07-21T12:00:09.000Z", event: "agent.failed", id: "a2", error: "boom" })}\n`,
      "utf8",
    );
    const agents = readWorkflowRun(root, "wf-reader")?.agents ?? [];
    expect(agents[0]).toMatchObject({
      id: "a1",
      status: "running",
      startedAt: "2026-07-21T12:00:00.100Z",
    });
    expect(agents[0]?.endedAt).toBeUndefined();
    expect(agents[1]).toMatchObject({
      id: "a2",
      status: "failed",
      startedAt: "2026-07-21T12:00:00.200Z",
      endedAt: "2026-07-21T12:00:09.000Z",
    });
  });

  test("unions live child heartbeats with journaled sessions and lets the journal name the agent", () => {
    writeFileSync(
      join(runDir, "journal.jsonl"),
      `${JSON.stringify({ ts: "2026-07-21T12:00:00.000Z", event: "run.start", name: "reader" })}\n` +
        `${JSON.stringify({ ts: "2026-07-21T12:00:00.100Z", event: "agent.start", id: "a1", label: "done-one" })}\n` +
        `${JSON.stringify({ ts: "2026-07-21T12:00:01.000Z", event: "agent.end", id: "a1", session_id: "s-ended" })}\n` +
        `${JSON.stringify({ ts: "2026-07-21T12:00:01.100Z", event: "agent.start", id: "a2", label: "in-flight" })}\n`,
      "utf8",
    );
    // A live child with no agent stamp, an unrelated run's child, and a live
    // heartbeat for the session the journal already closed.
    writeHeartbeat("live", { workflow_run_id: "wf-reader", session_id: "s-live" });
    writeHeartbeat("other", { workflow_run_id: "wf-other", session_id: "s-other" });
    writeHeartbeat("ended-but-warm", { workflow_run_id: "wf-reader", session_id: "s-ended" });

    const children = readWorkflowChildSessions(root, "wf-reader").sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId),
    );
    expect(children).toEqual([
      // Journal names the agent; the heartbeat still says it is running.
      { sessionId: "s-ended", agentId: "a1", live: true },
      { sessionId: "s-live", agentId: undefined, live: true },
    ]);
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

describe("run coord-root resolution", () => {
  test("follows the manifest cwd to the checkout that holds the child events", () => {
    // The sibling is a real checkout: it has its own `.harnery/`.
    const sibling = join(root, "..", `${basename(root)}-sibling`);
    mkdirSync(join(sibling, ".harnery"), { recursive: true });
    try {
      writeManifestWithCwd(join(sibling, "packages", "inner"));
      mkdirSync(join(sibling, "packages", "inner"), { recursive: true });

      // Resolution walks up from the cwd, so a subdirectory of the checkout
      // resolves to the checkout, not to itself.
      const resolved = resolveRunCoordRoot(root, "wf-reader");
      expect(resolved.foreign).toBe(true);
      expect(resolved.root).toBe(sibling);
      expect(resolved.fallback).toBeUndefined();
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test("stays local when the run ran here", () => {
    writeSharedManifest();
    const resolved = resolveRunCoordRoot(root, "wf-reader");
    expect(resolved).toMatchObject({ root, foreign: false });
    expect(resolved.fallback).toBeUndefined();
  });

  test("stays local when no checkout encloses the cwd within the walk limit", () => {
    // A cwd with no `.harnery/` above it is not a lost root: the run was
    // journaled here because the orchestrator's own root was here. The walk is
    // bounded, so a cwd buried deeper than the limit reads the same way, which
    // is what this fixture exercises (a shallower one would find the temp root).
    const deep = join(root, "a", "b", "c", "d", "e", "f", "g", "h", "i");
    mkdirSync(deep, { recursive: true });
    writeManifestWithCwd(deep);
    expect(resolveRunCoordRoot(root, "wf-reader")).toMatchObject({
      root,
      foreign: false,
      fallback: "no-coord-root",
    });
  });

  test("reports a deleted workspace distinctly, since its activity is unrecoverable", () => {
    writeManifestWithCwd(join(root, "workspaces", "ws-deleted"));
    expect(resolveRunCoordRoot(root, "wf-reader")).toMatchObject({
      root,
      foreign: false,
      fallback: "cwd-missing",
      recordedCwd: join(root, "workspaces", "ws-deleted"),
    });
  });

  test("falls back quietly when there is no manifest at all", () => {
    expect(resolveRunCoordRoot(root, "wf-reader")).toMatchObject({
      root,
      foreign: false,
      fallback: "no-cwd",
    });
  });

  test("the list judges liveness against the root a run executed in", () => {
    // Same defect as the STALE fix above, one checkout over: a run driven from a
    // sibling repo has no heartbeat here, so scanning only this root called a
    // working run dead.
    writeFileSync(
      join(runDir, "journal.jsonl"),
      `${JSON.stringify({ ts: "2026-07-21T12:00:00.000Z", event: "run.start", name: "reader" })}\n` +
        `${JSON.stringify({ ts: "2026-07-21T12:00:00.100Z", event: "agent.start", id: "a1", label: "slow" })}\n`,
      "utf8",
    );
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(join(runDir, "journal.jsonl"), hourAgo, hourAgo);

    const sibling = join(root, "..", `${basename(root)}-live`);
    mkdirSync(join(sibling, ".harnery", "active"), { recursive: true });
    try {
      writeManifestWithCwd(sibling);
      expect(readWorkflowRuns(root)[0]?.status).toBe("stale");

      writeFileSync(
        join(sibling, ".harnery", "active", "child.json"),
        JSON.stringify({ workflow_run_id: "wf-reader", session_id: "s-remote" }),
        "utf8",
      );
      expect(readWorkflowRuns(root)[0]?.status).toBe("running");
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test("reads child heartbeats from the run's own root", () => {
    const sibling = join(root, "..", `${basename(root)}-hb`);
    mkdirSync(join(sibling, ".harnery", "active"), { recursive: true });
    try {
      writeFileSync(
        join(sibling, ".harnery", "active", "child.json"),
        JSON.stringify({
          workflow_run_id: "wf-reader",
          workflow_agent_id: "a1",
          session_id: "s-remote",
        }),
        "utf8",
      );
      // Local scan sees nothing; pointed at the run's root it sees the child.
      expect(readWorkflowChildSessions(root, "wf-reader")).toEqual([]);
      expect(readWorkflowChildSessions(root, "wf-reader", { heartbeatRoot: sibling })).toEqual([
        { sessionId: "s-remote", agentId: "a1", live: true },
      ]);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});

/** A manifest whose recorded execution cwd is `cwd`, everything else minimal. */
function writeManifestWithCwd(cwd: string): void {
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ execution: { cwd } }), "utf8");
}

/** One `.harnery/active/` heartbeat file, the shape the reader's child-session
 * scan consumes. */
function writeHeartbeat(
  name: string,
  hb: { workflow_run_id: string; session_id: string; workflow_agent_id?: string; ended_at?: string },
): void {
  const dir = join(root, ".harnery", "active");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(hb), "utf8");
}

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
