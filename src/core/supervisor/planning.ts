import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createWorkItem, readWorkItem } from "../work/index.ts";
import {
  digestResult,
  type EngineOpts,
  type ResultDigest,
  readWorkflowProof,
  runWorkflow,
  type StageSchema,
  WorkflowParkedError,
  type WorkflowProof,
  workflowScriptDigest,
} from "../workflow/index.ts";
import {
  readSupervisorPlan,
  readSupervisorPlanReviewReceipt,
  readSupervisorPlans,
} from "./plan-read.ts";
import {
  SUPERVISOR_PLAN_SCHEMA_VERSION,
  type SupervisorPlanEvent,
  type SupervisorPlanMilestone,
  type SupervisorPlanOutcome,
  type SupervisorPlanProposal,
  type SupervisorPlanRequest,
  type SupervisorPlanReviewFinding,
  type SupervisorPlanReviewReceipt,
  type SupervisorPlanReviewReviewer,
  type SupervisorPlanReviewRound,
  type SupervisorPlanWorkSpec,
  type SupervisorReplanningPolicy,
  supervisorGraphFingerprint,
} from "./plan-types.ts";
import type { SupervisorRecord } from "./state.ts";

const PLAN_KEY = /^[a-z][a-z0-9-]{0,31}$/;
const TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_EVENTS_BYTES = 512 * 1024;
const MAX_REASON = 2_000;
const PROPOSAL_ROOT_RULE =
  "proposal.root names one newly proposed work key using a root-capable template; it does not preserve or repeat active_root, which is context only";

export interface RunSupervisorPlannerInput {
  coordRoot: string;
  record: SupervisorRecord;
  engine: Omit<EngineOpts, "coordRoot" | "runId" | "resumeRunId" | "specialists">;
  actor: string;
  onLog?: (line: string) => void;
}

export async function runSupervisorPlanner(
  input: RunSupervisorPlannerInput,
): Promise<SupervisorPlanOutcome> {
  const coordRoot = resolve(input.coordRoot);
  const policy = input.record.intent.replanning;
  if (!policy) throw new Error(`supervisor ${input.record.intent.id} does not allow replanning`);
  const history = readSupervisorPlans(
    coordRoot,
    input.record.intent.id,
    input.record.intent.root_work_id,
  );
  const triggerFingerprint = supervisorGraphFingerprint({
    rootWorkId: input.record.projection.root_work_id,
    generation: input.record.projection.plan_generation,
    work: input.record.work,
  });
  const trigger = planTrigger(input.record);
  const resumable =
    history.latest?.status === "resumable" &&
    history.latest.request.trigger_fingerprint === triggerFingerprint &&
    history.latest.request.prior_root_work_id === input.record.projection.root_work_id
      ? history.latest
      : undefined;
  const interrupted =
    !resumable &&
    history.latest?.status === "interrupted" &&
    history.latest.request.trigger_fingerprint === triggerFingerprint &&
    history.latest.request.prior_root_work_id === input.record.projection.root_work_id &&
    policy.review &&
    hasReviewRecoveryEvidence(coordRoot, input.record.intent.id, history.latest.request.id)
      ? history.latest
      : undefined;
  const request =
    resumable || interrupted
      ? (resumable ?? interrupted)!.request
      : createPlanRequest(
          coordRoot,
          input.record,
          history.plans.length + 1,
          triggerFingerprint,
          trigger,
        );
  const scriptPath = planScriptPath(coordRoot, input.record.intent.id, request.id);
  if (resumable) {
    appendPlanEvent(coordRoot, input.record.intent.id, request.id, {
      event: "plan.resumed",
      actor: input.actor,
      reason: `resuming planning workflow after approval ${resumable.approval_id}`,
      approval_id: resumable.approval_id,
    });
  }
  if (interrupted) {
    const recovered = await recoverReviewedPlan({
      coordRoot,
      record: input.record,
      request,
      history,
      trigger: request.trigger ?? "recovery",
      policy,
      actor: input.actor,
    });
    if (recovered) return recovered;
  }
  let proposalWritten = false;
  try {
    const reviewRunId = reviewWorkflowRunId(request.id);
    const resumingReview = Boolean(
      resumable &&
        policy.review &&
        existsSync(reviewInputPath(coordRoot, input.record.intent.id, request.id)) &&
        existsSync(join(coordRoot, ".harnery", "workflows", reviewRunId, "run.json")),
    );
    const reviewInput = resumingReview
      ? readBoundedJson<{ candidate: unknown }>(
          reviewInputPath(coordRoot, input.record.intent.id, request.id),
          "supervisor plan review input",
        )
      : undefined;
    const rawProposal = reviewInput
      ? reviewInput.candidate
      : (
          await runWorkflow(scriptPath, {
            ...input.engine,
            coordRoot,
            ...(resumable
              ? { resumeRunId: request.workflow_run_id }
              : { runId: request.workflow_run_id }),
            specialists: input.record.intent.specialists,
            maxAgents: 1,
            concurrency: 1,
            onLog: input.onLog,
          })
        ).result;
    const proposal = normalizeProposal(
      request.id,
      rawProposal,
      input.record,
      history.materialized_work_ids.length,
      request.trigger ?? "recovery",
      reviewInput ? persistedProposalTimestamp(reviewInput.candidate) : undefined,
    );
    if (policy.review) {
      if (proposal.decision === "attention") {
        appendPlanEvent(coordRoot, input.record.intent.id, request.id, {
          event: "plan.attention",
          actor: input.actor,
          reason: proposal.rationale,
        });
        return outcome(readSupervisorPlan(coordRoot, input.record.intent.id, request.id));
      }
      let receipt: SupervisorPlanReviewReceipt;
      try {
        receipt = await ensurePlanReview({
          coordRoot,
          record: input.record,
          request,
          proposal,
          history,
          trigger: request.trigger ?? "recovery",
          policy,
          engine: input.engine,
          actor: input.actor,
          onLog: input.onLog,
        });
      } catch (error) {
        if (error instanceof WorkflowParkedError) throw error;
        appendPlanEvent(coordRoot, input.record.intent.id, request.id, {
          event: "plan.attention",
          actor: input.actor,
          reason: bounded(
            `plan review requires attention: ${(error as Error).message}`,
            "plan review attention",
            MAX_REASON,
          ),
        });
        return outcome(readSupervisorPlan(coordRoot, input.record.intent.id, request.id));
      }
      return finalizeReviewedProposal({
        coordRoot,
        record: input.record,
        request,
        receipt,
        policy,
        actor: input.actor,
      });
    }
    writeExclusiveJson(
      planProposalPath(coordRoot, input.record.intent.id, request.id),
      proposal,
      "supervisor plan proposal",
    );
    appendPlanEvent(coordRoot, input.record.intent.id, request.id, {
      event: "plan.proposed",
      actor: input.actor,
      reason: proposal.rationale,
    });
    proposalWritten = true;
    if (proposal.decision === "attention") {
      appendPlanEvent(coordRoot, input.record.intent.id, request.id, {
        event: "plan.attention",
        actor: input.actor,
        reason: proposal.rationale,
      });
      return outcome(readSupervisorPlan(coordRoot, input.record.intent.id, request.id));
    }
    if (policy.auto_apply) {
      return applySupervisorPlanProposal({
        coordRoot,
        record: input.record,
        planId: request.id,
        actor: input.actor,
        reason: "proposal applied by frozen supervisor replanning policy",
      });
    }
    return outcome(readSupervisorPlan(coordRoot, input.record.intent.id, request.id));
  } catch (error) {
    if (proposalWritten) throw error;
    if (error instanceof WorkflowParkedError) {
      appendPlanEvent(coordRoot, input.record.intent.id, request.id, {
        event: "plan.awaiting_approval",
        actor: input.actor,
        reason: `planning workflow parked for approval ${error.approvalId}`,
        approval_id: error.approvalId,
      });
      return outcome(readSupervisorPlan(coordRoot, input.record.intent.id, request.id));
    }
    appendPlanEvent(coordRoot, input.record.intent.id, request.id, {
      event: "plan.failed",
      actor: input.actor,
      reason: bounded((error as Error).message, "plan failure", MAX_REASON),
    });
    throw error;
  }
}

