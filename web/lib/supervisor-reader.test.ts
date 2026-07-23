import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSupervisor } from "harnery/core/supervisor";
import { createWorkItem } from "harnery/core/work";
import {
  readSupervisorBackgroundService,
  readSupervisorGoal,
  readSupervisors,
  supervisorDashboardDecision,
  supervisorPlanDashboardStatus,
} from "./supervisor-reader";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("supervisor dashboard reader", () => {
  test("reads list and detail through the state-only export", () => {
    const root = mkdtempSync(join("/tmp", "harnery-supervisor-web-"));
    roots.push(root);
    const workflowPath = join(root, "workflow.mjs");
    writeFileSync(workflowPath, "export default async () => 'ok';\n");
    createWorkItem({
      coordRoot: root,
      id: "dashboard-work",
      title: "Dashboard work",
      objective: "Render durable state",
      workflowPath,
    });
    createSupervisor({
      coordRoot: root,
      id: "dashboard-goal",
      rootWorkId: "dashboard-work",
      specialists: { reviewer: { instructions: "Review carefully" } },
    });

    expect(readSupervisors(root).map((record) => record.intent.id)).toEqual(["dashboard-goal"]);
    expect(readSupervisorGoal(root, "dashboard-goal")?.projection.state).toBe("ready");
    expect(readSupervisorGoal(root, "dashboard-goal")?.projection.plan_generation).toBe(0);
    expect(readSupervisorGoal(root, "dashboard-goal")?.plans).toEqual([]);
    expect(readSupervisorGoal(root, "../escape")).toBeNull();
    expect(readSupervisorBackgroundService(root)).toEqual({ running: false, stale: false });
  });

  test("reports reviewed proposals as awaiting decision instead of unreviewed", () => {
    const root = mkdtempSync(join("/tmp", "harnery-supervisor-web-"));
    roots.push(root);
    const workflowPath = join(root, "workflow.mjs");
    writeFileSync(workflowPath, "export default async () => 'ok';\n");
    createWorkItem({
      coordRoot: root,
      id: "reviewed-root",
      title: "Reviewed root",
      objective: "Need a reviewed replacement",
      workflowPath,
    });
    createSupervisor({
      coordRoot: root,
      id: "reviewed-goal",
      rootWorkId: "reviewed-root",
      specialists: {
        planner: { instructions: "Plan carefully" },
        reviewer: { instructions: "Review carefully" },
      },
      replanning: {
        plannerSpecialist: "planner",
        review: { reviewerSpecialists: ["reviewer"], maxRevisionRounds: 1 },
        templates: { repair: { workflowPath, root: true } },
      },
    });

    const planId = "plan-0001-deadbeef";
    const planDir = join(root, ".harnery", "supervisors", "reviewed-goal", "plans", planId);
    mkdirSync(planDir, { recursive: true, mode: 0o700 });
    writeJson(join(planDir, "request.json"), {
      schema_version: 1,
      id: planId,
      goal_id: "reviewed-goal",
      sequence: 1,
      trigger: "recovery",
      trigger_fingerprint: "fingerprint",
      prior_root_work_id: "reviewed-root",
      workflow_run_id: "run-reviewed-plan",
      created_at: "2026-07-22T00:00:00.000Z",
    });
    const proposal = {
      schema_version: 1,
      plan_id: planId,
      decision: "apply",
      rationale: "Use the reviewed repair plan",
      root: "repair",
      work: [
        {
          key: "repair",
          title: "Repair",
          objective: "Repair the root workflow",
          acceptance: ["Repair succeeds"],
          dependencies: [],
          template: "repair",
        },
      ],
      proposed_at: "2026-07-22T00:01:00.000Z",
    };
    writeJson(join(planDir, "proposal.json"), proposal);
    const candidateSha256 = candidateDigestForTest(proposal);
    writeJson(join(planDir, "review.json"), {
      schema_version: 1,
      plan_id: planId,
      status: "passed",
      candidate_sha256: candidateSha256,
      final_candidate: proposal,
      rounds: [
        {
          round: 1,
          candidate_sha256: candidateSha256,
          reviewers: [
            {
              specialist: "reviewer",
              verdict: "approve",
              rationale: "The proposal is bounded and ready",
              findings: [],
            },
          ],
          outcome: "approved",
        },
      ],
    });
    writeFileSync(
      join(planDir, "events.jsonl"),
      `${JSON.stringify({
        schema_version: 1,
        plan_id: planId,
        seq: 1,
        ts: "2026-07-22T00:02:00.000Z",
        event: "plan.reviewed",
        actor: "supervisor",
        reason: "review passed",
      })}\n${JSON.stringify({
        schema_version: 1,
        plan_id: planId,
        seq: 2,
        ts: "2026-07-22T00:02:01.000Z",
        event: "plan.proposed",
        actor: "supervisor",
        reason: "reviewed proposal is ready for an authority decision",
      })}\n`,
    );

    const record = readSupervisorGoal(root, "reviewed-goal")!;
    const plan = record.plans[0];
    expect(plan?.status).toBe("proposed");
    expect(plan?.review).toEqual({
      status: "passed",
      candidate_sha256: candidateSha256,
      rounds: 1,
      blocking_findings: 0,
      advisory_findings: 0,
    });
    expect(supervisorPlanDashboardStatus(plan!)).toMatchObject({
      state: "proposal_review_passed",
      label: "review passed",
      badgeVariant: "info",
      requiresReview: false,
      requiresDecision: true,
      reviewLabel: "passed · 1 review round · 0 blocking · 0 advisory",
    });
    expect(supervisorDashboardDecision(record)).toEqual({
      nextAction: "approve_or_reject_plan",
      reason: `Plan ${planId} passed independent review and awaits explicit approval or rejection.`,
    });
    expect(
      supervisorPlanDashboardStatus({
        ...plan!,
        proposal: undefined,
        status: "attention",
        review: { ...plan!.review!, status: "revision_exhausted", blocking_findings: 1 },
      }),
    ).toMatchObject({
      state: "proposal_revision_exhausted",
      label: "revision exhausted",
      badgeVariant: "warning",
      requiresReview: false,
      requiresDecision: false,
      reviewLabel: "revision exhausted · 1 review round · 1 blocking · 0 advisory",
    });
    expect(
      supervisorPlanDashboardStatus({
        ...plan!,
        proposal: undefined,
        status: "retry_requested",
        review: { ...plan!.review!, status: "revision_exhausted", blocking_findings: 1 },
      }),
    ).toMatchObject({
      state: "retry_requested",
      label: "retry requested",
      badgeVariant: "info",
      requiresReview: false,
      requiresDecision: false,
      reviewLabel: "revision exhausted · 1 review round · 1 blocking · 0 advisory",
    });
  });
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function candidateDigestForTest(candidate: unknown): string {
  const source = candidate as {
    schema_version: unknown;
    plan_id: unknown;
    decision: unknown;
    rationale: unknown;
    root: unknown;
    work: unknown;
    milestone?: unknown;
  };
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema_version: source.schema_version,
        plan_id: source.plan_id,
        decision: source.decision,
        rationale: source.rationale,
        root: source.root,
        work: source.work,
        milestone: source.milestone,
      }),
    )
    .digest("hex");
}
