import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cancelWorkItem, createWorkItem, readWorkItem, reopenWorkItem } from "../work/index.ts";
import { resolveWorkflowApproval, type Spawner, type SpawnRequest } from "../workflow/index.ts";
import {
  approveGovernorPlan,
  createGovernor,
  findCompletedMissionGoverning,
  listGovernors,
  listGovernorsWithWarnings,
  readGovernor,
  readGovernorPlan,
  rejectGovernorPlan,
  reopenGovernorMission,
  retryGovernorPlan,
  runGovernor,
} from "./index.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join("/tmp", "harnery-governor-"));
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
  const blocking = join(root, "blocking.mjs");
  writeFileSync(
    blocking,
    `export default async ({ blocked }) => blocked({\n` +
      `  reason: "who owns the cart is unsettled",\n` +
      `  decision: "fb-011-who-owns-the-cart",\n` +
      `});\n`,
  );
  return { root, passing, failing, blocking };
}

const probeBilling = (adapter: string) => ({
  adapter,
  apiKeySource: null,
  apiKeyPresent: false,
  login: "present" as const,
  mode: "subscription" as const,
});

describe("durable goal governor", () => {
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
    const record = createGovernor({
      coordRoot: root,
      id: "goal-fixture",
      rootWorkId: "root",
      specialists: {
        implementer: { instructions: "Implement carefully", adapter: "codex" },
      },
    });
    expect(record.projection.work_ids).toEqual(["leaf", "root"]);
    expect(record.projection.ready_work).toEqual(["leaf"]);
    expect(record.projection.specialists).toEqual(["implementer"]);
    expect(
      statSync(join(root, ".harnery", "governors", "goal-fixture", "intent.json")).mode & 0o777,
    ).toBe(0o600);
    expect(() =>
      createGovernor({
        coordRoot: root,
        id: "goal-fixture",
        rootWorkId: "root",
        specialists: {},
      }),
    ).toThrow();
  });

  test("rejects governor-only specialist keys before writing an intent", () => {
    const { root, passing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "profile-root",
      title: "Profile root",
      objective: "Reject an invalid governor profile",
      workflowPath: passing,
    });

    expect(() =>
      createGovernor({
        coordRoot: root,
        id: "goal-invalid-profile",
        rootWorkId: "profile-root",
        specialists: {
          implementer: {
            instructions: "Implement carefully",
            adapter: "codex",
            timeoutMs: 60_000,
          },
        },
      }),
    ).toThrow(
      'governor specialist implementer has unsupported key "timeoutMs"; allowed keys: instructions, adapter, effort, maxAttempts',
    );
    expect(
      existsSync(join(root, ".harnery", "governors", "goal-invalid-profile", "intent.json")),
    ).toBe(false);
  });

  test("goal-set scans skip unreadable records and keep single-goal reads strict", () => {
    const { root, passing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "scan-root",
      title: "Scan root",
      objective: "Keep readable goals available",
      workflowPath: passing,
    });
    for (const id of ["goal-readable", "goal-poisoned"]) {
      createGovernor({
        coordRoot: root,
        id,
        rootWorkId: "scan-root",
        specialists: { implementer: { instructions: "Implement", adapter: "codex" } },
      });
    }
    const poisonedPath = join(root, ".harnery", "governors", "goal-poisoned", "intent.json");
    const poisoned = JSON.parse(readFileSync(poisonedPath, "utf8")) as {
      specialists: Record<string, Record<string, unknown>>;
    };
    poisoned.specialists.implementer!.harness = "codex";
    writeFileSync(poisonedPath, `${JSON.stringify(poisoned, null, 2)}\n`);

    expect(() => readGovernor(root, "goal-poisoned")).toThrow(
      "governor intent goal-poisoned specialists are not canonical",
    );
    expect(listGovernors(root).map((record) => record.intent.id)).toEqual(["goal-readable"]);
    expect(listGovernorsWithWarnings(root)).toMatchObject({
      records: [{ intent: { id: "goal-readable" } }],
      warnings: [
        {
          goal_id: "goal-poisoned",
          reason: "governor intent goal-poisoned specialists are not canonical",
        },
      ],
    });

    const warnings: string[] = [];
    expect(
      findCompletedMissionGoverning(root, "scan-root", (warning) => {
        warnings.push(`${warning.goal_id}: ${warning.reason}`);
      }),
    ).toBeUndefined();
    expect(warnings).toEqual([
      "goal-poisoned: governor intent goal-poisoned specialists are not canonical",
    ]);
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
    createGovernor({
      coordRoot: root,
      id: "goal-chain",
      rootWorkId: "root",
      specialists: {
        implementer: {
          instructions: "You are the implementation specialist. Keep changes focused.",
          adapter: "codex",
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
    const report = await runGovernor({
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
    expect(readGovernor(root, "goal-chain").projection.state).toBe("succeeded");
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
    createGovernor({
      coordRoot: root,
      id: "goal-review",
      rootWorkId: "reviewed",
      specialists: { implementer: { instructions: "Implement", adapter: "codex" } },
    });
    const spawner: Spawner = async () => ({ ok: true, text: "done", durationMs: 1 });
    const report = await runGovernor({
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
    createGovernor({
      coordRoot: root,
      id: "goal-approval",
      rootWorkId: "approved",
      specialists: { implementer: { instructions: "Implement", adapter: "codex" } },
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
    const parked = await runGovernor({
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
    const resumable = readGovernor(root, "goal-approval");
    expect(resumable.projection.state).toBe("ready");
    expect(resumable.projection.attempts_remaining).toBe(0);
    const resumed = await runGovernor({
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
    createGovernor({
      coordRoot: root,
      id: "goal-retry",
      rootWorkId: "failing",
      specialists: {},
      automation: { retry_blocked: true },
      limits: { max_total_attempts: 5 },
    });
    const report = await runGovernor({
      coordRoot: root,
      goalId: "goal-retry",
      engine: { spawners: {}, probeBilling },
    });
    expect(report.stop_reason).toBe("blocked");
    expect(report.dispatches).toBe(2);
    expect(readWorkItem(root, "failing").projection.attempts_used).toBe(2);
    expect(readWorkItem(root, "failing").projection.next_action).toBe("none");
  });

  // The whole point of the decision class. retry_blocked exists to clear
  // failures without a human; a correct refusal is not a failure, so the flag
  // must not reach it. Without this separation the same item is re-issued until
  // the budget is gone, every agent refusing it correctly and none of them able
  // to say so anywhere a human will look.
  test("retry_blocked cannot re-issue work that stopped on a human decision", async () => {
    const { root, blocking } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "needs-ruling",
      title: "Needs ruling",
      objective: "Cannot proceed without a product decision",
      workflowPath: blocking,
      maxAttempts: 3,
    });
    createGovernor({
      coordRoot: root,
      id: "goal-decision",
      rootWorkId: "needs-ruling",
      specialists: {},
      automation: { retry_blocked: true },
      limits: { max_total_attempts: 5 },
    });
    const report = await runGovernor({
      coordRoot: root,
      goalId: "goal-decision",
      engine: { spawners: {}, probeBilling },
    });

    expect(report.stop_reason).toBe("blocked");
    // One dispatch. The comparable failing-workflow test above spends two.
    expect(report.dispatches).toBe(1);
    expect(readWorkItem(root, "needs-ruling").projection.attempts_used).toBe(1);
    // Uncharged, so the ruling can be followed by a full-budget retry.
    expect(readWorkItem(root, "needs-ruling").projection.charged_attempts).toBe(0);

    const projection = readGovernor(root, "goal-decision").projection;
    // Not retryable — that list is what retry_blocked automates over.
    expect(projection.retryable_work).not.toContain("needs-ruling");
    expect(projection.decision_blocked_work).toEqual([
      { work_id: "needs-ruling", decision_id: "fb-011-who-owns-the-cart" },
    ]);
    // And the goal says who it is waiting on, rather than "needs intervention".
    expect(projection.reason).toContain("waiting on a human decision");
    expect(projection.reason).toContain("fb-011-who-owns-the-cart");
  });

  test("an authorized governor retry receives the prior failure synopsis", async () => {
    const { root } = fixture();
    const contextual = join(root, "contextual-retry.mjs");
    writeFileSync(
      contextual,
      `
        export const meta = {
          name: "contextual-retry",
          acceptance: [{ id: "done", statement: "The correction is verified" }],
        };
        export default async (ctx) => {
          if (ctx.attempt.trigger === "initial") throw new Error("first attempt failed");
          if (!ctx.attempt.prior.causes.includes("workflow_error")) {
            throw new Error("retry did not receive the prior workflow error");
          }
          ctx.evidence({
            kind: "review",
            status: "passed",
            label: "corrected from prior evidence",
            acceptanceIds: ["done"],
          });
          return ctx.attempt;
        };
      `,
    );
    createWorkItem({
      coordRoot: root,
      id: "contextual",
      title: "Contextual",
      objective: "Correct a failed attempt",
      workflowPath: contextual,
      maxAttempts: 2,
    });
    createGovernor({
      coordRoot: root,
      id: "goal-contextual",
      rootWorkId: "contextual",
      specialists: {},
      automation: { accept_passing_proof: true, retry_blocked: true },
      limits: { max_total_attempts: 2 },
    });

    const report = await runGovernor({
      coordRoot: root,
      goalId: "goal-contextual",
      engine: { spawners: {}, probeBilling },
    });
    expect(report.stop_reason).toBe("succeeded");
    expect(report.dispatches).toBe(2);
    const attempts = readWorkItem(root, "contextual").projection.attempts;
    expect(attempts.map((attempt) => attempt.trigger)).toEqual(["initial", "retry"]);
    const proof = JSON.parse(readFileSync(attempts[1]!.proof_path!, "utf8"));
    expect(proof.run.attempt_context).toMatchObject({
      number: 2,
      trigger: "retry",
      prior: {
        run_id: attempts[0]!.run_id,
        causes: ["workflow_error", "acceptance_unknown"],
        error: "first attempt failed",
      },
    });
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
    createGovernor({
      coordRoot: root,
      id: "goal-budget",
      rootWorkId: "budget-root",
      specialists: { implementer: { instructions: "Implement", adapter: "codex" } },
      automation: { accept_passing_proof: true },
      limits: { max_total_attempts: 1 },
    });
    const spawner: Spawner = async () => ({ ok: true, text: "done", durationMs: 1 });
    const report = await runGovernor({
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
    createGovernor({
      coordRoot: root,
      id: "goal-replan-budget",
      rootWorkId: "replan-budget-root",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
      limits: { max_total_attempts: 1 },
      replanning: {
        plannerSpecialist: "planner",
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    let plannerCalls = 0;
    const report = await runGovernor({
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
    createGovernor({
      coordRoot: root,
      id: "goal-tick",
      rootWorkId: "ticked",
      specialists: { implementer: { instructions: "Implement", adapter: "codex" } },
      automation: { accept_passing_proof: true },
    });
    const spawner: Spawner = async () => ({ ok: true, text: "done", durationMs: 1 });
    const first = await runGovernor({
      coordRoot: root,
      goalId: "goal-tick",
      mode: "tick",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(first.stop_reason).toBe("tick_complete");
    expect(first.acceptances).toBe(0);
    expect(readWorkItem(root, "ticked").projection.state).toBe("in_review");
    const second = await runGovernor({
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
    createGovernor({
      coordRoot: root,
      id: "goal-replan-review",
      rootWorkId: "blocked-root",
      specialists: {
        planner: { instructions: "Design a minimal recovery graph", adapter: "codex" },
        implementer: { instructions: "Implement the approved recovery", adapter: "codex" },
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
    const first = await runGovernor({
      coordRoot: root,
      goalId: "goal-replan-review",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(first.stop_reason).toBe("awaiting_attention");
    expect(first.replans).toBe(1);
    expect(first.projection.next_action).toBe("review_plan");
    expect(plannerCalls).toBe(1);
    const planId = first.projection.pending_plan_id!;
    const unreviewedPlan = readGovernorPlan(root, "goal-replan-review", planId);
    expect(unreviewedPlan.status).toBe("proposed");
    expect(unreviewedPlan.review).toBeUndefined();
    expect(
      statSync(
        join(root, ".harnery", "governors", "goal-replan-review", "plans", planId, "proposal.json"),
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
      source: { kind: "workflow", ref: `governor:goal-replan-review/plan:${planId}` },
      actor: "recovery-fixture",
    });

    const applied = approveGovernorPlan({
      coordRoot: root,
      goalId: "goal-replan-review",
      planId,
      actor: "reviewer",
      reason: "replacement graph is scoped and auditable",
    });
    expect(applied.status).toBe("applied");
    const replaced = readGovernor(root, "goal-replan-review");
    expect(replaced.projection.root_work_id).toBe(`${planId}-repair`);
    expect(replaced.projection.plan_generation).toBe(1);
    expect(replaced.projection.attempts_used).toBe(1);
    expect(replaced.projection.governed_work_ids).toContain("blocked-root");

    const completed = await runGovernor({
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
    createGovernor({
      coordRoot: root,
      id: "goal-replan-auto",
      rootWorkId: "auto-blocked",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        implementer: { instructions: "Implement", adapter: "codex" },
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
    const report = await runGovernor({
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
    createGovernor({
      coordRoot: root,
      id: "goal-reviewed-pass",
      rootWorkId: "review-blocked",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        reviewer: { instructions: "Review plans independently", adapter: "codex" },
        implementer: { instructions: "Implement", adapter: "codex" },
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
        expect(request.prompt).toContain("Do not return proposal.root");
        expect(request.prompt).toContain("single final outcome");
        expect(request.prompt).not.toContain("smallest observable end-to-end slice");
        expect(request.prompt).not.toContain(
          "contracts, module boundaries, key types or call paths",
        );
      }
      if (request.prompt.includes("Review this bounded")) {
        expect(request.prompt).toContain(
          "proposal.root is inferred by Harnery as the single final outcome",
        );
        expect(request.prompt).toContain("never require proposal.root to equal active_root");
        expect(request.prompt).not.toContain("program-shape decisions are explicit");
        expect(request.prompt).not.toContain(
          "defers every observable integration until the final item",
        );
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
    const report = await runGovernor({
      coordRoot: root,
      goalId: "goal-reviewed-pass",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = report.projection.pending_plan_id!;
    const plan = readGovernorPlan(root, "goal-reviewed-pass", planId);
    expect(report.stop_reason).toBe("awaiting_attention");
    expect(report.projection.next_action).toBe("review_plan");
    expect(plan.status).toBe("proposed");
    expect(plan.review).toMatchObject({ status: "passed", rounds: 1 });
    expect(plan.root_work_id).toBeUndefined();
    expect(existsSync(join(root, ".harnery", "work", `${planId}-repair`, "intent.json"))).toBe(
      false,
    );

    const planDir = join(root, ".harnery", "governors", "goal-reviewed-pass", "plans", planId);
    const reviewPath = join(planDir, "review.json");
    const proposalPath = join(planDir, "proposal.json");
    const originalReview = readFileSync(reviewPath, "utf8");
    const receipt = JSON.parse(originalReview);
    receipt.final_candidate.rationale = "Replace the candidate after its final review round";
    receipt.candidate_sha256 = candidateDigestForTest(receipt.final_candidate);
    writeFileSync(reviewPath, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(() => readGovernorPlan(root, "goal-reviewed-pass", planId)).toThrow(
      "final round does not match its candidate",
    );

    writeFileSync(reviewPath, originalReview);
    const proposal = JSON.parse(readFileSync(proposalPath, "utf8"));
    proposal.work[0].objective = "Apply work that the reviewers never evaluated";
    writeFileSync(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    expect(() =>
      approveGovernorPlan({
        coordRoot: root,
        goalId: "goal-reviewed-pass",
        planId,
        actor: "operator",
      }),
    ).toThrow("proposal does not match its passed review");
  });

  test("infers the proposal root from a prerequisite-first dependency graph", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "inferred-root-blocked",
      title: "Inferred root blocked",
      objective: "Replace this terminal approach with a multi-item plan",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createGovernor({
      coordRoot: root,
      id: "goal-inferred-plan-root",
      rootWorkId: "inferred-root-blocked",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
      replanning: {
        plannerSpecialist: "planner",
        maxReplans: 1,
        templates: {
          prerequisite: { workflowPath: passing, maxAttempts: 1 },
          delivery: { workflowPath: passing, maxAttempts: 1, root: true },
        },
      },
    });
    const spawner: Spawner = async () => ({
      ok: true,
      text: JSON.stringify({
        decision: "apply",
        rationale: "Establish the contract, integrate it, then prove the outcome",
        work: [
          {
            key: "contract",
            title: "Freeze the contract",
            objective: "Define the bounded interface used by the integrated behavior",
            acceptance: ["The contract is explicit"],
            dependencies: [],
            template: "prerequisite",
          },
          {
            key: "integrated-proof",
            title: "Deliver the integrated proof",
            objective: "Implement and observe the complete bounded behavior",
            acceptance: ["The integrated behavior is observed"],
            dependencies: ["contract"],
            template: "delivery",
          },
        ],
      }),
      durationMs: 1,
    });

    const report = await runGovernor({
      coordRoot: root,
      goalId: "goal-inferred-plan-root",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const plan = readGovernorPlan(
      root,
      "goal-inferred-plan-root",
      report.projection.pending_plan_id!,
    );
    expect(plan.status).toBe("proposed");
    expect(plan.proposal?.root).toBe("integrated-proof");
    expect(plan.proposal?.work[1]?.dependencies).toEqual(["contract"]);
  });

  test("refuses to guess between multiple final outcomes", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "ambiguous-root-blocked",
      title: "Ambiguous root blocked",
      objective: "Reject replacement graphs with no single final outcome",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createGovernor({
      coordRoot: root,
      id: "goal-ambiguous-plan-root",
      rootWorkId: "ambiguous-root-blocked",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
      replanning: {
        plannerSpecialist: "planner",
        maxReplans: 1,
        templates: { delivery: { workflowPath: passing, maxAttempts: 1, root: true } },
      },
    });
    const spawner: Spawner = async () => ({
      ok: true,
      text: JSON.stringify({
        decision: "apply",
        rationale: "Return two independent outcomes",
        work: [
          {
            key: "alpha",
            title: "Alpha outcome",
            objective: "Complete alpha",
            acceptance: ["Alpha passes"],
            dependencies: [],
            template: "delivery",
          },
          {
            key: "beta",
            title: "Beta outcome",
            objective: "Complete beta",
            acceptance: ["Beta passes"],
            dependencies: [],
            template: "delivery",
          },
        ],
      }),
      durationMs: 1,
    });

    await expect(
      runGovernor({
        coordRoot: root,
        goalId: "goal-ambiguous-plan-root",
        engine: { spawners: { codex: spawner }, probeBilling },
      }),
    ).rejects.toThrow("plan must have exactly one final outcome; found alpha, beta");
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
    createGovernor({
      coordRoot: root,
      id: "goal-reviewed-auto",
      rootWorkId: "review-auto-blocked",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        reviewer: { instructions: "Review", adapter: "codex" },
        implementer: { instructions: "Implement", adapter: "codex" },
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
    const report = await runGovernor({
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
    createGovernor({
      coordRoot: root,
      id: "goal-reviewed-revision",
      rootWorkId: "review-revision-blocked",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        reviewer: { instructions: "Review", adapter: "codex" },
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
      if (request.prompt.includes("Revise this governor plan candidate")) {
        revisionCalls++;
        expect(request.prompt).not.toContain(
          "Keep consequential contracts and program-shape decisions explicit",
        );
        expect(request.prompt).not.toContain("independently observable end-to-end slices");
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
    const report = await runGovernor({
      coordRoot: root,
      goalId: "goal-reviewed-revision",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = report.projection.pending_plan_id!;
    const plan = readGovernorPlan(root, "goal-reviewed-revision", planId);
    const receipt = JSON.parse(
      readFileSync(
        join(
          root,
          ".harnery",
          "governors",
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
    createGovernor({
      coordRoot: root,
      id: "goal-reviewed-exhausted",
      rootWorkId: "review-exhausted-blocked",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        reviewer: { instructions: "Review", adapter: "codex" },
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
      if (request.prompt.includes("Revise this governor plan candidate")) {
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
    const report = await runGovernor({
      coordRoot: root,
      goalId: "goal-reviewed-exhausted",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = readGovernor(root, "goal-reviewed-exhausted").plans[0]!.request.id;
    const plan = readGovernorPlan(root, "goal-reviewed-exhausted", planId);
    expect(report.stop_reason).toBe("awaiting_attention");
    expect(plan.status).toBe("attention");
    expect(plan.review).toMatchObject({ status: "revision_exhausted", rounds: 1 });
    expect(
      existsSync(
        join(
          root,
          ".harnery",
          "governors",
          "goal-reviewed-exhausted",
          "plans",
          planId,
          "proposal.json",
        ),
      ),
    ).toBe(false);
    expect(revisionCalls).toBe(0);
    const reviewedPlanDir = join(
      root,
      ".harnery",
      "governors",
      "goal-reviewed-exhausted",
      "plans",
      planId,
    );
    const requestBeforeRetry = readFileSync(join(reviewedPlanDir, "request.json"), "utf8");
    const reviewBeforeRetry = readFileSync(join(reviewedPlanDir, "review.json"), "utf8");
    expect(
      retryGovernorPlan({
        coordRoot: root,
        goalId: "goal-reviewed-exhausted",
        planId,
        actor: "operator",
        reason: "Narrow the proof requirement to the existing acceptance boundary",
      }).status,
    ).toBe("retry_requested");
    expect(readFileSync(join(reviewedPlanDir, "request.json"), "utf8")).toBe(requestBeforeRetry);
    expect(readFileSync(join(reviewedPlanDir, "review.json"), "utf8")).toBe(reviewBeforeRetry);
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
    createGovernor({
      coordRoot: root,
      id: "goal-reviewed-corrupt",
      rootWorkId: "review-corrupt-blocked",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        reviewer: { instructions: "Review", adapter: "codex" },
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
    const report = await runGovernor({
      coordRoot: root,
      goalId: "goal-reviewed-corrupt",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = report.projection.pending_plan_id!;
    writeFileSync(
      join(root, ".harnery", "governors", "goal-reviewed-corrupt", "plans", planId, "review.json"),
      '{"status":"passed"',
    );
    expect(() => readGovernorPlan(root, "goal-reviewed-corrupt", planId)).toThrow();
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
    createGovernor({
      coordRoot: root,
      id: "goal-reviewed-recover",
      rootWorkId: "review-recover-blocked",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        reviewer: { instructions: "Review", adapter: "codex" },
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
    const first = await runGovernor({
      coordRoot: root,
      goalId: "goal-reviewed-recover",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = first.projection.pending_plan_id!;
    const planDir = join(root, ".harnery", "governors", "goal-reviewed-recover", "plans", planId);
    rmSync(join(planDir, "review.json"), { force: true });
    rmSync(join(planDir, "proposal.json"), { force: true });
    const second = await runGovernor({
      coordRoot: root,
      goalId: "goal-reviewed-recover",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const recovered = readGovernorPlan(root, "goal-reviewed-recover", planId);
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
    createGovernor({
      coordRoot: root,
      id: "goal-reviewed-recover-order",
      rootWorkId: "review-recover-order-blocked",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        alpha: { instructions: "Review first", adapter: "codex" },
        beta: { instructions: "Review second", adapter: "codex" },
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
    const first = await runGovernor({
      coordRoot: root,
      goalId: "goal-reviewed-recover-order",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = first.projection.pending_plan_id!;
    const planDir = join(
      root,
      ".harnery",
      "governors",
      "goal-reviewed-recover-order",
      "plans",
      planId,
    );
    rmSync(join(planDir, "review.json"), { force: true });
    rmSync(join(planDir, "proposal.json"), { force: true });
    const second = await runGovernor({
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

  test("review proof recovery rejects transcripts that no longer match proof integrity", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-integrity-blocked",
      title: "Review integrity blocked",
      objective: "Reject stale review transcript recovery",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createGovernor({
      coordRoot: root,
      id: "goal-reviewed-integrity",
      rootWorkId: "review-integrity-blocked",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        reviewer: { instructions: "Review", adapter: "codex" },
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
    const first = await runGovernor({
      coordRoot: root,
      goalId: "goal-reviewed-integrity",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = first.projection.pending_plan_id!;
    const planDir = join(root, ".harnery", "governors", "goal-reviewed-integrity", "plans", planId);
    const transcriptPath = join(
      root,
      ".harnery",
      "workflows",
      `${planId}-review`,
      "transcript.jsonl",
    );
    rmSync(join(planDir, "review.json"), { force: true });
    rmSync(join(planDir, "proposal.json"), { force: true });
    writeFileSync(transcriptPath, `${readFileSync(transcriptPath, "utf8")} `);
    await expect(
      runGovernor({
        coordRoot: root,
        goalId: "goal-reviewed-integrity",
        engine: { spawners: { codex: spawner }, probeBilling },
      }),
    ).rejects.toThrow("transcript does not match proof integrity");
  });

  test("review proof recovery rejects transcripts that no longer match proof result", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-result-blocked",
      title: "Review result blocked",
      objective: "Reject stale review result recovery",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createGovernor({
      coordRoot: root,
      id: "goal-reviewed-result",
      rootWorkId: "review-result-blocked",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        reviewer: { instructions: "Review", adapter: "codex" },
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
    const first = await runGovernor({
      coordRoot: root,
      goalId: "goal-reviewed-result",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = first.projection.pending_plan_id!;
    const planDir = join(root, ".harnery", "governors", "goal-reviewed-result", "plans", planId);
    const runDir = join(root, ".harnery", "workflows", `${planId}-review`);
    const transcriptPath = join(runDir, "transcript.jsonl");
    const proofPath = join(runDir, "proof.json");
    rmSync(join(planDir, "review.json"), { force: true });
    rmSync(join(planDir, "proposal.json"), { force: true });
    const transcript = readFileSync(transcriptPath, "utf8")
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
    writeFileSync(transcriptPath, transcript);
    const proof = JSON.parse(readFileSync(proofPath, "utf8"));
    proof.integrity.transcript = {
      path: "transcript.jsonl",
      sha256: createHash("sha256").update(transcript).digest("hex"),
      bytes: Buffer.byteLength(transcript),
    };
    writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
    await expect(
      runGovernor({
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
    createGovernor({
      coordRoot: root,
      id: "goal-reviewed-policy-mismatch",
      rootWorkId: "review-policy-mismatch-blocked",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        alpha: { instructions: "Review first", adapter: "codex" },
        beta: { instructions: "Review second", adapter: "codex" },
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
    const first = await runGovernor({
      coordRoot: root,
      goalId: "goal-reviewed-policy-mismatch",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = first.projection.pending_plan_id!;
    const reviewPath = join(
      root,
      ".harnery",
      "governors",
      "goal-reviewed-policy-mismatch",
      "plans",
      planId,
      "review.json",
    );
    const receipt = JSON.parse(readFileSync(reviewPath, "utf8"));
    receipt.rounds[0].reviewers.reverse();
    writeFileSync(reviewPath, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(() => readGovernorPlan(root, "goal-reviewed-policy-mismatch", planId)).toThrow(
      "frozen review policy",
    );
  });

  test("rejects invalid reviewer specialists at governor creation", () => {
    const { root, passing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "review-policy-root",
      title: "Review policy root",
      objective: "Validate review policy",
      workflowPath: passing,
    });
    expect(() =>
      createGovernor({
        coordRoot: root,
        id: "goal-reviewer-planner",
        rootWorkId: "review-policy-root",
        specialists: { planner: { instructions: "Plan", adapter: "codex" } },
        replanning: {
          plannerSpecialist: "planner",
          review: { reviewerSpecialists: ["planner"], maxRevisionRounds: 1 },
          templates: { repair: { workflowPath: passing, root: true } },
        },
      }),
    ).toThrow("reviewer specialist cannot be the planner specialist");
    expect(() =>
      createGovernor({
        coordRoot: root,
        id: "goal-reviewer-missing",
        rootWorkId: "review-policy-root",
        specialists: { planner: { instructions: "Plan", adapter: "codex" } },
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
    createGovernor({
      coordRoot: root,
      id: "goal-replan-attention",
      rootWorkId: "needs-judgment",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
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
    const first = await runGovernor({
      coordRoot: root,
      goalId: "goal-replan-attention",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(first.stop_reason).toBe("awaiting_attention");
    expect(first.projection.latest_plan_status).toBe("attention");
    expect(first.projection.next_action).toBe("retry_plan");
    expect(first.projection.attention_plan_id).toBe(
      readGovernor(root, "goal-replan-attention").plans[0]?.request.id,
    );
    const second = await runGovernor({
      coordRoot: root,
      goalId: "goal-replan-attention",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(second.stop_reason).toBe("awaiting_attention");
    expect(calls).toBe(1);
    cancelWorkItem(root, "needs-judgment", {
      actor: "operator",
      reason: "Change durable graph truth",
    });
    expect(
      readGovernor(root, "goal-replan-attention").projection.attention_plan_id,
    ).toBeUndefined();
    expect(() =>
      retryGovernorPlan({
        coordRoot: root,
        goalId: "goal-replan-attention",
        planId: first.projection.attention_plan_id!,
        reason: "Retry stale attention",
      }),
    ).toThrow("no longer matches the active graph");
  });

  test("an addressed attention retry preserves prior evidence and guides one new plan", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "guided-retry-root",
      title: "Guided retry root",
      objective: "Recover after operator judgment",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createGovernor({
      coordRoot: root,
      id: "goal-guided-retry",
      rootWorkId: "guided-retry-root",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
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
        text: JSON.stringify({
          decision: "attention",
          rationale:
            prompts.length === 1
              ? "The goal needs an operator decision"
              : "The operator guidance was considered",
          root: "",
          work: [],
        }),
        durationMs: 1,
      };
    };
    const first = await runGovernor({
      coordRoot: root,
      goalId: "goal-guided-retry",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    const planId = first.projection.attention_plan_id!;
    const planDir = join(root, ".harnery", "governors", "goal-guided-retry", "plans", planId);
    const requestBefore = readFileSync(join(planDir, "request.json"), "utf8");
    const proposalBefore = readFileSync(join(planDir, "proposal.json"), "utf8");
    const eventsBefore = readFileSync(join(planDir, "events.jsonl"), "utf8");

    expect(() =>
      retryGovernorPlan({
        coordRoot: root,
        goalId: "goal-guided-retry",
        planId,
        reason: "   ",
      }),
    ).toThrow("plan retry reason must not be empty");
    expect(() =>
      retryGovernorPlan({
        coordRoot: root,
        goalId: "goal-guided-retry",
        planId,
        reason: "x".repeat(2_001),
      }),
    ).toThrow("plan retry reason exceeds 2000 characters");

    const retried = retryGovernorPlan({
      coordRoot: root,
      goalId: "goal-guided-retry",
      planId,
      actor: "operator",
      reason: "Keep the recovery local and preserve the existing API",
    });
    const repeated = retryGovernorPlan({
      coordRoot: root,
      goalId: "goal-guided-retry",
      planId,
      actor: "operator",
      reason: "This duplicate must not replace the first guidance",
    });
    expect(retried.status).toBe("retry_requested");
    expect(repeated).toEqual(retried);
    expect(readFileSync(join(planDir, "request.json"), "utf8")).toBe(requestBefore);
    expect(readFileSync(join(planDir, "proposal.json"), "utf8")).toBe(proposalBefore);
    const eventsAfter = readFileSync(join(planDir, "events.jsonl"), "utf8");
    expect(eventsAfter.slice(0, eventsBefore.length)).toBe(eventsBefore);
    expect(eventsAfter.match(/plan\.retry_requested/g)).toHaveLength(1);
    expect(eventsAfter).toContain("Keep the recovery local and preserve the existing API");
    expect(eventsAfter).not.toContain("This duplicate must not replace the first guidance");
    expect(readGovernor(root, "goal-guided-retry").projection.next_action).toBe("replan");

    const second = await runGovernor({
      coordRoot: root,
      goalId: "goal-guided-retry",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(second.projection.replans_used).toBe(2);
    expect(prompts[1]).toContain("Keep the recovery local and preserve the existing API");
    expect(readFileSync(join(planDir, "request.json"), "utf8")).toBe(requestBefore);
    expect(readFileSync(join(planDir, "proposal.json"), "utf8")).toBe(proposalBefore);
    expect(() =>
      retryGovernorPlan({
        coordRoot: root,
        goalId: "goal-guided-retry",
        planId,
        reason: "Retry the historical plan",
      }),
    ).toThrow(`governor plan ${planId} is not the latest plan`);
  });

  test("attention retry stays unavailable after the frozen replan budget is exhausted", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "retry-budget-root",
      title: "Retry budget root",
      objective: "Respect the frozen planning budget",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createGovernor({
      coordRoot: root,
      id: "goal-retry-budget",
      rootWorkId: "retry-budget-root",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
      replanning: {
        plannerSpecialist: "planner",
        maxReplans: 1,
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    const report = await runGovernor({
      coordRoot: root,
      goalId: "goal-retry-budget",
      engine: {
        spawners: {
          codex: async () => ({
            ok: true,
            text: JSON.stringify({
              decision: "attention",
              rationale: "Human judgment is required",
              root: "",
              work: [],
            }),
            durationMs: 1,
          }),
        },
        probeBilling,
      },
    });
    expect(report.projection.next_action).toBe("none");
    expect(() =>
      retryGovernorPlan({
        coordRoot: root,
        goalId: "goal-retry-budget",
        planId: report.projection.attention_plan_id!,
        reason: "Try once more",
      }),
    ).toThrow("governor goal-retry-budget exhausted its 1 replans");
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
    createGovernor({
      coordRoot: root,
      id: "goal-replan-rejected",
      rootWorkId: "rejected-plan-root",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
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
    const first = await runGovernor({
      coordRoot: root,
      goalId: "goal-replan-rejected",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(() =>
      retryGovernorPlan({
        coordRoot: root,
        goalId: "goal-replan-rejected",
        planId: first.projection.pending_plan_id!,
        reason: "Retry a proposal that still awaits review",
      }),
    ).toThrow("cannot be retried from proposed");
    rejectGovernorPlan({
      coordRoot: root,
      goalId: "goal-replan-rejected",
      planId: first.projection.pending_plan_id!,
      actor: "reviewer",
      reason: "Use a narrower recovery scope",
    });
    expect(readGovernor(root, "goal-replan-rejected").projection.next_action).toBe("replan");
    const second = await runGovernor({
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
    createGovernor({
      coordRoot: root,
      id: "goal-planner-approval",
      rootWorkId: "planner-approval-root",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
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
    const parked = await runGovernor({
      coordRoot: root,
      goalId: "goal-planner-approval",
      engine,
    });
    expect(parked.stop_reason).toBe("awaiting_attention");
    expect(parked.projection.next_action).toBe("resolve_approval");
    expect(spawns).toBe(0);
    const planBefore = readGovernor(root, "goal-planner-approval").plans[0]!;
    expect(planBefore.status).toBe("awaiting_approval");
    resolveWorkflowApproval({
      coordRoot: root,
      approvalId: planBefore.approval_id!,
      verdict: "allow",
      actor: "operator",
    });
    expect(readGovernor(root, "goal-planner-approval").projection.next_action).toBe("replan");
    const resumed = await runGovernor({
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
    createGovernor({
      coordRoot: root,
      id: "goal-review-approval",
      rootWorkId: "review-approval-root",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        reviewer: { instructions: "Review", adapter: "codex" },
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

    await runGovernor({ coordRoot: root, goalId: "goal-review-approval", engine });
    let plan = readGovernor(root, "goal-review-approval").plans[0]!;
    resolveWorkflowApproval({
      coordRoot: root,
      approvalId: plan.approval_id!,
      verdict: "allow",
      actor: "operator",
    });

    const reviewParked = await runGovernor({
      coordRoot: root,
      goalId: "goal-review-approval",
      engine,
    });
    expect(reviewParked.projection.next_action).toBe("resolve_approval");
    expect(spawns).toBe(1);
    plan = readGovernor(root, "goal-review-approval").plans[0]!;
    expect(plan.status).toBe("awaiting_approval");
    resolveWorkflowApproval({
      coordRoot: root,
      approvalId: plan.approval_id!,
      verdict: "allow",
      actor: "operator",
    });

    const resumed = await runGovernor({
      coordRoot: root,
      goalId: "goal-review-approval",
      engine,
    });
    expect(readGovernor(root, "goal-review-approval").plans[0]).toMatchObject({
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
      ["planner", { instructions: "Plan", adapter: "codex" }],
      ...reviewerSpecialists.map(
        (specialist) => [specialist, { instructions: "Review", adapter: "codex" }] as const,
      ),
    ]);
    expect(() =>
      createGovernor({
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
    createGovernor({
      coordRoot: root,
      id: "goal-bounded-plan",
      rootWorkId: "bounded-plan-root",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
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
    const report = await runGovernor({
      coordRoot: root,
      goalId: "goal-bounded-plan",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("$.work[0].key: expected at most 32 character(s)");
    expect(report.projection.next_action).toBe("review_plan");
    expect(readGovernor(root, "goal-bounded-plan").plans[0]?.status).toBe("proposed");
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
    createGovernor({
      coordRoot: root,
      id: "goal-review-code",
      rootWorkId: "review-code-root",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        reviewer: { instructions: "Review", adapter: "codex" },
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
    const report = await runGovernor({
      coordRoot: root,
      goalId: "goal-review-code",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(reviewPrompts).toHaveLength(2);
    expect(reviewPrompts[1]).toContain(
      '$.findings[0].code: expected string matching "^[a-z][a-z0-9._-]*$"',
    );
    expect(report.projection.next_action).toBe("review_plan");
    expect(readGovernor(root, "goal-review-code").plans[0]).toMatchObject({
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
    createGovernor({
      coordRoot: root,
      id: "goal-replan-invalid",
      rootWorkId: "invalid-plan-root",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
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
      runGovernor({
        coordRoot: root,
        goalId: "goal-replan-invalid",
        engine: { spawners: { codex: spawner }, probeBilling },
      }),
    ).rejects.toThrow("is not active or earlier in the plan");
    const invalid = readGovernor(root, "goal-replan-invalid");
    expect(invalid.plans[0]?.status).toBe("failed");
    expect(invalid.projection.state).toBe("budget_exhausted");
  });

  test("creates an objective-first mission without inventing executable root work", () => {
    const { root, passing } = fixture();
    const record = createGovernor({
      coordRoot: root,
      id: "goal-mission-initial",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
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
      createGovernor({
        coordRoot: root,
        id: "goal-mission-invalid",
        specialists: {},
      }),
    ).toThrow("requires a mission and replanning policy");
    expect(() =>
      createGovernor({
        coordRoot: root,
        id: "goal-mission-no-completion-slot",
        specialists: { planner: { instructions: "Plan", adapter: "codex" } },
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

  test("counts an inferred root as the first accepted mission milestone", async () => {
    const { root, passing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "supplied-milestone",
      title: "Supplied milestone",
      objective: "Deliver the operator-supplied first milestone",
      workflowPath: passing,
    });
    expect(() =>
      createGovernor({
        coordRoot: root,
        id: "goal-mission-missing-planner",
        rootWorkId: "supplied-milestone",
        specialists: { implementer: { instructions: "Implement", adapter: "codex" } },
        mission: {
          objective: "Complete a supplied mission",
          acceptance: ["The mission is complete"],
        },
      }),
    ).toThrow("mission requires a replanning policy");
    createGovernor({
      coordRoot: root,
      id: "goal-mission-supplied",
      rootWorkId: "supplied-milestone",
      specialists: {
        planner: { instructions: "Reassess", adapter: "codex" },
        implementer: { instructions: "Implement", adapter: "codex" },
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
    const report = await runGovernor({
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
    expect(readGovernor(root, "goal-mission-supplied").plans[0]?.request.trigger).toBe("milestone");
  });

  test("refuses to declare an objective-first mission complete before milestone evidence", async () => {
    const { root, passing } = fixture();
    createGovernor({
      coordRoot: root,
      id: "goal-mission-premature",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
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
      runGovernor({
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
    expect(readGovernor(root, "goal-mission-premature").plans[0]?.status).toBe("failed");
  });

  test("keeps an objective-first attention decision quiescent until durable state changes", async () => {
    const { root, passing } = fixture();
    createGovernor({
      coordRoot: root,
      id: "goal-mission-attention",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
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
    const first = await runGovernor({
      coordRoot: root,
      goalId: "goal-mission-attention",
      engine,
    });
    const second = await runGovernor({
      coordRoot: root,
      goalId: "goal-mission-attention",
      engine,
    });
    expect(first.stop_reason).toBe("awaiting_attention");
    expect(second.stop_reason).toBe("awaiting_attention");
    expect(second.projection.next_action).toBe("retry_plan");
    expect(plannerCalls).toBe(1);
  });

  test("requires review for each mission plan and approves completion idempotently", async () => {
    const { root, passing } = fixture();
    createGovernor({
      coordRoot: root,
      id: "goal-mission-reviewed",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        implementer: { instructions: "Implement", adapter: "codex" },
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
    const initial = await runGovernor({
      coordRoot: root,
      goalId: "goal-mission-reviewed",
      engine,
    });
    const initialPlanId = initial.projection.pending_plan_id!;
    expect(initial.projection.next_action).toBe("review_plan");
    expect(
      approveGovernorPlan({
        coordRoot: root,
        goalId: "goal-mission-reviewed",
        planId: initialPlanId,
        actor: "reviewer",
      }).status,
    ).toBe("applied");

    const boundary = await runGovernor({
      coordRoot: root,
      goalId: "goal-mission-reviewed",
      engine,
    });
    const completionPlanId = boundary.projection.pending_plan_id!;
    expect(boundary.projection.next_action).toBe("review_plan");
    expect(readGovernorPlan(root, "goal-mission-reviewed", completionPlanId).status).toBe(
      "proposed",
    );
    const firstApproval = approveGovernorPlan({
      coordRoot: root,
      goalId: "goal-mission-reviewed",
      planId: completionPlanId,
      actor: "reviewer",
    });
    const repeatedApproval = approveGovernorPlan({
      coordRoot: root,
      goalId: "goal-mission-reviewed",
      planId: completionPlanId,
      actor: "reviewer",
    });
    expect(firstApproval.status).toBe("completed");
    expect(repeatedApproval.status).toBe("completed");
    expect(readGovernor(root, "goal-mission-reviewed").projection.state).toBe("succeeded");
  });

  test("plans, executes, reassesses, and explicitly completes a bounded mission", async () => {
    const { root, passing } = fixture();
    createGovernor({
      coordRoot: root,
      id: "goal-mission-loop",
      specialists: {
        planner: { instructions: "Plan one milestone", adapter: "codex" },
        implementer: { instructions: "Execute the milestone", adapter: "codex" },
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
    const report = await runGovernor({
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
      readGovernor(root, "goal-mission-loop").plans.map((plan) => plan.request.trigger),
    ).toEqual(["initial", "milestone"]);
  });

  // ADR 0050: a mission that completes is the strongest "passed while possibly
  // wrong" state, and it is exactly where an operator reviews the output and finds
  // something. Before this, `work reopen` reported the item ready and the goal
  // reported succeeded at the same time, so the governor never dispatched it.
  test("an operator finding under a completed mission reopens the mission and dispatches", async () => {
    const { root, passing } = fixture();
    createGovernor({
      coordRoot: root,
      id: "goal-reopen-mission",
      specialists: {
        planner: { instructions: "Plan one milestone", adapter: "codex" },
        implementer: { instructions: "Execute the milestone", adapter: "codex" },
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
        templates: { delivery: { workflowPath: passing, maxAttempts: 2, root: true } },
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
    const report = await runGovernor({
      coordRoot: root,
      goalId: "goal-reopen-mission",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(report.stop_reason).toBe("succeeded");
    const rootWorkId = report.projection.root_work_id;
    const completedPlanId = report.plan_outcomes.at(-1)!.plan_id;

    // The scan is what lets `work reopen` know it is standing under a finished
    // mission rather than an unwatched work item.
    expect(findCompletedMissionGoverning(root, rootWorkId)).toBe("goal-reopen-mission");

    reopenWorkItem(root, rootWorkId, {
      actor: "operator",
      reason: "the delivered fix regressed the stopping reason",
      findings: ["the stopping reason still reads succeeded on a blocked goal"],
    });

    // The defect: the item is ready and the goal is finished, simultaneously.
    const stranded = readGovernor(root, "goal-reopen-mission").projection;
    expect(stranded.ready_work).toContain(rootWorkId);
    expect(stranded.state).toBe("succeeded");
    expect(stranded.next_action).toBe("none");

    reopenGovernorMission({
      coordRoot: root,
      goalId: "goal-reopen-mission",
      actor: "operator",
      reason: "an operator finding must be addressed before the mission is done",
    });

    const resumed = readGovernor(root, "goal-reopen-mission").projection;
    expect(resumed.state).toBe("ready");
    expect(resumed.next_action).toBe("run");
    expect(resumed.reason).toContain("mission completion was reopened");
    expect(resumed.ready_work).toContain(rootWorkId);

    // Append-only: the accepted completion is still in the log, with the reopen
    // recorded after it rather than in place of it.
    const plan = readGovernorPlan(root, "goal-reopen-mission", completedPlanId);
    expect(plan.status).toBe("reopened");
    const kinds = plan.events.map((event) => event.event);
    expect(kinds).toContain("plan.completed");
    expect(kinds.indexOf("plan.reopened")).toBeGreaterThan(kinds.indexOf("plan.completed"));

    // Reopening twice is idempotent, not a second event.
    reopenGovernorMission({
      coordRoot: root,
      goalId: "goal-reopen-mission",
      reason: "same finding, run again",
    });
    expect(
      readGovernorPlan(root, "goal-reopen-mission", completedPlanId).events.filter(
        (event) => event.event === "plan.reopened",
      ),
    ).toHaveLength(1);
  });

  test("a mission that never completed refuses to be reopened", async () => {
    const { root, passing } = fixture();
    createGovernor({
      coordRoot: root,
      id: "goal-reopen-refuses",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
      mission: { objective: "Ship", acceptance: ["Accepted"], maxMilestones: 2 },
      replanning: {
        plannerSpecialist: "planner",
        maxReplans: 3,
        templates: { delivery: { workflowPath: passing, maxAttempts: 1, root: true } },
      },
    });
    expect(() =>
      reopenGovernorMission({
        coordRoot: root,
        goalId: "goal-reopen-refuses",
        reason: "nothing to reopen",
      }),
    ).toThrow(/no plan to reopen/);
  });

  // ADR 0046 (scope correction): the measured 19 "codex not found" retries were
  // spent on PLANNER replans, not durable-work attempts. A planner failure that
  // never touched the plan must not drive the replan loop — environment stops it,
  // upstream is bounded — mirroring the durable-work charging rules.
  describe("uncharged planner failures do not drive the replan loop (ADR 0046)", () => {
    function replanGoal(root: string, id: string) {
      createWorkItem({
        coordRoot: root,
        id: `${id}-root`,
        title: "Root",
        objective: "Complete the goal despite a terminal approach",
        workflowPath: join(root, "failing.mjs"),
        maxAttempts: 1,
      });
      createGovernor({
        coordRoot: root,
        id,
        rootWorkId: `${id}-root`,
        specialists: { planner: { instructions: "Plan a recovery", adapter: "codex" } },
        replanning: {
          plannerSpecialist: "planner",
          templates: { repair: { workflowPath: join(root, "passing.mjs"), root: true } },
        },
      });
    }

    test("an environment planner failure stops the goal and names the precondition", async () => {
      const { root } = fixture();
      replanGoal(root, "goal-plan-env");
      let plannerCalls = 0;
      const engine = {
        spawners: {
          codex: async () => {
            plannerCalls++;
            return {
              ok: false as const,
              text: "",
              durationMs: 1,
              error: "codex not found on PATH",
              class: "environment" as const,
            };
          },
        },
        probeBilling,
      };
      // The runner rethrows the planner failure after recording plan.failed, just
      // as it does live; the operator (or the next tick) re-runs.
      await expect(
        runGovernor({ coordRoot: root, goalId: "goal-plan-env", engine }),
      ).rejects.toThrow();

      const stopped = readGovernor(root, "goal-plan-env");
      expect(stopped.projection.state).toBe("blocked");
      expect(stopped.projection.next_action).toBe("none");
      expect(stopped.projection.reason).toContain("required precondition is missing");
      // The failed replan was uncharged: it did not spend the replan budget.
      expect(stopped.projection.replans_used).toBe(1);
      expect(stopped.projection.replans_remaining).toBe(
        stopped.intent.replanning?.max_replans ?? 0,
      );
      expect(stopped.plans.at(-1)?.class).toBe("environment");

      // Re-running does NOT replan an unchanged environment — the loop is broken.
      const rerun = await runGovernor({ coordRoot: root, goalId: "goal-plan-env", engine });
      expect(rerun.stop_reason).toBe("blocked");
      expect(plannerCalls).toBe(1);
    });

    test("upstream planner failures are uncharged, stay retryable, and are bounded", async () => {
      const { root } = fixture();
      replanGoal(root, "goal-plan-upstream");
      const engine = {
        spawners: {
          codex: async () => ({
            ok: false as const,
            text: "",
            durationMs: 1,
            error: "503 service unavailable: circuit_open",
            class: "upstream" as const,
          }),
        },
        probeBilling,
      };
      // The consecutive-uncharged bound is 3 REPLANS (each replan may retry the
      // vendor in-agent). Each run records one failed replan and rethrows; below
      // the bound the goal stays retryable (next: replan).
      for (let attempt = 1; attempt <= 3; attempt++) {
        await expect(
          runGovernor({ coordRoot: root, goalId: "goal-plan-upstream", engine }),
        ).rejects.toThrow();
        const between = readGovernor(root, "goal-plan-upstream");
        expect(between.plans.length).toBe(attempt);
        expect(between.plans.at(-1)?.class).toBe("upstream");
        // None of the upstream failures charged the replan budget.
        expect(between.projection.replans_remaining).toBe(
          between.intent.replanning?.max_replans ?? 0,
        );
        if (attempt < 3) {
          expect(between.projection.next_action).toBe("replan");
        }
      }
      const bounded = readGovernor(root, "goal-plan-upstream");
      expect(bounded.projection.state).toBe("blocked");
      expect(bounded.projection.next_action).toBe("none");
      expect(bounded.projection.reason).toContain("waiting on an outside service");
      expect(bounded.plans.length).toBe(3);

      // At the bound the goal stops rather than retrying the outage forever — no
      // fourth replan is created.
      const halted = await runGovernor({ coordRoot: root, goalId: "goal-plan-upstream", engine });
      expect(halted.stop_reason).toBe("blocked");
      expect(readGovernor(root, "goal-plan-upstream").plans.length).toBe(3);
    });

    test("an unclassed planner failure still charges the replan, exactly as before", async () => {
      const { root } = fixture();
      replanGoal(root, "goal-plan-charged");
      const engine = {
        spawners: {
          codex: async () => ({
            ok: false as const,
            text: "",
            durationMs: 1,
            error: "codex exited 1: the model produced nothing usable",
          }),
        },
        probeBilling,
      };
      await expect(
        runGovernor({ coordRoot: root, goalId: "goal-plan-charged", engine }),
      ).rejects.toThrow();
      const charged = readGovernor(root, "goal-plan-charged");
      // No class ⇒ a charged replan: replans_used and replans_remaining move
      // together, the pre-ADR-0046 behaviour.
      expect(charged.plans.at(-1)?.class).toBeUndefined();
      expect(charged.projection.replans_used).toBe(1);
      expect(charged.projection.replans_remaining).toBe(
        (charged.intent.replanning?.max_replans ?? 0) - 1,
      );
    });
  });

  test("attributes replan exhaustion by planner no-proposal to the planner, not review", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "no-proposal-root",
      title: "No proposal root",
      objective: "Exhaust the replan budget without any proposal",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createGovernor({
      coordRoot: root,
      id: "goal-no-proposal",
      rootWorkId: "no-proposal-root",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
      replanning: {
        plannerSpecialist: "planner",
        maxReplans: 1,
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    const report = await runGovernor({
      coordRoot: root,
      goalId: "goal-no-proposal",
      engine: {
        spawners: {
          codex: async () => ({
            ok: true,
            text: JSON.stringify({
              decision: "attention",
              rationale: "The goal needs an operator decision",
              root: "",
              work: [],
            }),
            durationMs: 1,
          }),
        },
        probeBilling,
      },
    });
    expect(report.stop_reason).toBe("awaiting_attention");
    const projection = readGovernor(root, "goal-no-proposal").projection;
    expect(projection.next_action).toBe("none");
    // The single consumed replan is a planner no-proposal outcome, not a
    // reviewer rejection, and must never read as review-round exhaustion.
    expect(projection.replan_consumption).toEqual({
      reviewer_rejection: 0,
      planner_no_proposal: 1,
    });
    expect(projection.reason).toContain("no proposal");
    expect(projection.reason).not.toContain("review");
  });

  test("attributes replan exhaustion by reviewer rejection to review, unchanged", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "reviewer-rejection-root",
      title: "Reviewer rejection root",
      objective: "Exhaust the replan budget through review rejection",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createGovernor({
      coordRoot: root,
      id: "goal-reviewer-rejection",
      rootWorkId: "reviewer-rejection-root",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        reviewer: { instructions: "Review", adapter: "codex" },
      },
      replanning: {
        plannerSpecialist: "planner",
        maxReplans: 1,
        review: { reviewerSpecialists: ["reviewer"], maxRevisionRounds: 0 },
        templates: { repair: { workflowPath: passing, maxAttempts: 1, root: true } },
      },
    });
    const report = await runGovernor({
      coordRoot: root,
      goalId: "goal-reviewer-rejection",
      engine: {
        spawners: {
          codex: async (request) => {
            if (request.prompt.includes("Review this bounded")) {
              return {
                ok: true,
                text: reviewVerdict("revise", [
                  {
                    severity: "blocking",
                    summary: "The candidate still misses acceptance evidence",
                  },
                ]),
                durationMs: 1,
              };
            }
            return { ok: true, text: replacementProposal(), durationMs: 1 };
          },
        },
        probeBilling,
      },
    });
    expect(report.stop_reason).toBe("awaiting_attention");
    const projection = readGovernor(root, "goal-reviewer-rejection").projection;
    expect(projection.next_action).toBe("none");
    // A reviewer rejection has no planner no-proposal history, so the projection
    // is byte-for-byte the pre-change output: no attribution field and the
    // review-derived reason verbatim.
    expect(projection.replan_consumption).toBeUndefined();
    expect(projection.reason).toBe("plan review exhausted its bounded revision rounds");
  });

  test("names the planner no-proposal mix in the reason when the latest plan is a reviewer rejection", async () => {
    const { root, passing, failing } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "mixed-consumption-root",
      title: "Mixed consumption root",
      objective: "Spend the replan budget on a planner no-proposal then a review rejection",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createGovernor({
      coordRoot: root,
      id: "goal-mixed-consumption",
      rootWorkId: "mixed-consumption-root",
      specialists: {
        planner: { instructions: "Plan", adapter: "codex" },
        reviewer: { instructions: "Review", adapter: "codex" },
      },
      replanning: {
        plannerSpecialist: "planner",
        maxReplans: 2,
        review: { reviewerSpecialists: ["reviewer"], maxRevisionRounds: 0 },
        templates: { repair: { workflowPath: passing, maxAttempts: 1, root: true } },
      },
    });
    let plannerRuns = 0;
    const spawner: Spawner = async (request) => {
      if (request.prompt.includes("Review this bounded")) {
        return {
          ok: true,
          text: reviewVerdict("revise", [
            { severity: "blocking", summary: "The candidate still misses acceptance evidence" },
          ]),
          durationMs: 1,
        };
      }
      plannerRuns++;
      // First replan produces no proposal; the second produces a reviewable
      // proposal that review then rejects, so the LATEST consumed replan is a
      // reviewer rejection while an earlier one is a planner no-proposal.
      if (plannerRuns === 1) {
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
      }
      return { ok: true, text: replacementProposal(), durationMs: 1 };
    };
    const first = await runGovernor({
      coordRoot: root,
      goalId: "goal-mixed-consumption",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(first.projection.next_action).toBe("retry_plan");
    retryGovernorPlan({
      coordRoot: root,
      goalId: "goal-mixed-consumption",
      planId: first.projection.attention_plan_id!,
      actor: "operator",
      reason: "Operator addressed the judgment; replan once more",
    });
    const second = await runGovernor({
      coordRoot: root,
      goalId: "goal-mixed-consumption",
      engine: { spawners: { codex: spawner }, probeBilling },
    });
    expect(second.stop_reason).toBe("awaiting_attention");
    const projection = readGovernor(root, "goal-mixed-consumption").projection;
    expect(projection.next_action).toBe("none");
    expect(projection.replan_consumption).toEqual({
      reviewer_rejection: 1,
      planner_no_proposal: 1,
    });
    // The projection.reason field itself — not only the rendered row — must name
    // the planner no-proposal share while preserving the latest plan's own
    // per-plan reason. This assertion fails if the attribution is reverted to
    // returning the review reason verbatim.
    expect(projection.reason).toContain("plan review exhausted its bounded revision rounds");
    expect(projection.reason).toContain("no proposal");
  });
});

function replacementProposal(
  options: { rationale?: string; objective?: string; title?: string } = {},
): string {
  return JSON.stringify({
    decision: "apply",
    rationale: options.rationale ?? "Replace the terminal approach with one focused recovery item",
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