async function recoverReviewedPlan(input: {
  coordRoot: string;
  record: SupervisorRecord;
  request: SupervisorPlanRequest;
  history: ReturnType<typeof readSupervisorPlans>;
  trigger: NonNullable<SupervisorPlanRequest["trigger"]>;
  policy: SupervisorReplanningPolicy;
  actor: string;
}): Promise<SupervisorPlanOutcome | undefined> {
  const review = input.policy.review;
  if (!review) return undefined;
  const existing = readSupervisorPlanReviewReceipt(
    input.coordRoot,
    input.record.intent.id,
    input.request.id,
  );
  const receipt =
    existing ??
    reconstructReviewReceiptFromProof({
      coordRoot: input.coordRoot,
      record: input.record,
      request: input.request,
      history: input.history,
      trigger: input.trigger,
      policy: input.policy,
    });
  if (!receipt) return undefined;
  if (!existing) {
    writeExclusiveJson(
      reviewReceiptPath(input.coordRoot, input.record.intent.id, input.request.id),
      receipt,
      "supervisor plan review receipt",
    );
  }
  return finalizeReviewedProposal({
    coordRoot: input.coordRoot,
    record: input.record,
    request: input.request,
    receipt,
    policy: input.policy,
    actor: input.actor,
  });
}

async function ensurePlanReview(input: {
  coordRoot: string;
  record: SupervisorRecord;
  request: SupervisorPlanRequest;
  proposal: SupervisorPlanProposal;
  history: ReturnType<typeof readSupervisorPlans>;
  trigger: NonNullable<SupervisorPlanRequest["trigger"]>;
  policy: SupervisorReplanningPolicy;
  engine: Omit<EngineOpts, "coordRoot" | "runId" | "resumeRunId" | "specialists">;
  actor: string;
  onLog?: (line: string) => void;
}): Promise<SupervisorPlanReviewReceipt> {
  const existing = readSupervisorPlanReviewReceipt(
    input.coordRoot,
    input.record.intent.id,
    input.request.id,
  );
  if (existing) return existing;
  const reconstructed = reconstructReviewReceiptFromProof(input);
  if (reconstructed) {
    writeExclusiveJson(
      reviewReceiptPath(input.coordRoot, input.record.intent.id, input.request.id),
      reconstructed,
      "supervisor plan review receipt",
    );
    return reconstructed;
  }
  const reviewScript = reviewScriptPath(input.coordRoot, input.record.intent.id, input.request.id);
  writeExclusiveJson(
    reviewInputPath(input.coordRoot, input.record.intent.id, input.request.id),
    { candidate: input.proposal },
    "supervisor plan review input",
  );
  writeExclusive(
    reviewScript,
    plannerReviewScript(input.record, input.request.id, input.proposal, input.trigger),
    "supervisor plan review script",
  );
  const review = input.policy.review!;
  const runId = reviewWorkflowRunId(input.request.id);
  const runExists = existsSync(join(input.coordRoot, ".harnery", "workflows", runId, "run.json"));
  const report = await runWorkflow(reviewScript, {
    ...input.engine,
    coordRoot: input.coordRoot,
    ...(runExists ? { resumeRunId: runId } : { runId }),
    specialists: input.record.intent.specialists,
    maxAgents:
      review.reviewer_specialists.length * (review.max_revision_rounds + 1) +
      review.max_revision_rounds,
    concurrency: input.record.intent.limits.agent_concurrency,
    onLog: input.onLog,
  });
  const receipt = normalizeReviewReceipt({
    raw: report.result,
    initialCandidate: input.proposal,
    record: input.record,
    request: input.request,
    history: input.history,
    trigger: input.trigger,
    policy: input.policy,
  });
  writeExclusiveJson(
    reviewReceiptPath(input.coordRoot, input.record.intent.id, input.request.id),
    receipt,
    "supervisor plan review receipt",
  );
  return receipt;
}

function finalizeReviewedProposal(input: {
  coordRoot: string;
  record: SupervisorRecord;
  request: SupervisorPlanRequest;
  receipt: SupervisorPlanReviewReceipt;
  policy: SupervisorReplanningPolicy;
  actor: string;
}): SupervisorPlanOutcome {
  if (input.receipt.status !== "passed") {
    const event = input.receipt.status === "failed" ? "plan.failed" : "plan.attention";
    appendPlanEventIfMissing(input.coordRoot, input.record.intent.id, input.request.id, event, {
      event,
      actor: input.actor,
      reason: reviewStatusReason(input.receipt),
    });
    return outcome(readSupervisorPlan(input.coordRoot, input.record.intent.id, input.request.id));
  }
  // The review authority must become durable before the proposal can become
  // visible. If the process stops after this event, the plan remains
  // interrupted and proof-backed recovery can reconstruct the proposal. The
  // opposite order can expose an unapprovable proposal with no recovery path.
  appendPlanEventIfMissing(
    input.coordRoot,
    input.record.intent.id,
    input.request.id,
    "plan.reviewed",
    {
      event: "plan.reviewed",
      actor: input.actor,
      reason: `plan review passed after ${input.receipt.rounds.length} round(s)`,
    },
  );
  writeExclusiveJson(
    planProposalPath(input.coordRoot, input.record.intent.id, input.request.id),
    input.receipt.final_candidate,
    "supervisor plan proposal",
  );
  appendPlanEventIfMissing(
    input.coordRoot,
    input.record.intent.id,
    input.request.id,
    "plan.proposed",
    {
      event: "plan.proposed",
      actor: input.actor,
      reason: input.receipt.final_candidate.rationale,
    },
  );
  if (input.policy.auto_apply) {
    return applySupervisorPlanProposal({
      coordRoot: input.coordRoot,
      record: input.record,
      planId: input.request.id,
      actor: input.actor,
      reason: "proposal applied by frozen supervisor replanning policy",
    });
  }
  return outcome(readSupervisorPlan(input.coordRoot, input.record.intent.id, input.request.id));
}

