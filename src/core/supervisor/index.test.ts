import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkItem, readWorkItem } from "../work/index.ts";
import { resolveWorkflowApproval, type Spawner, type SpawnRequest } from "../workflow/index.ts";
import { createSupervisor, readSupervisor, runSupervisor } from "./index.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join("/tmp", "harnery-supervisor-"));
  roots.push(root);
  const passing = join(root, "passing.mjs");
  writeFileSync(
    passing,
    `
      export const meta = {
        name: "passing",
        acceptance: [{ id: "done", statement: "The assignment is complete" }],
      };
      export default async ({ agent, evidence }) => {
        const result = await agent("Complete the assignment", { specialist: "implementer" });
        evidence({ kind: "review", status: "passed", label: "verified", acceptanceIds: ["done"] });
        return result;
      };
    `,
  );
  const failing = join(root, "failing.mjs");
  writeFileSync(
    failing,
    `export default async () => { throw new Error("deterministic failure"); };\n`,
  );
  return { root, passing, failing };
}

const probeBilling = (harness: string) => ({
  harness,
  apiKeySource: null,
  apiKeyPresent: false,
  login: "present" as const,
  mode: "subscription" as const,
});

describe("durable goal supervisor", () => {
  test("freezes a private team intent and derives its static dependency graph", () => {
    const { root, passing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "leaf",
      title: "Leaf",
      objective: "Complete the prerequisite",
      workflowPath: passing,
    });
    createWorkItem({
      coordRoot: root,
      id: "root",
      title: "Root",
      objective: "Complete the goal",
      workflowPath: passing,
      dependencies: ["leaf"],
    });
    const record = createSupervisor({
      coordRoot: root,
      id: "goal-fixture",
      rootWorkId: "root",
      specialists: {
        implementer: { instructions: "Implement carefully", harness: "codex" },
      },
    });
    expect(record.projection.work_ids).toEqual(["leaf", "root"]);
    expect(record.projection.ready_work).toEqual(["leaf"]);
    expect(record.projection.specialists).toEqual(["implementer"]);
    expect(
      statSync(join(root, ".harnery", "supervisors", "goal-fixture", "intent.json")).mode & 0o777,
    ).toBe(0o600);
    expect(() =>
      createSupervisor({
        coordRoot: root,
        id: "goal-fixture",
        rootWorkId: "root",
        specialists: {},
      }),
    ).toThrow();
  });

  test("runs a specialist dependency chain to explicit policy-authorized success", async () => {
    const { root, passing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "leaf",
      title: "Leaf",
      objective: "Complete prerequisite",
      workflowPath: passing,
    });
    createWorkItem({
      coordRoot: root,
      id: "root",
      title: "Root",
      objective: "Complete goal",
      workflowPath: passing,
      dependencies: ["leaf"],
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-chain",
      rootWorkId: "root",
      specialists: {
        implementer: {
          instructions: "You are the implementation specialist. Keep changes focused.",
          harness: "codex",
          effort: "high",
        },
      },
      automation: { accept_passing_proof: true },
    });
    const requests: SpawnRequest[] = [];
    const spawner: Spawner = async (request) => {
      requests.push(request);
      return { ok: true, text: "done", durationMs: 1 };
    };
    const report = await runSupervisor({
      coordRoot: root,
      goalId: "goal-chain",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(report.stop_reason).toBe("succeeded");
    expect(report.dispatches).toBe(2);
    expect(report.acceptances).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.prompt).toStartWith("You are the implementation specialist");
    expect(readWorkItem(root, "leaf").projection.state).toBe("succeeded");
    expect(readWorkItem(root, "root").projection.state).toBe("succeeded");
    expect(readSupervisor(root, "goal-chain").projection.state).toBe("succeeded");
  });

  test("defaults to stopping for explicit review after passing proof", async () => {
    const { root, passing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "reviewed",
      title: "Reviewed",
      objective: "Wait for review",
      workflowPath: passing,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-review",
      rootWorkId: "reviewed",
      specialists: { implementer: { instructions: "Implement", harness: "codex" } },
    });
    const spawner: Spawner = async () => ({ ok: true, text: "done", durationMs: 1 });
    const report = await runSupervisor({
      coordRoot: root,
      goalId: "goal-review",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(report.stop_reason).toBe("awaiting_attention");
    expect(report.projection.next_action).toBe("review");
    expect(readWorkItem(root, "reviewed").projection.state).toBe("in_review");
  });

  test("stops for an approval and resumes the same attempt after resolution", async () => {
    const { root, passing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "approved",
      title: "Approved",
      objective: "Resume safely",
      workflowPath: passing,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-approval",
      rootWorkId: "approved",
      specialists: { implementer: { instructions: "Implement", harness: "codex" } },
      automation: { accept_passing_proof: true },
      limits: { max_total_attempts: 1 },
    });
    let spawns = 0;
    const spawner: Spawner = async () => {
      spawns++;
      return { ok: true, text: "done", durationMs: 1 };
    };
    const engine = {
      spawners: { codex: spawner },
      probeBilling,
      policy: { name: "approval", network: "ask" as const },
      networkAccess: "enabled" as const,
      approvalMode: "park" as const,
    };
    const parked = await runSupervisor({
      coordRoot: root,
      goalId: "goal-approval",
      engine,
    });
    expect(parked.stop_reason).toBe("awaiting_attention");
    expect(spawns).toBe(0);
    const pending = readWorkItem(root, "approved");
    expect(pending.projection.state).toBe("awaiting_approval");
    expect(pending.projection.attempts_used).toBe(1);
    const runId = pending.projection.latest_run_id;
    resolveWorkflowApproval({
      coordRoot: root,
      approvalId: pending.projection.approval_id!,
      verdict: "allow",
      actor: "reviewer",
    });
    const resumable = readSupervisor(root, "goal-approval");
    expect(resumable.projection.state).toBe("ready");
    expect(resumable.projection.attempts_remaining).toBe(0);
    const resumed = await runSupervisor({
      coordRoot: root,
      goalId: "goal-approval",
      engine,
    });
    expect(resumed.stop_reason).toBe("succeeded");
    expect(spawns).toBe(1);
    const complete = readWorkItem(root, "approved");
    expect(complete.projection.attempts_used).toBe(1);
    expect(complete.projection.latest_run_id).toBe(runId);
  });

  test("bounded retry is opt-in and still stops at the work attempt ceiling", async () => {
    const { root, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "failing",
      title: "Failing",
      objective: "Fail visibly",
      workflowPath: failing,
      maxAttempts: 2,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-retry",
      rootWorkId: "failing",
      specialists: {},
      automation: { retry_blocked: true },
      limits: { max_total_attempts: 5 },
    });
    const report = await runSupervisor({
      coordRoot: root,
      goalId: "goal-retry",
      engine: { spawners: {}, probeBilling },
    });
    expect(report.stop_reason).toBe("blocked");
    expect(report.dispatches).toBe(2);
    expect(readWorkItem(root, "failing").projection.attempts_used).toBe(2);
    expect(readWorkItem(root, "failing").projection.next_action).toBe("none");
  });

  test("graph-wide attempt budget prevents a ready dependent from launching", async () => {
    const { root, passing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "budget-leaf",
      title: "Budget leaf",
      objective: "Consume the only attempt",
      workflowPath: passing,
    });
    createWorkItem({
      coordRoot: root,
      id: "budget-root",
      title: "Budget root",
      objective: "Remain ready",
      workflowPath: passing,
      dependencies: ["budget-leaf"],
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-budget",
      rootWorkId: "budget-root",
      specialists: { implementer: { instructions: "Implement", harness: "codex" } },
      automation: { accept_passing_proof: true },
      limits: { max_total_attempts: 1 },
    });
    const spawner: Spawner = async () => ({ ok: true, text: "done", durationMs: 1 });
    const report = await runSupervisor({
      coordRoot: root,
      goalId: "goal-budget",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(report.stop_reason).toBe("budget_exhausted");
    expect(report.dispatches).toBe(1);
    expect(readWorkItem(root, "budget-leaf").projection.state).toBe("succeeded");
    expect(readWorkItem(root, "budget-root").projection.state).toBe("ready");
  });

  test("tick performs one cycle and leaves subsequent governance for another invocation", async () => {
    const { root, passing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "ticked",
      title: "Ticked",
      objective: "Advance once",
      workflowPath: passing,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-tick",
      rootWorkId: "ticked",
      specialists: { implementer: { instructions: "Implement", harness: "codex" } },
      automation: { accept_passing_proof: true },
    });
    const spawner: Spawner = async () => ({ ok: true, text: "done", durationMs: 1 });
    const first = await runSupervisor({
      coordRoot: root,
      goalId: "goal-tick",
      mode: "tick",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(first.stop_reason).toBe("tick_complete");
    expect(first.acceptances).toBe(0);
    expect(readWorkItem(root, "ticked").projection.state).toBe("in_review");
    const second = await runSupervisor({
      coordRoot: root,
      goalId: "goal-tick",
      mode: "tick",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(second.stop_reason).toBe("succeeded");
    expect(second.acceptances).toBe(1);
  });
});
