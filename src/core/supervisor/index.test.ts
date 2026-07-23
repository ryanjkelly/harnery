import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    const unreviewedPlan = readSupervisorPlan(root, "goal-replan-review", planId);
    expect(unreviewedPlan.status).toBe("proposed");
    expect(unreviewedPlan.review).toBeUndefined();
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

  test("reviewed proposal passes then waits for explicit plan approval unless auto-apply already exists", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-blocked",
      title: "Review blocked",
      objective: "Recover only after independent review",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-reviewed-pass",
      rootWorkId: "review-blocked",
      specialists: {
        planner: { instructions: "Plan", harness: "codex" },
        reviewer: { instructions: "Review plans independently", harness: "codex" },
        implementer: { instructions: "Implement", harness: "codex" },
      },
      automation: { accept_passing_proof: true },
      replanning: {
        plannerSpecialist: "planner",
        review: { reviewerSpecialists: ["reviewer"], maxRevisionRounds: 1 },
        templates: { repair: { workflowPath: passing, maxAttempts: 1, root: true } },
      },
    });
    const spawner: Spawner = async (request) => {
      if (request.prompt.includes("bounded replacement plan")) {
        expect(request.prompt).toContain("Work keys are lowercase identifiers no longer than 32");
        expect(request.prompt).toContain('"maxLength":32');
      }
      if (request.prompt.includes("Review this bounded")) {
        expect(request.prompt).toContain(
          "proposal.root names one newly proposed work key using a root-capable template",
        );
        expect(request.prompt).toContain("never require proposal.root to equal active_root");
      }
      return {
        ok: true,
        text: request.prompt.includes("Review this bounded")
          ? reviewVerdict("approve")
          : request.prompt.includes("bounded replacement plan")
            ? replacementProposal()
            : "implemented",
        durationMs: 1,
      };
    };
    const report = await runSupervisor({
      coordRoot: root,
      goalId: "goal-reviewed-pass",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = report.projection.pending_plan_id!;
    const plan = readSupervisorPlan(root, "goal-reviewed-pass", planId);
    expect(report.stop_reason).toBe("awaiting_attention");
    expect(report.projection.next_action).toBe("review_plan");
    expect(plan.status).toBe("proposed");
    expect(plan.review).toMatchObject({ status: "passed", rounds: 1 });
    expect(plan.root_work_id).toBeUndefined();
    expect(existsSync(join(root, ".harnery", "work", `${planId}-repair`, "intent.json"))).toBe(
      false,
    );

    const planDir = join(root, ".harnery", "supervisors", "goal-reviewed-pass", "plans", planId);
    const reviewPath = join(planDir, "review.json");
    const proposalPath = join(planDir, "proposal.json");
    const originalReview = readFileSync(reviewPath, "utf8");
    const receipt = JSON.parse(originalReview);
    receipt.final_candidate.rationale = "Replace the candidate after its final review round";
    receipt.candidate_sha256 = candidateDigestForTest(receipt.final_candidate);
    writeFileSync(reviewPath, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(() => readSupervisorPlan(root, "goal-reviewed-pass", planId)).toThrow(
      "final round does not match its candidate",
    );

    writeFileSync(reviewPath, originalReview);
    const proposal = JSON.parse(readFileSync(proposalPath, "utf8"));
    proposal.work[0].objective = "Apply work that the reviewers never evaluated";
    writeFileSync(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    expect(() =>
      approveSupervisorPlan({
        coordRoot: root,
        goalId: "goal-reviewed-pass",
        planId,
        actor: "operator",
      }),
    ).toThrow("proposal does not match its passed review");
  });

  test("reviewed auto-apply still requires pre-existing frozen auto_apply", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-auto-blocked",
      title: "Review auto blocked",
      objective: "Recover after approved review under frozen authority",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-reviewed-auto",
      rootWorkId: "review-auto-blocked",
      specialists: {
        planner: { instructions: "Plan", harness: "codex" },
        reviewer: { instructions: "Review", harness: "codex" },
        implementer: { instructions: "Implement", harness: "codex" },
      },
      automation: { accept_passing_proof: true },
      replanning: {
        plannerSpecialist: "planner",
        autoApply: true,
        maxReplans: 1,
        review: { reviewerSpecialists: ["reviewer"], maxRevisionRounds: 1 },
        templates: { repair: { workflowPath: passing, maxAttempts: 1, root: true } },
      },
    });
    const spawner: Spawner = async (request) => ({
      ok: true,
      text: request.prompt.includes("Review this bounded")
        ? reviewVerdict("approve")
        : request.prompt.includes("bounded replacement plan")
          ? replacementProposal()
          : "implemented",
      durationMs: 1,
    });
    const report = await runSupervisor({
      coordRoot: root,
      goalId: "goal-reviewed-auto",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(report.stop_reason).toBe("succeeded");
    expect(report.plan_outcomes[0]?.status).toBe("applied");
    expect(report.projection.plan_generation).toBe(1);
  });

  test("blocking review finding triggers one bounded revision before proposal", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-revision-blocked",
      title: "Review revision blocked",
      objective: "Revise a recovery candidate once",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-reviewed-revision",
      rootWorkId: "review-revision-blocked",
      specialists: {
        planner: { instructions: "Plan", harness: "codex" },
        reviewer: { instructions: "Review", harness: "codex" },
      },
      replanning: {
        plannerSpecialist: "planner",
        review: { reviewerSpecialists: ["reviewer"], maxRevisionRounds: 1 },
        templates: { repair: { workflowPath: passing, maxAttempts: 1, root: true } },
      },
    });
    let reviewerCalls = 0;
    let revisionCalls = 0;
    const spawner: Spawner = async (request) => {
      if (request.prompt.includes("bounded replacement plan")) {
        return { ok: true, text: replacementProposal(), durationMs: 1 };
      }
      if (request.prompt.includes("Review this bounded")) {
        reviewerCalls++;
        return {
          ok: true,
          text:
            reviewerCalls === 1
              ? reviewVerdict("approve", [{ severity: "blocking", summary: "Scope is too broad" }])
              : reviewVerdict("approve"),
          durationMs: 1,
        };
      }
      if (request.prompt.includes("Revise this supervisor plan candidate")) {
        revisionCalls++;
        return {
          ok: true,
          text: replacementProposal({
            rationale: "Use the narrower reviewed recovery item",
            objective: "Complete the original goal through the narrowed recovery workflow",
          }),
          durationMs: 1,
        };
      }
      return { ok: true, text: "ignored", durationMs: 1 };
    };
    const report = await runSupervisor({
      coordRoot: root,
      goalId: "goal-reviewed-revision",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = report.projection.pending_plan_id!;
    const plan = readSupervisorPlan(root, "goal-reviewed-revision", planId);
    const receipt = JSON.parse(
      readFileSync(
        join(
          root,
          ".harnery",
          "supervisors",
          "goal-reviewed-revision",
          "plans",
          planId,
          "review.json",
        ),
        "utf8",
      ),
    );
    expect(plan.status).toBe("proposed");
    expect(plan.review).toMatchObject({
      status: "passed",
      rounds: 2,
      blocking_findings: 1,
    });
    expect(plan.proposal?.work[0]?.objective).toBe(
      "Complete the original goal through the narrowed recovery workflow",
    );
    expect(receipt).toMatchObject({ schema_version: 1, plan_id: planId });
    expect(receipt.rounds[0].reviewers[0].findings[0]).toEqual({
      code: "test-finding-1",
      severity: "blocking",
      summary: "Scope is too broad",
      recommendation: "Revise the candidate to resolve this finding",
    });
    expect(reviewerCalls).toBe(2);
    expect(revisionCalls).toBe(1);
  });

  test("a zero-revision review parks its first blocker for attention", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-exhausted-blocked",
      title: "Review exhausted blocked",
      objective: "Exhaust the bounded review loop",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-reviewed-exhausted",
      rootWorkId: "review-exhausted-blocked",
      specialists: {
        planner: { instructions: "Plan", harness: "codex" },
        reviewer: { instructions: "Review", harness: "codex" },
      },
      replanning: {
        plannerSpecialist: "planner",
        review: { reviewerSpecialists: ["reviewer"], maxRevisionRounds: 0 },
        templates: { repair: { workflowPath: passing, maxAttempts: 1, root: true } },
      },
    });
    let revisionCalls = 0;
    const spawner: Spawner = async (request) => {
      if (request.prompt.includes("bounded replacement plan")) {
        return { ok: true, text: replacementProposal(), durationMs: 1 };
      }
      if (request.prompt.includes("Review this bounded")) {
        return {
          ok: true,
          text: reviewVerdict("revise", [
            { severity: "blocking", summary: "The candidate still misses acceptance evidence" },
          ]),
          durationMs: 1,
        };
      }
      if (request.prompt.includes("Revise this supervisor plan candidate")) {
        revisionCalls++;
        return {
          ok: true,
          text: replacementProposal({
            rationale: "Attempt a narrower recovery",
            objective: "Complete a narrower recovery path",
          }),
          durationMs: 1,
        };
      }
      return { ok: true, text: "ignored", durationMs: 1 };
    };
    const report = await runSupervisor({
      coordRoot: root,
      goalId: "goal-reviewed-exhausted",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = readSupervisor(root, "goal-reviewed-exhausted").plans[0]!.request.id;
    const plan = readSupervisorPlan(root, "goal-reviewed-exhausted", planId);
    expect(report.stop_reason).toBe("awaiting_attention");
    expect(plan.status).toBe("attention");
    expect(plan.review).toMatchObject({ status: "revision_exhausted", rounds: 1 });
    expect(
      existsSync(
        join(
          root,
          ".harnery",
          "supervisors",
          "goal-reviewed-exhausted",
          "plans",
          planId,
          "proposal.json",
        ),
      ),
    ).toBe(false);
    expect(revisionCalls).toBe(0);
  });

  test("partial review receipt fails closed", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-corrupt-blocked",
      title: "Review corrupt blocked",
      objective: "Corrupt the private review receipt",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-reviewed-corrupt",
      rootWorkId: "review-corrupt-blocked",
      specialists: {
        planner: { instructions: "Plan", harness: "codex" },
        reviewer: { instructions: "Review", harness: "codex" },
      },
      replanning: {
        plannerSpecialist: "planner",
        review: { reviewerSpecialists: ["reviewer"], maxRevisionRounds: 1 },
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    const spawner: Spawner = async (request) => ({
      ok: true,
      text: request.prompt.includes("Review this bounded")
        ? reviewVerdict("approve")
        : replacementProposal(),
      durationMs: 1,
    });
    const report = await runSupervisor({
      coordRoot: root,
      goalId: "goal-reviewed-corrupt",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = report.projection.pending_plan_id!;
    writeFileSync(
      join(
        root,
        ".harnery",
        "supervisors",
        "goal-reviewed-corrupt",
        "plans",
        planId,
        "review.json",
      ),
      '{"status":"passed"',
    );
    expect(() => readSupervisorPlan(root, "goal-reviewed-corrupt", planId)).toThrow();
  });

  test("completed review proof reconstructs a missing receipt and proposal idempotently", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-recover-blocked",
      title: "Review recover blocked",
      objective: "Recover reviewed plan artifacts from proof",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-reviewed-recover",
      rootWorkId: "review-recover-blocked",
      specialists: {
        planner: { instructions: "Plan", harness: "codex" },
        reviewer: { instructions: "Review", harness: "codex" },
      },
      replanning: {
        plannerSpecialist: "planner",
        review: { reviewerSpecialists: ["reviewer"], maxRevisionRounds: 1 },
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    let calls = 0;
    const spawner: Spawner = async (request) => {
      calls++;
      return {
        ok: true,
        text: request.prompt.includes("Review this bounded")
          ? reviewVerdict("approve")
          : replacementProposal(),
        durationMs: 1,
      };
    };
    const first = await runSupervisor({
      coordRoot: root,
      goalId: "goal-reviewed-recover",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = first.projection.pending_plan_id!;
    const planDir = join(root, ".harnery", "supervisors", "goal-reviewed-recover", "plans", planId);
    rmSync(join(planDir, "review.json"), { force: true });
    rmSync(join(planDir, "proposal.json"), { force: true });
    const second = await runSupervisor({
      coordRoot: root,
      goalId: "goal-reviewed-recover",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const recovered = readSupervisorPlan(root, "goal-reviewed-recover", planId);
    expect(second.stop_reason).toBe("awaiting_attention");
    expect(recovered.status).toBe("proposed");
    expect(recovered.review).toMatchObject({ status: "passed", rounds: 1 });
    expect(calls).toBe(2);
  });

  test("review proof recovery preserves frozen reviewer order after out-of-order completion", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-recover-order-blocked",
      title: "Review recover order blocked",
      objective: "Recover reviewed plan artifacts with multiple reviewers",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-reviewed-recover-order",
      rootWorkId: "review-recover-order-blocked",
      specialists: {
        planner: { instructions: "Plan", harness: "codex" },
        alpha: { instructions: "Review first", harness: "codex" },
        beta: { instructions: "Review second", harness: "codex" },
      },
      replanning: {
        plannerSpecialist: "planner",
        review: { reviewerSpecialists: ["alpha", "beta"], maxRevisionRounds: 1 },
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    let reviewCalls = 0;
    const spawner: Spawner = async (request) => {
      if (request.prompt.includes("Review this bounded")) {
        reviewCalls++;
        if (reviewCalls === 1) await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true, text: reviewVerdict("approve"), durationMs: 1 };
      }
      return { ok: true, text: replacementProposal(), durationMs: 1 };
    };
    const first = await runSupervisor({
      coordRoot: root,
      goalId: "goal-reviewed-recover-order",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = first.projection.pending_plan_id!;
    const planDir = join(
      root,
      ".harnery",
      "supervisors",
      "goal-reviewed-recover-order",
      "plans",
      planId,
    );
    rmSync(join(planDir, "review.json"), { force: true });
    rmSync(join(planDir, "proposal.json"), { force: true });
    const second = await runSupervisor({
      coordRoot: root,
      goalId: "goal-reviewed-recover-order",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const receipt = JSON.parse(readFileSync(join(planDir, "review.json"), "utf8"));
    expect(second.stop_reason).toBe("awaiting_attention");
    expect(
      receipt.rounds[0].reviewers.map((reviewer: { specialist: string }) => reviewer.specialist),
    ).toEqual(["alpha", "beta"]);
    expect(reviewCalls).toBe(2);
  });

  test("review proof recovery rejects journals that no longer match proof integrity", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-integrity-blocked",
      title: "Review integrity blocked",
      objective: "Reject stale review journal recovery",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-reviewed-integrity",
      rootWorkId: "review-integrity-blocked",
      specialists: {
        planner: { instructions: "Plan", harness: "codex" },
        reviewer: { instructions: "Review", harness: "codex" },
      },
      replanning: {
        plannerSpecialist: "planner",
        review: { reviewerSpecialists: ["reviewer"], maxRevisionRounds: 1 },
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    const spawner: Spawner = async (request) => ({
      ok: true,
      text: request.prompt.includes("Review this bounded")
        ? reviewVerdict("approve")
        : replacementProposal(),
      durationMs: 1,
    });
    const first = await runSupervisor({
      coordRoot: root,
      goalId: "goal-reviewed-integrity",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = first.projection.pending_plan_id!;
    const planDir = join(
      root,
      ".harnery",
      "supervisors",
      "goal-reviewed-integrity",
      "plans",
      planId,
    );
    const journalPath = join(root, ".harnery", "workflows", `${planId}-review`, "journal.jsonl");
    rmSync(join(planDir, "review.json"), { force: true });
    rmSync(join(planDir, "proposal.json"), { force: true });
    writeFileSync(journalPath, `${readFileSync(journalPath, "utf8")} `);
    await expect(
      runSupervisor({
        coordRoot: root,
        goalId: "goal-reviewed-integrity",
        engine: { spawners: { codex: spawner }, probeBilling },
      }),
    ).rejects.toThrow("journal does not match proof integrity");
  });

  test("review proof recovery rejects journals that no longer match proof result", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-result-blocked",
      title: "Review result blocked",
      objective: "Reject stale review result recovery",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-reviewed-result",
      rootWorkId: "review-result-blocked",
      specialists: {
        planner: { instructions: "Plan", harness: "codex" },
        reviewer: { instructions: "Review", harness: "codex" },
      },
      replanning: {
        plannerSpecialist: "planner",
        review: { reviewerSpecialists: ["reviewer"], maxRevisionRounds: 1 },
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    const spawner: Spawner = async (request) => ({
      ok: true,
      text: request.prompt.includes("Review this bounded")
        ? reviewVerdict("approve")
        : replacementProposal(),
      durationMs: 1,
    });
    const first = await runSupervisor({
      coordRoot: root,
      goalId: "goal-reviewed-result",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = first.projection.pending_plan_id!;
    const planDir = join(root, ".harnery", "supervisors", "goal-reviewed-result", "plans", planId);
    const runDir = join(root, ".harnery", "workflows", `${planId}-review`);
    const journalPath = join(runDir, "journal.jsonl");
    const proofPath = join(runDir, "proof.json");
    rmSync(join(planDir, "review.json"), { force: true });
    rmSync(join(planDir, "proposal.json"), { force: true });
    const journal = readFileSync(journalPath, "utf8")
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        const event = JSON.parse(line);
        if (event.event === "agent.end" && event.stage === "Review round 1") {
          return JSON.stringify({
            ...event,
            result: { ...event.result, rationale: "A stale reviewer result" },
          });
        }
        return line;
      })
      .join("\n");
    writeFileSync(journalPath, journal);
    const proof = JSON.parse(readFileSync(proofPath, "utf8"));
    proof.integrity.journal = {
      path: "journal.jsonl",
      sha256: createHash("sha256").update(journal).digest("hex"),
      bytes: Buffer.byteLength(journal),
    };
    writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
    await expect(
      runSupervisor({
        coordRoot: root,
        goalId: "goal-reviewed-result",
        engine: { spawners: { codex: spawner }, probeBilling },
      }),
    ).rejects.toThrow("result does not match proof digest");
  });

  test("existing review receipts must match the frozen review policy", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-policy-mismatch-blocked",
      title: "Review policy mismatch blocked",
      objective: "Reject mismatched private review receipt",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-reviewed-policy-mismatch",
      rootWorkId: "review-policy-mismatch-blocked",
      specialists: {
        planner: { instructions: "Plan", harness: "codex" },
        alpha: { instructions: "Review first", harness: "codex" },
        beta: { instructions: "Review second", harness: "codex" },
      },
      replanning: {
        plannerSpecialist: "planner",
        review: { reviewerSpecialists: ["alpha", "beta"], maxRevisionRounds: 1 },
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    const spawner: Spawner = async (request) => ({
      ok: true,
      text: request.prompt.includes("Review this bounded")
        ? reviewVerdict("approve")
        : replacementProposal(),
      durationMs: 1,
    });
    const first = await runSupervisor({
      coordRoot: root,
      goalId: "goal-reviewed-policy-mismatch",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = first.projection.pending_plan_id!;
    const reviewPath = join(
      root,
      ".harnery",
      "supervisors",
      "goal-reviewed-policy-mismatch",
      "plans",
      planId,
      "review.json",
    );
    const receipt = JSON.parse(readFileSync(reviewPath, "utf8"));
    receipt.rounds[0].reviewers.reverse();
    writeFileSync(reviewPath, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(() => readSupervisorPlan(root, "goal-reviewed-policy-mismatch", planId)).toThrow(
      "frozen review policy",
    );
  });

  test("rejects invalid reviewer specialists at supervisor creation", () => {
    const { root, passing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-policy-root",
      title: "Review policy root",
      objective: "Validate review policy",
      workflowPath: passing,
    });
    expect(() =>
      createSupervisor({
        coordRoot: root,
        id: "goal-reviewer-planner",
        rootWorkId: "review-policy-root",
        specialists: { planner: { instructions: "Plan", harness: "codex" } },
        replanning: {
          plannerSpecialist: "planner",
          review: { reviewerSpecialists: ["planner"], maxRevisionRounds: 1 },
          templates: { repair: { workflowPath: passing, root: true } },
        },
      }),
    ).toThrow("reviewer specialist cannot be the planner specialist");
    expect(() =>
      createSupervisor({
        coordRoot: root,
        id: "goal-reviewer-missing",
        rootWorkId: "review-policy-root",
        specialists: { planner: { instructions: "Plan", harness: "codex" } },
        replanning: {
          plannerSpecialist: "planner",
          review: { reviewerSpecialists: ["missing"], maxRevisionRounds: 1 },
          templates: { repair: { workflowPath: passing, root: true } },
        },
      }),
    ).toThrow("reviewer specialist missing is not present in the frozen team");
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

  test("resumes a parked review workflow without rerunning its completed planner", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-approval-root",
      title: "Review approval root",
      objective: "Resume reviewed replanning after host approval",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-review-approval",
      rootWorkId: "review-approval-root",
      specialists: {
        planner: { instructions: "Plan", harness: "codex" },
        reviewer: { instructions: "Review", harness: "codex" },
      },
      replanning: {
        plannerSpecialist: "planner",
        review: { reviewerSpecialists: ["reviewer"], maxRevisionRounds: 1 },
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    let spawns = 0;
    const engine = {
      spawners: {
        codex: async (request: SpawnRequest) => {
          spawns++;
          return {
            ok: true,
            text: request.prompt.includes("Review this bounded")
              ? reviewVerdict("approve")
              : replacementProposal(),
            durationMs: 1,
          };
        },
      },
      probeBilling,
      policy: { name: "review-approval", network: "ask" as const },
      networkAccess: "enabled" as const,
      approvalMode: "park" as const,
    };

    await runSupervisor({ coordRoot: root, goalId: "goal-review-approval", engine });
    let plan = readSupervisor(root, "goal-review-approval").plans[0]!;
    resolveWorkflowApproval({
      coordRoot: root,
      approvalId: plan.approval_id!,
      verdict: "allow",
      actor: "operator",
    });

    const reviewParked = await runSupervisor({
      coordRoot: root,
      goalId: "goal-review-approval",
      engine,
    });
    expect(reviewParked.projection.next_action).toBe("resolve_approval");
    expect(spawns).toBe(1);
    plan = readSupervisor(root, "goal-review-approval").plans[0]!;
    expect(plan.status).toBe("awaiting_approval");
    resolveWorkflowApproval({
      coordRoot: root,
      approvalId: plan.approval_id!,
      verdict: "allow",
      actor: "operator",
    });

    const resumed = await runSupervisor({
      coordRoot: root,
      goalId: "goal-review-approval",
      engine,
    });
    expect(readSupervisor(root, "goal-review-approval").plans[0]).toMatchObject({
      status: "proposed",
    });
    expect(resumed.projection.next_action).toBe("review_plan");
    expect(resumed.projection.replans_used).toBe(1);
    expect(spawns).toBe(2);
  });

  test("rejects review panels larger than the durable receipt contract", () => {
    const { root, passing } = fixture();
    const reviewerSpecialists = Array.from({ length: 6 }, (_, index) => `reviewer-${index + 1}`);
    const specialists = Object.fromEntries([
      ["planner", { instructions: "Plan", harness: "codex" }],
      ...reviewerSpecialists.map(
        (specialist) => [specialist, { instructions: "Review", harness: "codex" }] as const,
      ),
    ]);
    expect(() =>
      createSupervisor({
        coordRoot: root,
        id: "goal-oversized-review-panel",
        rootWorkId: undefined,
        mission: {
          objective: "Reject a panel that cannot be read durably",
          acceptance: ["Creation fails closed"],
        },
        specialists,
        limits: { max_agents_per_work: 1_000 },
        replanning: {
          plannerSpecialist: "planner",
          review: { reviewerSpecialists, maxRevisionRounds: 1 },
          templates: { repair: { workflowPath: passing, root: true } },
        },
      }),
    ).toThrow(/cannot exceed 5 reviewer specialists/);
  });

  test("retries an overlong planner key at the schema gate before plan normalization", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "bounded-plan-root",
      title: "Bounded plan root",
      objective: "Keep planner identifiers inside the durable contract",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-bounded-plan",
      rootWorkId: "bounded-plan-root",
      specialists: { planner: { instructions: "Plan", harness: "codex" } },
      replanning: {
        plannerSpecialist: "planner",
        maxReplans: 1,
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    const prompts: string[] = [];
    const spawner: Spawner = async (request) => {
      prompts.push(request.prompt);
      if (prompts.length === 1) {
        const key = `repair-${"x".repeat(32)}`;
        return {
          ok: true,
          text: JSON.stringify({
            decision: "apply",
            rationale: "Return an identifier that exceeds the frozen bound",
            root: key,
            work: [
              {
                key,
                title: "Repair",
                objective: "Repair through the frozen workflow",
                acceptance: ["The repair passes"],
                dependencies: [],
                template: "repair",
              },
            ],
          }),
          durationMs: 1,
        };
      }
      return { ok: true, text: replacementProposal(), durationMs: 1 };
    };
    const report = await runSupervisor({
      coordRoot: root,
      goalId: "goal-bounded-plan",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("$.work[0].key: expected at most 32 character(s)");
    expect(report.projection.next_action).toBe("review_plan");
    expect(readSupervisor(root, "goal-bounded-plan").plans[0]?.status).toBe("proposed");
  });

  test("retries a malformed reviewer finding code at the schema gate", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-code-root",
      title: "Review code root",
      objective: "Keep review receipts inside the durable identifier contract",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createSupervisor({
      coordRoot: root,
      id: "goal-review-code",
      rootWorkId: "review-code-root",
      specialists: {
        planner: { instructions: "Plan", harness: "codex" },
        reviewer: { instructions: "Review", harness: "codex" },
      },
      replanning: {
        plannerSpecialist: "planner",
        maxReplans: 1,
        review: { reviewerSpecialists: ["reviewer"], maxRevisionRounds: 1 },
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    const reviewPrompts: string[] = [];
    const spawner: Spawner = async (request) => {
      if (request.prompt.includes("bounded replacement plan")) {
        return { ok: true, text: replacementProposal(), durationMs: 1 };
      }
      if (request.prompt.includes("Review this bounded")) {
        reviewPrompts.push(request.prompt);
        return {
          ok: true,
          text:
            reviewPrompts.length === 1
              ? reviewVerdict("revise", [
                  { code: "Invalid Finding Code", severity: "blocking", summary: "Fix it" },
                ])
              : reviewVerdict("approve"),
          durationMs: 1,
        };
      }
      return { ok: true, text: "ignored", durationMs: 1 };
    };
    const report = await runSupervisor({
      coordRoot: root,
      goalId: "goal-review-code",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(reviewPrompts).toHaveLength(2);
    expect(reviewPrompts[1]).toContain(
      '$.findings[0].code: expected string matching "^[a-z][a-z0-9._-]*$"',
    );
    expect(report.projection.next_action).toBe("review_plan");
    expect(readSupervisor(root, "goal-review-code").plans[0]).toMatchObject({
      status: "proposed",
      review: { status: "passed", blocking_findings: 0 },
    });
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
    let plannerCalls = 0;
    await expect(
      runSupervisor({
        coordRoot: root,
        goalId: "goal-mission-premature",
        engine: {
          spawners: {
            codex: async () => {
              plannerCalls++;
              return {
                ok: true,
                text: JSON.stringify({
                  decision: "complete",
                  rationale: "Nothing appears necessary",
                  root: "",
                  work: [],
                }),
                durationMs: 1,
              };
            },
          },
          probeBilling,
        },
      }),
    ).rejects.toThrow("schema validation failed after 2 attempt(s)");
    expect(plannerCalls).toBe(2);
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
    const plannerPrompts: string[] = [];
    const spawner: Spawner = async (request) => {
      if (request.prompt.includes("bounded replacement plan")) {
        plannerCalls++;
        plannerPrompts.push(request.prompt);
        return {
          ok: true,
          text:
            plannerCalls === 1
              ? missionMilestoneProposal()
              : plannerCalls === 2
                ? JSON.stringify({
                    ...JSON.parse(missionMilestoneProposal()),
                    decision: "complete",
                    rationale: "The accepted milestone satisfies mission acceptance",
                  })
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
    expect(plannerCalls).toBe(3);
    expect(plannerPrompts[2]).toContain("expected exactly one schema option to match");
    expect(plannerPrompts[2]).toContain("$.milestone: unexpected property");
    expect(report.plan_outcomes.map((plan) => plan.status)).toEqual(["applied", "completed"]);
    expect(report.projection.milestones_completed).toBe(1);
    expect(report.projection.state).toBe("succeeded");
    expect(
      readSupervisor(root, "goal-mission-loop").plans.map((plan) => plan.request.trigger),
    ).toEqual(["initial", "milestone"]);
  });
});

function replacementProposal(
  options: { rationale?: string; objective?: string; title?: string } = {},
): string {
  return JSON.stringify({
    decision: "apply",
    rationale: options.rationale ?? "Replace the terminal approach with one focused recovery item",
    root: "repair",
    work: [
      {
        key: "repair",
        title: options.title ?? "Repair the goal",
        objective:
          options.objective ?? "Complete the original goal through the approved recovery workflow",
        acceptance: ["The original goal is complete"],
        dependencies: [],
        template: "repair",
      },
    ],
  });
}

function candidateDigestForTest(candidate: Record<string, unknown>): string {
  const canonical = {
    schema_version: candidate.schema_version,
    plan_id: candidate.plan_id,
    decision: candidate.decision,
    rationale: candidate.rationale,
    root: candidate.root,
    work: candidate.work,
    milestone: candidate.milestone,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function reviewVerdict(
  verdict: "approve" | "revise" | "attention",
  findings: Array<{
    code?: string;
    severity: "blocking" | "advisory";
    summary: string;
    recommendation?: string;
  }> = [],
): string {
  return JSON.stringify({
    verdict,
    rationale: verdict === "approve" ? "The plan is bounded and complete" : "The plan needs work",
    findings: findings.map((finding, index) => ({
      code: finding.code ?? `test-finding-${index + 1}`,
      severity: finding.severity,
      summary: finding.summary,
      recommendation: finding.recommendation ?? "Revise the candidate to resolve this finding",
    })),
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