function reviewStatusReason(receipt: SupervisorPlanReviewReceipt): string {
  if (receipt.status === "revision_exhausted") {
    return "plan review exhausted its bounded revision rounds";
  }
  if (receipt.status === "failed") return "plan review failed";
  return "plan review requires attention";
}

export function applySupervisorPlanProposal(input: {
  coordRoot: string;
  record: SupervisorRecord;
  planId: string;
  actor: string;
  reason?: string;
}): SupervisorPlanOutcome {
  const coordRoot = resolve(input.coordRoot);
  const policy = input.record.intent.replanning;
  if (!policy) throw new Error(`supervisor ${input.record.intent.id} does not allow replanning`);
  const plan = readSupervisorPlan(coordRoot, input.record.intent.id, input.planId);
  if (plan.status === "applied" || plan.status === "completed") return outcome(plan);
  if (
    plan.status !== "proposed" ||
    !plan.proposal ||
    !["apply", "complete"].includes(plan.proposal.decision)
  ) {
    throw new Error(`supervisor plan ${input.planId} cannot be applied from ${plan.status}`);
  }
  if (policy.review) {
    const receipt = readSupervisorPlanReviewReceipt(
      coordRoot,
      input.record.intent.id,
      input.planId,
    );
    if (receipt?.status !== "passed") {
      throw new Error(`supervisor plan ${input.planId} has no passed review receipt`);
    }
    if (candidateDigest(plan.proposal) !== receipt.candidate_sha256) {
      throw new Error(`supervisor plan ${input.planId} proposal does not match its passed review`);
    }
    if (!plan.events.some((event) => event.event === "plan.reviewed")) {
      throw new Error(`supervisor plan ${input.planId} has no reviewed authority event`);
    }
  }
  if (plan.request.prior_root_work_id !== input.record.projection.root_work_id) {
    throw new Error(
      `supervisor plan ${input.planId} targets stale root ${plan.request.prior_root_work_id}`,
    );
  }
  const history = readSupervisorPlans(
    coordRoot,
    input.record.intent.id,
    input.record.intent.root_work_id,
  );
  const proposal = normalizeProposal(
    input.planId,
    plan.proposal,
    input.record,
    history.materialized_work_ids.filter((workId) => !workId.startsWith(`${input.planId}-`)).length,
    plan.request.trigger ?? "recovery",
  );
  if (proposal.decision === "complete") {
    appendPlanEvent(coordRoot, input.record.intent.id, input.planId, {
      event: "plan.completed",
      actor: input.actor,
      reason: input.reason ?? proposal.rationale,
    });
    return outcome(readSupervisorPlan(coordRoot, input.record.intent.id, input.planId));
  }
  const ids = new Map<string, string>();
  const created: string[] = [];
  for (const spec of proposal.work) {
    const template = policy.templates[spec.template];
    if (!template)
      throw new Error(`plan work ${spec.key} references unknown template ${spec.template}`);
    if (workflowScriptDigest(template.workflow.path) !== template.workflow.sha256) {
      throw new Error(`replanning template ${spec.template} changed after goal creation`);
    }
    const workId = `${input.planId}-${spec.key}`;
    const dependencies = spec.dependencies.map((dependency) => ids.get(dependency) ?? dependency);
    const expected = {
      title: spec.title,
      objective: spec.objective,
      acceptance: spec.acceptance,
      dependencies,
      workflow: template.workflow,
      max_attempts: template.max_attempts,
      source: {
        kind: "workflow" as const,
        ref: `supervisor:${input.record.intent.id}/plan:${input.planId}`,
      },
    };
    if (existsSync(join(coordRoot, ".harnery", "work", workId, "intent.json"))) {
      const current = readWorkItem(coordRoot, workId).intent;
      const actual = {
        title: current.title,
        objective: current.objective,
        acceptance: current.acceptance,
        dependencies: current.dependencies,
        workflow: current.workflow,
        max_attempts: current.max_attempts,
        source: current.source,
      };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`partial plan work ${workId} conflicts with the durable proposal`);
      }
    } else {
      createWorkItem({
        coordRoot,
        id: workId,
        title: spec.title,
        objective: spec.objective,
        acceptance: spec.acceptance,
        dependencies,
        workflowPath: template.workflow.path,
        maxAttempts: template.max_attempts,
        source: expected.source,
        actor: input.actor,
      });
    }
    ids.set(spec.key, workId);
    created.push(workId);
  }
  const rootWorkId = ids.get(proposal.root);
  if (!rootWorkId) throw new Error(`plan root ${proposal.root} was not materialized`);
  appendPlanEvent(coordRoot, input.record.intent.id, input.planId, {
    event: "plan.applied",
    actor: input.actor,
    reason: input.reason ?? "supervisor plan explicitly approved",
    root_work_id: rootWorkId,
    work_ids: created,
  });
  return outcome(readSupervisorPlan(coordRoot, input.record.intent.id, input.planId));
}

export function rejectSupervisorPlanProposal(input: {
  coordRoot: string;
  goalId: string;
  planId: string;
  actor: string;
  reason: string;
}): SupervisorPlanOutcome {
  const plan = readSupervisorPlan(input.coordRoot, input.goalId, input.planId);
  if (plan.status === "rejected") return outcome(plan);
  if (plan.status !== "proposed") {
    throw new Error(`supervisor plan ${input.planId} cannot be rejected from ${plan.status}`);
  }
  appendPlanEvent(input.coordRoot, input.goalId, input.planId, {
    event: "plan.rejected",
    actor: input.actor,
    reason: input.reason,
  });
  return outcome(readSupervisorPlan(input.coordRoot, input.goalId, input.planId));
}

