import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkItem, readWorkItem } from "../work/index.ts";
import { resolveWorkflowApproval, type Spawner, type SpawnRequest } from "../workflow/index.ts";
import {
  approveSupervisorPlan,
  createSupervisor,
  readSupervisor,
  readSupervisorPlan,
  rejectSupervisorPlan,
  runSupervisor,
} from "./index.ts";

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

  test("does not use replanning to bypass an exhausted goal-wide attempt budget", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "replan-budget-root",
      title: "Replan budget root",
      objective: "Keep the goal-wide attempt ceiling authoritative",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-replan-budget",
      rootWorkId: "replan-budget-root",
      specialists: { planner: { instructions: "Plan", harness: "codex" } },
      limits: { max_total_attempts: 1 },
      replanning: {
        plannerSpecialist: "planner",
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    let plannerCalls = 0;
    const report = await runSupervisor({
      coordRoot: root,
      goalId: "goal-replan-budget",
      engine: {
        spawners: {
          codex: async () => {
            plannerCalls++;
            return { ok: true, text: replacementProposal(), durationMs: 1 };
          },
        },
        probeBilling,
      },
    });
    expect(report.stop_reason).toBe("budget_exhausted");
    expect(report.projection.attempts_remaining).toBe(0);
    expect(report.projection.replans_used).toBe(0);
    expect(plannerCalls).toBe(0);
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

  test("proposes a bounded replacement graph and waits for explicit approval by default", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "blocked-root",
      title: "Blocked root",
      objective: "Complete the goal despite a terminal approach",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-replan-review",
      rootWorkId: "blocked-root",
      specialists: {
        planner: { instructions: "Design a minimal recovery graph", harness: "codex" },
        implementer: { instructions: "Implement the approved recovery", harness: "codex" },
      },
      automation: { accept_passing_proof: true },
      replanning: {
        plannerSpecialist: "planner",
        templates: { repair: { workflowPath: passing, maxAttempts: 1, root: true } },
      },
    });
    let plannerCalls = 0;
    const spawner: Spawner = async (request) => {
      if (request.prompt.includes("bounded replacement plan")) {
        plannerCalls++;
        return { ok: true, text: replacementProposal(), durationMs: 1 };
      }
      return { ok: true, text: "implemented", durationMs: 1 };
    };
    const first = await runSupervisor({
      coordRoot: root,
      goalId: "goal-replan-review",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(first.stop_reason).toBe("awaiting_attention");
    expect(first.replans).toBe(1);
    expect(first.projection.next_action).toBe("review_plan");
    expect(plannerCalls).toBe(1);
    const planId = first.projection.pending_plan_id!;
    expect(readSupervisorPlan(root, "goal-replan-review", planId).status).toBe("proposed");
    expect(
      statSync(
        join(
          root,
          ".harnery",
          "supervisors",
          "goal-replan-review",
          "plans",
          planId,
          "proposal.json",
        ),
      ).mode & 0o777,
    ).toBe(0o600);

    // Simulate a process loss after the first deterministic work intent was
    // materialized but before plan.applied reached the audit log.
    createWorkItem({
      coordRoot: root,
      id: `${planId}-repair`,
      title: "Repair the goal",
      objective: "Complete the original goal through the approved recovery workflow",
      acceptance: ["The original goal is complete"],
      dependencies: [],
      workflowPath: passing,
      maxAttempts: 1,
      source: { kind: "workflow", ref: `supervisor:goal-replan-review/plan:${planId}` },
      actor: "recovery-fixture",
    });

    const applied = approveSupervisorPlan({
      coordRoot: root,
      goalId: "goal-replan-review",
      planId,
      actor: "reviewer",
      reason: "replacement graph is scoped and auditable",
    });
    expect(applied.status).toBe("applied");
    const replaced = readSupervisor(root, "goal-replan-review");
    expect(replaced.projection.root_work_id).toBe(`${planId}-repair`);
    expect(replaced.projection.plan_generation).toBe(1);
    expect(replaced.projection.attempts_used).toBe(1);
    expect(replaced.projection.governed_work_ids).toContain("blocked-root");

    const completed = await runSupervisor({
      coordRoot: root,
      goalId: "goal-replan-review",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(completed.stop_reason).toBe("succeeded");
    expect(completed.projection.attempts_used).toBe(2);
    expect(readWorkItem(root, "blocked-root").projection.state).toBe("blocked");
  });

  test("auto-applies a planner proposal only when frozen policy opts in", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "auto-blocked",
      title: "Auto blocked",
      objective: "Recover under frozen authority",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-replan-auto",
      rootWorkId: "auto-blocked",
      specialists: {
        planner: { instructions: "Plan", harness: "codex" },
        implementer: { instructions: "Implement", harness: "codex" },
      },
      automation: { accept_passing_proof: true },
      replanning: {
        plannerSpecialist: "planner",
        autoApply: true,
        maxReplans: 1,
        templates: { repair: { workflowPath: passing, maxAttempts: 1, root: true } },
      },
    });
    const spawner: Spawner = async (request) => ({
      ok: true,
      text: request.prompt.includes("bounded replacement plan")
        ? replacementProposal()
        : "implemented",
      durationMs: 1,
    });
    const report = await runSupervisor({
      coordRoot: root,
      goalId: "goal-replan-auto",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(report.stop_reason).toBe("succeeded");
    expect(report.replans).toBe(1);
    expect(report.plan_outcomes[0]?.status).toBe("applied");
    expect(report.projection.plan_generation).toBe(1);
    expect(report.projection.replans_remaining).toBe(0);
  });

  test("an attention decision stays quiescent until durable graph state changes", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "needs-judgment",
      title: "Needs judgment",
      objective: "Stop when safe decomposition is unclear",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-replan-attention",
      rootWorkId: "needs-judgment",
      specialists: { planner: { instructions: "Plan", harness: "codex" } },
      replanning: {
        plannerSpecialist: "planner",
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    let calls = 0;
    const spawner: Spawner = async () => {
      calls++;
      return {
        ok: true,
        text: JSON.stringify({
          decision: "attention",
          rationale: "The goal needs an operator decision",
          root: "",
          work: [],
        }),
        durationMs: 1,
      };
    };
    const first = await runSupervisor({
      coordRoot: root,
      goalId: "goal-replan-attention",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(first.stop_reason).toBe("awaiting_attention");
    expect(first.projection.latest_plan_status).toBe("attention");
    const second = await runSupervisor({
      coordRoot: root,
      goalId: "goal-replan-attention",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(second.stop_reason).toBe("awaiting_attention");
    expect(calls).toBe(1);
  });

  test("feeds an explicit rejection reason into the next bounded planner attempt", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "rejected-plan-root",
      title: "Rejected plan root",
      objective: "Revise a rejected recovery plan",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-replan-rejected",
      rootWorkId: "rejected-plan-root",
      specialists: { planner: { instructions: "Plan", harness: "codex" } },
      replanning: {
        plannerSpecialist: "planner",
        maxReplans: 2,
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    const prompts: string[] = [];
    const spawner: Spawner = async (request) => {
      prompts.push(request.prompt);
      return {
        ok: true,
        text:
          prompts.length === 1
            ? replacementProposal()
            : JSON.stringify({
                decision: "attention",
                rationale: "Operator feedback requires a scope decision",
                root: "",
                work: [],
              }),
        durationMs: 1,
      };
    };
    const first = await runSupervisor({
      coordRoot: root,
      goalId: "goal-replan-rejected",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    rejectSupervisorPlan({
      coordRoot: root,
      goalId: "goal-replan-rejected",
      planId: first.projection.pending_plan_id!,
      actor: "reviewer",
      reason: "Use a narrower recovery scope",
    });
    expect(readSupervisor(root, "goal-replan-rejected").projection.next_action).toBe("replan");
    const second = await runSupervisor({
      coordRoot: root,
      goalId: "goal-replan-rejected",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(second.projection.latest_plan_status).toBe("attention");
    expect(second.projection.replans_used).toBe(2);
    expect(prompts[1]).toContain("Use a narrower recovery scope");
  });

  test("resumes the same planner workflow after a durable dispatch approval", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "planner-approval-root",
      title: "Planner approval root",
      objective: "Resume replanning after host approval",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-planner-approval",
      rootWorkId: "planner-approval-root",
      specialists: { planner: { instructions: "Plan", harness: "codex" } },
      replanning: {
        plannerSpecialist: "planner",
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    let spawns = 0;
    const engine = {
      spawners: {
        codex: async () => {
          spawns++;
          return { ok: true, text: replacementProposal(), durationMs: 1 };
        },
      },
      probeBilling,
      policy: { name: "planner-approval", network: "ask" as const },
      networkAccess: "enabled" as const,
      approvalMode: "park" as const,
    };
    const parked = await runSupervisor({
      coordRoot: root,
      goalId: "goal-planner-approval",
      engine,
    });
    expect(parked.stop_reason).toBe("awaiting_attention");
    expect(parked.projection.next_action).toBe("resolve_approval");
    expect(spawns).toBe(0);
    const planBefore = readSupervisor(root, "goal-planner-approval").plans[0]!;
    expect(planBefore.status).toBe("awaiting_approval");
    resolveWorkflowApproval({
      coordRoot: root,
      approvalId: planBefore.approval_id!,
      verdict: "allow",
      actor: "operator",
    });
    expect(readSupervisor(root, "goal-planner-approval").projection.next_action).toBe("replan");
    const resumed = await runSupervisor({
      coordRoot: root,
      goalId: "goal-planner-approval",
      engine,
    });
    expect(resumed.stop_reason).toBe("awaiting_attention");
    expect(resumed.projection.next_action).toBe("review_plan");
    expect(resumed.projection.replans_used).toBe(1);
    expect(resumed.plan_outcomes[0]?.workflow_run_id).toBe(planBefore.request.workflow_run_id);
    expect(spawns).toBe(1);
  });

  test("rejects a proposal that escapes the active graph or frozen template catalog", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "invalid-plan-root",
      title: "Invalid plan root",
      objective: "Reject unsafe planner output",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-replan-invalid",
      rootWorkId: "invalid-plan-root",
      specialists: { planner: { instructions: "Plan", harness: "codex" } },
      replanning: {
        plannerSpecialist: "planner",
        maxReplans: 1,
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    const spawner: Spawner = async () => ({
      ok: true,
      text: JSON.stringify({
        decision: "apply",
        rationale: "Unsafe dependency",
        root: "repair",
        work: [
          {
            key: "repair",
            title: "Repair",
            objective: "Escape the graph",
            acceptance: [],
            dependencies: ["foreign-work"],
            template: "repair",
          },
        ],
      }),
      durationMs: 1,
    });
    await expect(
      runSupervisor({
        coordRoot: root,
        goalId: "goal-replan-invalid",
        engine: { spawners: { codex: spawner }, probeBilling },
      }),
    ).rejects.toThrow("is not active or earlier in the plan");
    const invalid = readSupervisor(root, "goal-replan-invalid");
    expect(invalid.plans[0]?.status).toBe("failed");
    expect(invalid.projection.state).toBe("budget_exhausted");
  });

  test("creates an objective-first mission without inventing executable root work", () => {
    const { root, passing } = fixture();
    const record = createSupervisor({
      coordRoot: root,
      id: "goal-mission-initial",
      specialists: { planner: { instructions: "Plan", harness: "codex" } },
      mission: {
        objective: "Deliver the bounded mission",
        acceptance: ["The mission outcome is independently verified"],
        maxMilestones: 3,
      },
      replanning: {
        plannerSpecialist: "planner",
        templates: { delivery: { workflowPath: passing, root: true } },
      },
    });
    expect(record.work).toEqual([]);
    expect(record.projection.state).toBe("ready");
    expect(record.projection.next_action).toBe("plan_initial");
    expect(record.projection.milestones_completed).toBe(0);
    expect(record.projection.milestones_remaining).toBe(3);
    expect(record.intent.mission?.objective).toBe("Deliver the bounded mission");
    expect(() =>
      createSupervisor({
        coordRoot: root,
        id: "goal-mission-invalid",
        specialists: {},
      }),
    ).toThrow("requires a mission and replanning policy");
    expect(() =>
      createSupervisor({
        coordRoot: root,
        id: "goal-mission-no-completion-slot",
        specialists: { planner: { instructions: "Plan", harness: "codex" } },
        mission: {
          objective: "Use every milestone slot",
          acceptance: ["The mission is complete"],
          maxMilestones: 5,
        },
        replanning: {
          plannerSpecialist: "planner",
          maxReplans: 5,
          templates: { delivery: { workflowPath: passing, root: true } },
        },
      }),
    ).toThrow("must exceed max_milestones");
  });

  test("counts a supplied root as the first accepted mission milestone", async () => {
    const { root, passing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "supplied-milestone",
      title: "Supplied milestone",
      objective: "Deliver the operator-supplied first milestone",
      workflowPath: passing,
    });
    expect(() =>
      createSupervisor({
        coordRoot: root,
        id: "goal-mission-missing-planner",
        rootWorkId: "supplied-milestone",
        specialists: { implementer: { instructions: "Implement", harness: "codex" } },
        mission: {
          objective: "Complete a supplied mission",
          acceptance: ["The mission is complete"],
        },
      }),
    ).toThrow("mission requires a replanning policy");
    createSupervisor({
      coordRoot: root,
      id: "goal-mission-supplied",
      rootWorkId: "supplied-milestone",
      specialists: {
        planner: { instructions: "Reassess", harness: "codex" },
        implementer: { instructions: "Implement", harness: "codex" },
      },
      mission: {
        objective: "Complete a supplied mission",
        acceptance: ["The mission is complete"],
        maxMilestones: 3,
      },
      automation: { accept_passing_proof: true },
      replanning: {
        plannerSpecialist: "planner",
        templates: { delivery: { workflowPath: passing, root: true } },
      },
    });
    const report = await runSupervisor({
      coordRoot: root,
      goalId: "goal-mission-supplied",
      engine: {
        spawners: {
          codex: async (request) => ({
            ok: true,
            text: request.prompt.includes("bounded replacement plan")
              ? JSON.stringify({
                  decision: "attention",
                  rationale: "Further mission direction needs review",
                  root: "",
                  work: [],
                })
              : "supplied milestone delivered",
            durationMs: 1,
          }),
        },
        probeBilling,
      },
    });
    expect(report.stop_reason).toBe("awaiting_attention");
    expect(report.projection.milestones_completed).toBe(1);
    expect(report.projection.milestones_remaining).toBe(2);
    expect(readSupervisor(root, "goal-mission-supplied").plans[0]?.request.trigger).toBe(
      "milestone",
    );
  });

  test("refuses to declare an objective-first mission complete before milestone evidence", async () => {
    const { root, passing } = fixture();
    createSupervisor({
      coordRoot: root,
      id: "goal-mission-premature",
      specialists: { planner: { instructions: "Plan", harness: "codex" } },
      mission: {
        objective: "Produce verified evidence",
        acceptance: ["Evidence exists"],
      },
      replanning: {
        plannerSpecialist: "planner",
        templates: { delivery: { workflowPath: passing, root: true } },
      },
    });
    await expect(
      runSupervisor({
        coordRoot: root,
        goalId: "goal-mission-premature",
        engine: {
          spawners: {
            codex: async () => ({
              ok: true,
              text: JSON.stringify({
                decision: "complete",
                rationale: "Nothing appears necessary",
                root: "",
                work: [],
              }),
              durationMs: 1,
            }),
          },
          probeBilling,
        },
      }),
    ).rejects.toThrow("only at a milestone boundary");
    expect(readSupervisor(root, "goal-mission-premature").plans[0]?.status).toBe("failed");
  });

  test("keeps an objective-first attention decision quiescent until durable state changes", async () => {
    const { root, passing } = fixture();
    createSupervisor({
      coordRoot: root,
      id: "goal-mission-attention",
      specialists: { planner: { instructions: "Plan", harness: "codex" } },
      mission: {
        objective: "Clarify a blocked mission",
        acceptance: ["The mission outcome is verified"],
      },
      replanning: {
        plannerSpecialist: "planner",
        templates: { delivery: { workflowPath: passing, root: true } },
      },
    });
    let plannerCalls = 0;
    const spawner: Spawner = async () => {
      plannerCalls++;
      return {
        ok: true,
        text: JSON.stringify({
          decision: "attention",
          rationale: "The operator must resolve an external dependency",
          root: "",
          work: [],
        }),
        durationMs: 1,
      };
    };
    const engine = { spawners: { codex: spawner }, probeBilling };
    const first = await runSupervisor({
      coordRoot: root,
      goalId: "goal-mission-attention",
      engine,
    });
    const second = await runSupervisor({
      coordRoot: root,
      goalId: "goal-mission-attention",
      engine,
    });
    expect(first.stop_reason).toBe("awaiting_attention");
    expect(second.stop_reason).toBe("awaiting_attention");
    expect(second.projection.next_action).toBe("none");
    expect(plannerCalls).toBe(1);
  });

  test("requires review for each mission plan and approves completion idempotently", async () => {
    const { root, passing } = fixture();
    createSupervisor({
      coordRoot: root,
      id: "goal-mission-reviewed",
      specialists: {
        planner: { instructions: "Plan", harness: "codex" },
        implementer: { instructions: "Implement", harness: "codex" },
      },
      mission: {
        objective: "Ship one reviewed milestone",
        acceptance: ["The reviewed milestone satisfies the mission"],
        maxMilestones: 2,
      },
      automation: { accept_passing_proof: true },
      replanning: {
        plannerSpecialist: "planner",
        maxReplans: 3,
        templates: { delivery: { workflowPath: passing, root: true } },
      },
    });
    let plannerCalls = 0;
    const spawner: Spawner = async (request) => {
      if (request.prompt.includes("bounded replacement plan")) {
        plannerCalls++;
        return {
          ok: true,
          text:
            plannerCalls === 1
              ? missionMilestoneProposal()
              : JSON.stringify({
                  decision: "complete",
                  rationale: "Reviewed proof satisfies mission acceptance",
                  root: "",
                  work: [],
                }),
          durationMs: 1,
        };
      }
      return { ok: true, text: "milestone delivered", durationMs: 1 };
    };
    const engine = { spawners: { codex: spawner }, probeBilling };
    const initial = await runSupervisor({
      coordRoot: root,
      goalId: "goal-mission-reviewed",
      engine,
    });
    const initialPlanId = initial.projection.pending_plan_id!;
    expect(initial.projection.next_action).toBe("review_plan");
    expect(
      approveSupervisorPlan({
        coordRoot: root,
        goalId: "goal-mission-reviewed",
        planId: initialPlanId,
        actor: "reviewer",
      }).status,
    ).toBe("applied");

    const boundary = await runSupervisor({
      coordRoot: root,
      goalId: "goal-mission-reviewed",
      engine,
    });
    const completionPlanId = boundary.projection.pending_plan_id!;
    expect(boundary.projection.next_action).toBe("review_plan");
    expect(readSupervisorPlan(root, "goal-mission-reviewed", completionPlanId).status).toBe(
      "proposed",
    );
    const firstApproval = approveSupervisorPlan({
      coordRoot: root,
      goalId: "goal-mission-reviewed",
      planId: completionPlanId,
      actor: "reviewer",
    });
    const repeatedApproval = approveSupervisorPlan({
      coordRoot: root,
      goalId: "goal-mission-reviewed",
      planId: completionPlanId,
      actor: "reviewer",
    });
    expect(firstApproval.status).toBe("completed");
    expect(repeatedApproval.status).toBe("completed");
    expect(readSupervisor(root, "goal-mission-reviewed").projection.state).toBe("succeeded");
  });

  test("plans, executes, reassesses, and explicitly completes a bounded mission", async () => {
    const { root, passing } = fixture();
    createSupervisor({
      coordRoot: root,
      id: "goal-mission-loop",
      specialists: {
        planner: { instructions: "Plan one milestone", harness: "codex" },
        implementer: { instructions: "Execute the milestone", harness: "codex" },
      },
      mission: {
        objective: "Ship one verified milestone",
        acceptance: ["The milestone proof is accepted"],
        maxMilestones: 2,
      },
      automation: { accept_passing_proof: true },
      replanning: {
        plannerSpecialist: "planner",
        autoApply: true,
        maxReplans: 3,
        templates: { delivery: { workflowPath: passing, maxAttempts: 1, root: true } },
      },
    });
    let plannerCalls = 0;
    const spawner: Spawner = async (request) => {
      if (request.prompt.includes("bounded replacement plan")) {
        plannerCalls++;
        return {
          ok: true,
          text:
            plannerCalls === 1
              ? missionMilestoneProposal()
              : JSON.stringify({
                  decision: "complete",
                  rationale: "The accepted milestone satisfies mission acceptance",
                  root: "",
                  work: [],
                }),
          durationMs: 1,
        };
      }
      return { ok: true, text: "milestone delivered", durationMs: 1 };
    };
    const report = await runSupervisor({
      coordRoot: root,
      goalId: "goal-mission-loop",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(report.stop_reason).toBe("succeeded");
    expect(report.dispatches).toBe(1);
    expect(report.acceptances).toBe(1);
    expect(report.replans).toBe(2);
    expect(report.plan_outcomes.map((plan) => plan.status)).toEqual(["applied", "completed"]);
    expect(report.projection.milestones_completed).toBe(1);
    expect(report.projection.state).toBe("succeeded");
    expect(
      readSupervisor(root, "goal-mission-loop").plans.map((plan) => plan.request.trigger),
    ).toEqual(["initial", "milestone"]);
  });
});

function replacementProposal(): string {
  return JSON.stringify({
    decision: "apply",
    rationale: "Replace the terminal approach with one focused recovery item",
    root: "repair",
    work: [
      {
        key: "repair",
        title: "Repair the goal",
        objective: "Complete the original goal through the approved recovery workflow",
        acceptance: ["The original goal is complete"],
        dependencies: [],
        template: "repair",
      },
    ],
  });
}

function missionMilestoneProposal(): string {
  return JSON.stringify({
    decision: "apply",
    rationale: "Start with the smallest independently verifiable milestone",
    root: "delivery",
    milestone: {
      sequence: 1,
      title: "Verified delivery",
      objective: "Produce and verify the mission outcome",
      acceptance: ["The milestone proof passes"],
    },
    work: [
      {
        key: "delivery",
        title: "Deliver the milestone",
        objective: "Produce the bounded mission outcome",
        acceptance: ["The outcome is complete"],
        dependencies: [],
        template: "delivery",
      },
    ],
  });
}