function createPlanRequest(
  coordRoot: string,
  record: SupervisorRecord,
  sequence: number,
  triggerFingerprint: string,
  trigger: NonNullable<SupervisorPlanRequest["trigger"]>,
): SupervisorPlanRequest {
  const policy = record.intent.replanning;
  if (!policy) throw new Error(`supervisor ${record.intent.id} does not allow replanning`);
  if (sequence > policy.max_replans) {
    throw new Error(`supervisor ${record.intent.id} exhausted its ${policy.max_replans} replans`);
  }
  const planId = `plan-${String(sequence).padStart(4, "0")}-${randomBytes(4).toString("hex")}`;
  const request: SupervisorPlanRequest = {
    schema_version: SUPERVISOR_PLAN_SCHEMA_VERSION,
    id: planId,
    goal_id: record.intent.id,
    sequence,
    trigger,
    trigger_fingerprint: triggerFingerprint,
    prior_root_work_id: record.projection.root_work_id,
    workflow_run_id: `${planId}-workflow`,
    created_at: new Date().toISOString(),
  };
  const script = plannerScript(coordRoot, record, planId, trigger);
  const dir = planDir(coordRoot, record.intent.id, planId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeExclusiveJson(join(dir, "request.json"), request, "supervisor plan request");
  writeExclusive(join(dir, "planner.mjs"), script, "supervisor planner script");
  return request;
}

function plannerScript(
  coordRoot: string,
  record: SupervisorRecord,
  planId: string,
  trigger: NonNullable<SupervisorPlanRequest["trigger"]>,
): string {
  const policy = record.intent.replanning;
  if (!policy) throw new Error(`supervisor ${record.intent.id} does not allow replanning`);
  const prompt = [
    "You are producing one bounded replacement plan or milestone decision for a durable supervised goal.",
    record.intent.mission
      ? "Return decision=apply with the next immutable milestone graph, decision=complete only when mission acceptance is met, or decision=attention when human judgment is required."
      : "Return decision=apply with a replacement immutable root graph, or decision=attention when human judgment is required.",
    "Never claim mission completion unless the frozen mission acceptance is met. Never request a workflow outside the frozen template catalog.",
    "Dependencies may name an active work ID or an earlier key in your proposed work array.",
    `Every proposed item must be reachable from root. ${PROPOSAL_ROOT_RULE}.`,
    "Work keys are lowercase identifiers no longer than 32 characters. Keep titles within 200 characters, objectives within 4000 characters, and each acceptance criterion within 500 characters.",
    `Plan id: ${planId}`,
    `Planning trigger: ${trigger}`,
    `Goal: ${record.intent.title}`,
    `Mission: ${JSON.stringify(record.intent.mission ?? null)}`,
    `Original root: ${record.intent.root_work_id}`,
    `Active root: ${record.projection.root_work_id}`,
    `Remaining work attempts: ${record.projection.attempts_remaining}`,
    `Remaining replans: ${record.projection.replans_remaining}`,
    `Completed milestones: ${record.projection.milestones_completed}`,
    `Remaining milestones: ${record.projection.milestones_remaining}`,
    `Latest planner outcome: ${JSON.stringify(
      record.plans.at(-1)
        ? {
            status: record.plans.at(-1)?.status,
            reason: record.plans.at(-1)?.reason,
          }
        : null,
    )}`,
    `Templates: ${JSON.stringify(policy.templates)}`,
    `Active work: ${JSON.stringify(
      record.work.map((work) => ({
        id: work.intent.id,
        title: work.intent.title,
        objective: work.intent.objective,
        acceptance: work.intent.acceptance,
        dependencies: work.intent.dependencies,
        state: work.projection.state,
        reason: work.projection.reason,
        proof: work.projection.proof_path
          ? (() => {
              const proof = readWorkflowProof(coordRoot, work.projection.latest_run_id!);
              return {
                run_id: proof.run.id,
                status: proof.run.status,
                acceptance: proof.acceptance.summary,
                repository: {
                  head_changed: proof.repository.drift.head_changed,
                  dirty_paths_added: proof.repository.drift.dirty_paths_added,
                  incomplete: proof.repository.drift.incomplete,
                },
                unknowns: proof.unknowns.map((unknown) => unknown.code),
              };
            })()
          : null,
      })),
    )}`,
  ].join("\n\n");
  const schema = planProposalSchema(record, trigger);
  return [
    `export const meta = ${JSON.stringify({ name: `replan-${planId}` })};`,
    "export default async ({ agent, stage }) => {",
    `  stage(${JSON.stringify(
      trigger === "initial"
        ? "Plan initial mission milestone"
        : trigger === "milestone"
          ? "Reassess completed milestone"
          : "Replan blocked goal",
    )});`,
    `  return await agent(${JSON.stringify(prompt)}, ${JSON.stringify({
      specialist: policy.planner_specialist,
      schema,
      label: "Produce bounded replacement plan",
    })});`,
    "};",
    "",
  ].join("\n");
}

function plannerReviewScript(
  record: SupervisorRecord,
  planId: string,
  initialCandidate: SupervisorPlanProposal,
  trigger: NonNullable<SupervisorPlanRequest["trigger"]>,
): string {
  const policy = record.intent.replanning;
  const review = policy?.review;
  if (!policy || !review) throw new Error(`supervisor ${record.intent.id} does not review plans`);
  const proposalSchema = planProposalSchema(record, trigger);
  const reviewerSchema: StageSchema = {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approve", "revise", "attention"] },
      rationale: { type: "string", minLength: 1, maxLength: MAX_REASON },
      findings: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            code: {
              type: "string",
              minLength: 1,
              maxLength: 100,
              pattern: "^[a-z][a-z0-9._-]*$",
            },
            severity: { type: "string", enum: ["blocking", "advisory"] },
            summary: { type: "string", minLength: 1, maxLength: 1_000 },
            recommendation: { type: "string", minLength: 1, maxLength: 1_000 },
          },
          required: ["code", "severity", "summary", "recommendation"],
          additionalProperties: false,
        },
      },
    },
    required: ["verdict", "rationale", "findings"],
    additionalProperties: false,
  };
  return [
    `export const meta = ${JSON.stringify({ name: `review-${planId}` })};`,
    "export default async ({ agent, stage }) => {",
    `  const reviewers = ${JSON.stringify(review.reviewer_specialists)};`,
    `  const planner = ${JSON.stringify(policy.planner_specialist)};`,
    `  const maxRevisionRounds = ${JSON.stringify(review.max_revision_rounds)};`,
    `  const proposalSchema = ${JSON.stringify(proposalSchema)};`,
    `  const reviewerSchema = ${JSON.stringify(reviewerSchema)};`,
    `  const goalContext = ${JSON.stringify({
      plan_id: planId,
      trigger,
      goal: record.intent.title,
      mission: record.intent.mission ?? null,
      original_root: record.intent.root_work_id,
      active_root: record.projection.root_work_id,
      proposal_root_rule: PROPOSAL_ROOT_RULE,
      templates: policy.templates,
    })};`,
    `  let candidate = ${JSON.stringify(initialCandidate)};`,
    "  const rounds = [];",
    "  const aggregate = (items) => {",
    "    if (items.some((item) => item.verdict === 'attention')) return 'attention';",
    "    if (items.some((item) => item.verdict === 'revise')) return 'revise';",
    "    if (items.some((item) => item.findings.some((finding) => finding.severity === 'blocking'))) return 'revise';",
    "    return 'approved';",
    "  };",
    "  for (let round = 1; round <= maxRevisionRounds + 1; round++) {",
    "    stage('Review round ' + round);",
    "    const reviewersOut = await Promise.all(reviewers.map(async (specialist) => {",
    "      const prompt = [",
    "        'Review this bounded supervisor plan candidate independently.',",
    "        'Return approve only when the candidate is complete, scoped, and satisfies the goal context.',",
    "        'Return revise for blocking defects. Return attention when human judgment is required.',",
    "        'Apply proposal_root_rule exactly; never require proposal.root to equal active_root.',",
    "        'Goal context: ' + JSON.stringify(goalContext),",
    "        'Candidate: ' + JSON.stringify(candidate)",
    "      ].join('\\n\\n');",
    "      const result = await agent(prompt, {",
    "        specialist,",
    "        schema: reviewerSchema,",
    "        label: 'Review plan candidate as ' + specialist",
    "      });",
    "      return { specialist, ...result };",
    "    }));",
    "    const roundRecord = { round, candidate, reviewers: reviewersOut, outcome: aggregate(reviewersOut) };",
    "    rounds.push(roundRecord);",
    "    if (roundRecord.outcome === 'approved' || roundRecord.outcome === 'attention') break;",
    "    if (round > maxRevisionRounds) break;",
    "    stage('Revise round ' + round);",
    "    const revisionPrompt = [",
    "      'Revise this supervisor plan candidate. Return a complete replacement candidate, not a patch.',",
    "      'Do not merge reviewer text mechanically; satisfy the blocking findings within the frozen goal and template constraints.',",
    "      'Apply proposal_root_rule exactly; never require proposal.root to equal active_root.',",
    "      'Goal context: ' + JSON.stringify(goalContext),",
    "      'Current candidate: ' + JSON.stringify(candidate),",
    "      'Reviewer findings: ' + JSON.stringify(reviewersOut)",
    "    ].join('\\n\\n');",
    "    roundRecord.revision_candidate = await agent(revisionPrompt, {",
    "      specialist: planner,",
    "      schema: proposalSchema,",
    "      label: 'Revise bounded replacement plan'",
    "    });",
    "    candidate = roundRecord.revision_candidate;",
    "  }",
    "  return { rounds };",
    "};",
    "",
  ].join("\n");
}

function normalizeReviewReceipt(input: {
  raw: unknown;
  initialCandidate: SupervisorPlanProposal;
  record: SupervisorRecord;
  request: SupervisorPlanRequest;
  history: ReturnType<typeof readSupervisorPlans>;
  trigger: NonNullable<SupervisorPlanRequest["trigger"]>;
  policy: SupervisorReplanningPolicy;
}): SupervisorPlanReviewReceipt {
  const review = input.policy.review;
  if (!review) throw new Error("missing review policy");
  if (!input.raw || typeof input.raw !== "object" || Array.isArray(input.raw)) {
    throw new Error("review result must be an object");
  }
  const raw = input.raw as Record<string, unknown>;
  if (!Array.isArray(raw.rounds)) throw new Error("review result rounds must be an array");
  if (raw.rounds.length < 1 || raw.rounds.length > review.max_revision_rounds + 1) {
    throw new Error("review result has an invalid number of rounds");
  }
  const rounds: SupervisorPlanReviewRound[] = [];
  let candidate = input.initialCandidate;
  let status: SupervisorPlanReviewReceipt["status"] | undefined;
  for (const [index, rawRound] of raw.rounds.entries()) {
    if (!rawRound || typeof rawRound !== "object" || Array.isArray(rawRound)) {
      throw new Error(`review round ${index + 1} must be an object`);
    }
    if (status) throw new Error("review result contains rounds after a terminal outcome");
    const value = rawRound as Record<string, unknown>;
    const roundNumber = positive(value.round, "review round", review.max_revision_rounds + 1);
    if (roundNumber !== index + 1) throw new Error(`review round must be ${index + 1}`);
    const reviewers = normalizeReviewers(value.reviewers, review.reviewer_specialists);
    const outcome = aggregateReviewers(reviewers);
    const round: SupervisorPlanReviewRound = {
      round: roundNumber,
      candidate_sha256: candidateDigest(candidate),
      reviewers,
      outcome,
    };
    if (outcome === "approved") {
      status = "passed";
    } else if (outcome === "attention") {
      status = "attention";
    } else if (roundNumber > review.max_revision_rounds) {
      status = "revision_exhausted";
    } else {
      const revision = normalizeProposal(
        input.request.id,
        value.revision_candidate,
        input.record,
        input.history.materialized_work_ids.length,
        input.trigger,
      );
      round.revision_workflow_run_id = reviewWorkflowRunId(input.request.id);
      if (candidateDigest(revision) === candidateDigest(candidate)) {
        status = "attention";
      } else {
        candidate = revision;
      }
    }
    rounds.push(round);
  }
  status ??= "attention";
  return {
    schema_version: SUPERVISOR_PLAN_SCHEMA_VERSION,
    plan_id: input.request.id,
    status,
    candidate_sha256: candidateDigest(candidate),
    final_candidate: candidate,
    rounds,
  };
}

function normalizeReviewers(
  raw: unknown,
  expectedSpecialists: readonly string[],
): SupervisorPlanReviewReviewer[] {
  if (!Array.isArray(raw) || raw.length !== expectedSpecialists.length) {
    throw new Error("reviewer result count does not match the frozen review policy");
  }
  return raw.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`reviewer result ${index + 1} must be an object`);
    }
    const item = value as Record<string, unknown>;
    const specialist = bounded(item.specialist, `reviewer ${index + 1} specialist`, 100);
    if (specialist !== expectedSpecialists[index]) {
      throw new Error(`reviewer ${index + 1} does not match the frozen review order`);
    }
    const findings = normalizeFindings(item.findings, specialist);
    return {
      specialist,
      verdict: enumValue(item.verdict, ["approve", "revise", "attention"], "review verdict"),
      rationale: bounded(item.rationale, "review rationale", MAX_REASON),
      findings,
    };
  });
}

function normalizeFindings(raw: unknown, specialist: string): SupervisorPlanReviewFinding[] {
  if (!Array.isArray(raw) || raw.length > 50) {
    throw new Error(`review findings from ${specialist} must contain at most 50 items`);
  }
  return raw.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`review finding ${index + 1} from ${specialist} must be an object`);
    }
    const item = value as Record<string, unknown>;
    return {
      code: findingCode(item.code, specialist, index),
      severity: enumValue(item.severity, ["blocking", "advisory"], "review finding severity"),
      summary: bounded(item.summary, "review finding summary", 1_000),
      recommendation: bounded(item.recommendation, "review finding recommendation", 1_000),
    };
  });
}

function findingCode(value: unknown, specialist: string, index: number): string {
  const code = bounded(value, `review finding ${index + 1} code from ${specialist}`, 100);
  if (!/^[a-z][a-z0-9._-]*$/.test(code)) {
    throw new Error(
      `review finding ${index + 1} code from ${specialist} must be a stable lowercase identifier`,
    );
  }
  return code;
}

function aggregateReviewers(
  reviewers: readonly SupervisorPlanReviewReviewer[],
): SupervisorPlanReviewRound["outcome"] {
  if (reviewers.length < 1) return "failed";
  if (reviewers.some((reviewer) => reviewer.verdict === "attention")) return "attention";
  if (
    reviewers.some(
      (reviewer) =>
        reviewer.verdict === "revise" ||
        reviewer.findings.some((finding) => finding.severity === "blocking"),
    )
  ) {
    return "revise";
  }
  return "approved";
}

function reconstructReviewReceiptFromProof(input: {
  coordRoot: string;
  record: SupervisorRecord;
  request: SupervisorPlanRequest;
  history: ReturnType<typeof readSupervisorPlans>;
  trigger: NonNullable<SupervisorPlanRequest["trigger"]>;
  policy: SupervisorReplanningPolicy;
}): SupervisorPlanReviewReceipt | undefined {
  const runId = reviewWorkflowRunId(input.request.id);
  const proofPath = join(input.coordRoot, ".harnery", "workflows", runId, "proof.json");
  if (!existsSync(proofPath)) return undefined;
  const proof = readWorkflowProof(input.coordRoot, runId);
  if (proof.run.status !== "succeeded") return undefined;
  const raw = recoverReviewWorkflowResult(
    input.coordRoot,
    input.record.intent.id,
    input.request.id,
    proof,
    input.policy.review!.reviewer_specialists,
  );
  assertResultDigest(raw.result, proof.run.result, runId);
  return normalizeReviewReceipt({
    raw: raw.result,
    initialCandidate: raw.initialCandidate,
    record: input.record,
    request: input.request,
    history: input.history,
    trigger: input.trigger,
    policy: input.policy,
  });
}

function recoverReviewWorkflowResult(
  coordRoot: string,
  goalId: string,
  planId: string,
  proof: WorkflowProof,
  expectedSpecialists: readonly string[],
): {
  initialCandidate: SupervisorPlanProposal;
  result: { rounds: unknown[] };
} {
  const inputPath = reviewInputPath(coordRoot, goalId, planId);
  const reviewInput = readBoundedJson<{ candidate: SupervisorPlanProposal }>(
    inputPath,
    "supervisor plan review input",
  );
  const journal = readVerifiedWorkflowJournal(coordRoot, reviewWorkflowRunId(planId), proof);
  const starts = new Map<string, { specialist?: string }>();
  const byRound = new Map<number, Record<string, unknown>>();
  let currentCandidate: unknown = reviewInput.candidate;
  for (const line of journal.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.event === "agent.start" && typeof event.id === "string") {
      starts.set(event.id, {
        specialist: typeof event.specialist === "string" ? event.specialist : undefined,
      });
    }
    if (event.event !== "agent.end" || event.result_kind !== "json") continue;
    const round = workflowJournalRound(event.stage);
    if (!round) continue;
    let record = byRound.get(round.round);
    if (!record) {
      record = { round: round.round, candidate: currentCandidate, reviewers: [] };
      byRound.set(round.round, record);
    }
    if (round.kind === "review") {
      const specialist =
        typeof event.id === "string" ? starts.get(event.id)?.specialist : undefined;
      if (!event.result || typeof event.result !== "object" || Array.isArray(event.result)) {
        throw new Error("supervisor plan review journal contains an invalid reviewer result");
      }
      (record.reviewers as unknown[]).push({
        specialist,
        ...(event.result as Record<string, unknown>),
      });
    } else {
      record.revision_candidate = event.result;
      currentCandidate = event.result;
    }
  }
  const rounds = [...byRound.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => {
      const reviewers = orderRecoveredReviewers(value.reviewers, expectedSpecialists);
      const round: Record<string, unknown> = {
        round: value.round,
        candidate: value.candidate,
        reviewers,
        outcome: aggregateRecoveredReviewers(reviewers),
      };
      if (value.revision_candidate !== undefined) {
        round.revision_candidate = value.revision_candidate;
      }
      return round;
    });
  return {
    initialCandidate: reviewInput.candidate,
    result: { rounds },
  };
}

function readVerifiedWorkflowJournal(
  coordRoot: string,
  runId: string,
  proof: WorkflowProof,
): string {
  const journalPath = join(coordRoot, ".harnery", "workflows", runId, proof.integrity.journal.path);
  const journal = readFileSync(journalPath, "utf8");
  const bytes = Buffer.byteLength(journal);
  if (bytes <= 0 || bytes > MAX_RECORD_BYTES || bytes !== proof.integrity.journal.bytes) {
    throw new Error(`supervisor plan review journal does not match proof integrity`);
  }
  const sha256 = createHash("sha256").update(journal).digest("hex");
  if (sha256 !== proof.integrity.journal.sha256) {
    throw new Error(`supervisor plan review journal does not match proof integrity`);
  }
  return journal;
}

function orderRecoveredReviewers(raw: unknown, expectedSpecialists: readonly string[]): unknown[] {
  if (!Array.isArray(raw) || raw.length !== expectedSpecialists.length) return raw as unknown[];
  const expected = new Set(expectedSpecialists);
  const bySpecialist = new Map<string, unknown>();
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return raw;
    const specialist = (value as Record<string, unknown>).specialist;
    if (
      typeof specialist !== "string" ||
      !expected.has(specialist) ||
      bySpecialist.has(specialist)
    ) {
      return raw;
    }
    bySpecialist.set(specialist, value);
  }
  return expectedSpecialists.map((specialist) => bySpecialist.get(specialist));
}

function aggregateRecoveredReviewers(reviewers: readonly unknown[]): string {
  if (
    reviewers.some(
      (value) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).verdict === "attention",
    )
  ) {
    return "attention";
  }
  if (
    reviewers.some((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return true;
      const reviewer = value as Record<string, unknown>;
      return (
        reviewer.verdict === "revise" ||
        (Array.isArray(reviewer.findings) &&
          reviewer.findings.some(
            (finding) =>
              finding &&
              typeof finding === "object" &&
              !Array.isArray(finding) &&
              (finding as Record<string, unknown>).severity === "blocking",
          ))
      );
    })
  ) {
    return "revise";
  }
  return "approved";
}

function assertResultDigest(raw: unknown, expected: ResultDigest | undefined, runId: string): void {
  if (!expected) {
    throw new Error(`supervisor plan review proof ${runId} is missing its result digest`);
  }
  const actual = digestResult(raw, "json");
  if (
    actual.kind !== expected.kind ||
    actual.sha256 !== expected.sha256 ||
    actual.bytes !== expected.bytes
  ) {
    throw new Error(`supervisor plan review result does not match proof digest`);
  }
}

function workflowJournalRound(
  stage: unknown,
): { kind: "review" | "revision"; round: number } | undefined {
  if (typeof stage !== "string") return undefined;
  const review = /^Review round ([1-9][0-9]*)$/.exec(stage);
  if (review) return { kind: "review", round: Number(review[1]) };
  const revision = /^Revise round ([1-9][0-9]*)$/.exec(stage);
  if (revision) return { kind: "revision", round: Number(revision[1]) };
  return undefined;
}

function candidateDigest(candidate: SupervisorPlanProposal): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalCandidate(candidate)))
    .digest("hex");
}

function canonicalCandidate(candidate: SupervisorPlanProposal): unknown {
  return {
    schema_version: candidate.schema_version,
    plan_id: candidate.plan_id,
    decision: candidate.decision,
    rationale: candidate.rationale,
    root: candidate.root,
    work: candidate.work,
    milestone: candidate.milestone,
  };
}

function hasReviewRecoveryEvidence(coordRoot: string, goalId: string, planId: string): boolean {
  return (
    existsSync(reviewReceiptPath(coordRoot, goalId, planId)) ||
    existsSync(join(coordRoot, ".harnery", "workflows", reviewWorkflowRunId(planId), "proof.json"))
  );
}

function planProposalSchema(
  record: SupervisorRecord,
  trigger: NonNullable<SupervisorPlanRequest["trigger"]>,
): StageSchema {
  const policy = record.intent.replanning;
  if (!policy) throw new Error(`supervisor ${record.intent.id} does not allow replanning`);
  const rationale: StageSchema = { type: "string", minLength: 1, maxLength: MAX_REASON };
  const workItem: StageSchema = {
    type: "object",
    properties: {
      key: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$", maxLength: 32 },
      title: { type: "string", minLength: 1, maxLength: 200 },
      objective: { type: "string", minLength: 1, maxLength: 4_000 },
      acceptance: {
        type: "array",
        maxItems: 50,
        items: { type: "string", minLength: 1, maxLength: 500 },
      },
      dependencies: {
        type: "array",
        maxItems: 50,
        items: { type: "string", minLength: 1, maxLength: 100 },
      },
      template: { type: "string", enum: Object.keys(policy.templates), maxLength: 64 },
    },
    required: ["key", "title", "objective", "acceptance", "dependencies", "template"],
    additionalProperties: false,
  };
  const milestone: StageSchema = {
    type: "object",
    properties: {
      sequence: {
        type: "number",
        enum: [record.projection.milestones_completed + 1],
      },
      title: { type: "string", minLength: 1, maxLength: 200 },
      objective: { type: "string", minLength: 1, maxLength: 4_000 },
      acceptance: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
    required: ["sequence", "title", "objective", "acceptance"],
    additionalProperties: false,
  };
  const applyProperties: Record<string, StageSchema> = {
    decision: { type: "string", enum: ["apply"] },
    rationale,
    root: {
      type: "string",
      minLength: 1,
      maxLength: 32,
      pattern: "^[a-z][a-z0-9-]{0,31}$",
    },
    work: {
      type: "array",
      minItems: 1,
      maxItems: policy.max_work_items_per_plan,
      items: workItem,
    },
  };
  const applyRequired = ["decision", "rationale", "root", "work"];
  if (record.intent.mission) {
    applyProperties.milestone = milestone;
    applyRequired.push("milestone");
  }
  const apply: StageSchema = {
    type: "object",
    properties: applyProperties,
    required: applyRequired,
    additionalProperties: false,
  };
  const terminal = (decision: "complete" | "attention"): StageSchema => ({
    type: "object",
    properties: {
      decision: { type: "string", enum: [decision] },
      rationale,
      root: { type: "string", enum: [""] },
      work: { type: "array", maxItems: 0 },
    },
    required: ["decision", "rationale", "root", "work"],
    additionalProperties: false,
  });
  const branches: StageSchema[] = [];
  if (!record.intent.mission || record.projection.milestones_remaining > 0) branches.push(apply);
  if (record.intent.mission && trigger === "milestone") branches.push(terminal("complete"));
  branches.push(terminal("attention"));
  return { type: "object", oneOf: branches };
}

function normalizeProposal(
  planId: string,
  raw: unknown,
  record: SupervisorRecord,
  previouslyApplied: number,
  trigger: NonNullable<SupervisorPlanRequest["trigger"]>,
  preservedProposedAt?: string,
): SupervisorPlanProposal {
  const policy = record.intent.replanning;
  if (!policy) throw new Error(`supervisor ${record.intent.id} does not allow replanning`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("planner result must be an object");
  }
  const value = raw as Record<string, unknown>;
  const proposedAt = preservedProposedAt ?? new Date().toISOString();
  const decision = enumValue(value.decision, ["apply", "complete", "attention"], "plan decision");
  const rationale = bounded(value.rationale, "plan rationale", MAX_REASON);
  const root = typeof value.root === "string" ? value.root.trim() : "";
  if (!Array.isArray(value.work)) throw new Error("plan work must be an array");
  if (decision === "attention" || decision === "complete") {
    if (root || value.work.length > 0 || value.milestone !== undefined) {
      throw new Error(`${decision} plan must not contain work or milestone data`);
    }
    if (decision === "complete" && (!record.intent.mission || trigger !== "milestone")) {
      throw new Error("mission completion may be proposed only at a milestone boundary");
    }
    return {
      schema_version: SUPERVISOR_PLAN_SCHEMA_VERSION,
      plan_id: planId,
      decision,
      rationale,
      root: "",
      work: [],
      proposed_at: proposedAt,
    };
  }
  const milestone = record.intent.mission
    ? normalizeMilestone(value.milestone, record.projection.milestones_completed + 1)
    : undefined;
  if (!record.intent.mission && value.milestone !== undefined) {
    throw new Error("non-mission replacement plan must not contain milestone data");
  }
  if (milestone && milestone.sequence > record.intent.mission!.max_milestones) {
    throw new Error(
      `milestone ${milestone.sequence} exceeds mission limit ${record.intent.mission!.max_milestones}`,
    );
  }
  if (value.work.length < 1 || value.work.length > policy.max_work_items_per_plan) {
    throw new Error(`plan work must contain 1 to ${policy.max_work_items_per_plan} items`);
  }
  if (previouslyApplied + value.work.length > policy.max_total_work_items) {
    throw new Error(`plan would exceed ${policy.max_total_work_items} total planned work items`);
  }
  const active = new Set(record.projection.work_ids);
  const seen = new Set<string>();
  const work = value.work.map((candidate, index): SupervisorPlanWorkSpec => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`plan work[${index}] must be an object`);
    }
    const item = candidate as Record<string, unknown>;
    const key = bounded(item.key, `plan work[${index}].key`, 32);
    if (!PLAN_KEY.test(key) || seen.has(key))
      throw new Error(`invalid or duplicate plan key ${key}`);
    const template = bounded(item.template, `plan work[${index}].template`, 64);
    if (!TEMPLATE_ID.test(template) || !policy.templates[template]) {
      throw new Error(`plan work ${key} references unknown template ${template}`);
    }
    if (!Array.isArray(item.dependencies))
      throw new Error(`plan work ${key} dependencies must be an array`);
    const dependencies = [
      ...new Set(
        item.dependencies.map((dependency, dependencyIndex) =>
          bounded(dependency, `plan work ${key} dependency[${dependencyIndex}]`, 100),
        ),
      ),
    ];
    if (dependencies.length > 50) throw new Error(`plan work ${key} exceeds 50 dependencies`);
    for (const dependency of dependencies) {
      if (!active.has(dependency) && !seen.has(dependency)) {
        throw new Error(
          `plan work ${key} dependency ${dependency} is not active or earlier in the plan`,
        );
      }
    }
    if (!Array.isArray(item.acceptance))
      throw new Error(`plan work ${key} acceptance must be an array`);
    const acceptance = item.acceptance.map((criterion, criterionIndex) =>
      bounded(criterion, `plan work ${key} acceptance[${criterionIndex}]`, 500),
    );
    if (acceptance.length > 50) throw new Error(`plan work ${key} exceeds 50 acceptance criteria`);
    seen.add(key);
    return {
      key,
      title: bounded(item.title, `plan work ${key} title`, 200),
      objective: bounded(item.objective, `plan work ${key} objective`, 4_000),
      acceptance,
      dependencies,
      template,
    };
  });
  if (!seen.has(root)) throw new Error(`plan root ${root || "(empty)"} is not a proposed key`);
  const rootSpec = work.find((item) => item.key === root);
  if (!rootSpec || !policy.templates[rootSpec.template]?.root) {
    throw new Error(`plan root ${root} must use a root-capable template`);
  }
  const reachable = new Set<string>();
  const byKey = new Map(work.map((item) => [item.key, item]));
  const visit = (key: string): void => {
    if (reachable.has(key)) return;
    reachable.add(key);
    for (const dependency of byKey.get(key)?.dependencies ?? []) {
      if (byKey.has(dependency)) visit(dependency);
    }
  };
  visit(root);
  const unused = work.filter((item) => !reachable.has(item.key));
  if (unused.length)
    throw new Error(
      `plan contains work not reachable from root: ${unused.map((item) => item.key).join(", ")}`,
    );
  return {
    schema_version: SUPERVISOR_PLAN_SCHEMA_VERSION,
    plan_id: planId,
    decision,
    rationale,
    root,
    work,
    ...(milestone ? { milestone } : {}),
    proposed_at: proposedAt,
  };
}

function persistedProposalTimestamp(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("persisted review candidate must be an object");
  }
  const value = (raw as Record<string, unknown>).proposed_at;
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    throw new Error("persisted review candidate has an invalid proposed_at timestamp");
  }
  return value;
}

function normalizeMilestone(raw: unknown, expectedSequence: number): SupervisorPlanMilestone {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("mission plan must contain a milestone object");
  }
  const value = raw as Record<string, unknown>;
  if (value.sequence !== expectedSequence) {
    throw new Error(`milestone sequence must be ${expectedSequence}`);
  }
  if (!Array.isArray(value.acceptance) || value.acceptance.length < 1) {
    throw new Error("milestone acceptance must be a non-empty array");
  }
  if (value.acceptance.length > 50) throw new Error("milestone acceptance exceeds 50 criteria");
  return {
    sequence: expectedSequence,
    title: bounded(value.title, "milestone title", 200),
    objective: bounded(value.objective, "milestone objective", 4_000),
    acceptance: value.acceptance.map((criterion, index) =>
      bounded(criterion, `milestone acceptance[${index}]`, 500),
    ),
  };
}

function planTrigger(record: SupervisorRecord): NonNullable<SupervisorPlanRequest["trigger"]> {
  if (
    record.intent.mission &&
    record.projection.plan_generation === 0 &&
    record.work.length === 0
  ) {
    return "initial";
  }
  const root = record.work.find((work) => work.intent.id === record.projection.root_work_id);
  return record.intent.mission && root?.projection.state === "succeeded" ? "milestone" : "recovery";
}

function appendPlanEvent(
  coordRootRaw: string,
  goalId: string,
  planId: string,
  input: Omit<SupervisorPlanEvent, "schema_version" | "plan_id" | "seq" | "ts">,
): void {
  const coordRoot = resolve(coordRootRaw);
  const path = join(planDir(coordRoot, goalId, planId), "events.jsonl");
  const current = readSupervisorPlan(coordRoot, goalId, planId).events;
  const event: SupervisorPlanEvent = {
    schema_version: SUPERVISOR_PLAN_SCHEMA_VERSION,
    plan_id: planId,
    seq: current.length + 1,
    ts: new Date().toISOString(),
    ...input,
    actor: bounded(input.actor, "plan actor", 200),
    reason: bounded(input.reason, "plan reason", MAX_REASON),
  };
  const line = `${JSON.stringify(event)}\n`;
  const existing = existsSync(path) ? statSync(path).size : 0;
  if (existing + Buffer.byteLength(line) > MAX_EVENTS_BYTES) {
    throw new Error("supervisor plan event log would exceed its byte limit");
  }
  appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function appendPlanEventIfMissing(
  coordRoot: string,
  goalId: string,
  planId: string,
  eventType: SupervisorPlanEvent["event"],
  input: Omit<SupervisorPlanEvent, "schema_version" | "plan_id" | "seq" | "ts">,
): void {
  const plan = readSupervisorPlan(coordRoot, goalId, planId);
  if (plan.events.some((event) => event.event === eventType)) return;
  appendPlanEvent(coordRoot, goalId, planId, input);
}

function outcome(plan: ReturnType<typeof readSupervisorPlan>): SupervisorPlanOutcome {
  return {
    plan_id: plan.request.id,
    status: plan.status,
    workflow_run_id: plan.request.workflow_run_id,
    reason: plan.reason,
    root_work_id: plan.root_work_id,
    work_ids: plan.work_ids,
  };
}

function writeExclusiveJson(path: string, value: unknown, label: string): void {
  writeExclusive(path, `${JSON.stringify(value, null, 2)}\n`, label);
}

function writeExclusive(path: string, body: string, label: string): void {
  if (Buffer.byteLength(body) > MAX_RECORD_BYTES) {
    throw new Error(`${label} exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readFileSync(path, "utf8");
      if (existing !== body) throw new Error(`${label} already exists with different content`);
    }
    chmodSync(path, 0o600);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary may already be absent after a failed exclusive write.
    }
  }
}

function planDir(coordRoot: string, goalId: string, planId: string): string {
  return join(coordRoot, ".harnery", "supervisors", goalId, "plans", planId);
}

function planScriptPath(coordRoot: string, goalId: string, planId: string): string {
  return join(planDir(coordRoot, goalId, planId), "planner.mjs");
}

function planProposalPath(coordRoot: string, goalId: string, planId: string): string {
  return join(planDir(coordRoot, goalId, planId), "proposal.json");
}

function reviewScriptPath(coordRoot: string, goalId: string, planId: string): string {
  return join(planDir(coordRoot, goalId, planId), "review.mjs");
}

function reviewInputPath(coordRoot: string, goalId: string, planId: string): string {
  return join(planDir(coordRoot, goalId, planId), "review-input.json");
}

function reviewReceiptPath(coordRoot: string, goalId: string, planId: string): string {
  return join(planDir(coordRoot, goalId, planId), "review.json");
}

function reviewWorkflowRunId(planId: string): string {
  return `${planId}-review`;
}

function readBoundedJson<T>(path: string, label: string): T {
  if (!existsSync(path)) throw new Error(`${label} does not exist at ${path}`);
  const size = statSync(path).size;
  if (size <= 0 || size > MAX_RECORD_BYTES) throw new Error(`${label} has invalid size ${size}`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`cannot parse ${label} at ${path}: ${(error as Error).message}`);
  }
}

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function positive(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${field} must be an integer from 1 to ${max}`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${field} must be one of ${values.join(", ")}`);
  }
  return value as T;
}
