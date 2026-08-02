import type { RunFailureClass } from "../workflow/types.ts";

export const GOVERNOR_PLAN_SCHEMA_VERSION = 1 as const;
export const MAX_GOVERNOR_PLAN_REVIEWERS = 5 as const;
export const MAX_GOVERNOR_PLAN_REVISION_ROUNDS = 3 as const;

export interface GovernorPlanTemplate {
  workflow: { path: string; sha256: string };
  max_attempts: number;
  root: boolean;
}

export interface GovernorReplanningPolicy {
  planner_specialist: string;
  auto_apply: boolean;
  max_replans: number;
  max_work_items_per_plan: number;
  max_total_work_items: number;
  templates: Record<string, GovernorPlanTemplate>;
  review?: {
    reviewer_specialists: string[];
    max_revision_rounds: number;
  };
}

export interface CreateGovernorPlanTemplateInput {
  workflowPath: string;
  maxAttempts?: number;
  root?: boolean;
}

export interface CreateGovernorReplanningInput {
  plannerSpecialist: string;
  autoApply?: boolean;
  maxReplans?: number;
  maxWorkItemsPerPlan?: number;
  maxTotalWorkItems?: number;
  templates: Readonly<Record<string, CreateGovernorPlanTemplateInput>>;
  review?: {
    reviewerSpecialists: readonly string[];
    maxRevisionRounds: number;
  };
}

export interface GovernorPlanRequest {
  schema_version: typeof GOVERNOR_PLAN_SCHEMA_VERSION;
  id: string;
  goal_id: string;
  sequence: number;
  trigger?: "initial" | "recovery" | "milestone";
  trigger_fingerprint: string;
  prior_root_work_id: string;
  workflow_run_id: string;
  created_at: string;
}

export interface GovernorPlanMilestone {
  sequence: number;
  title: string;
  objective: string;
  acceptance: string[];
}

export interface GovernorPlanWorkSpec {
  key: string;
  title: string;
  objective: string;
  acceptance: string[];
  dependencies: string[];
  template: string;
}

export interface GovernorPlanProposal {
  schema_version: typeof GOVERNOR_PLAN_SCHEMA_VERSION;
  plan_id: string;
  decision: "apply" | "complete" | "attention";
  rationale: string;
  root: string;
  work: GovernorPlanWorkSpec[];
  milestone?: GovernorPlanMilestone;
  proposed_at: string;
}

export type GovernorPlanEventType =
  | "plan.awaiting_approval"
  | "plan.resumed"
  | "plan.reviewed"
  | "plan.proposed"
  | "plan.applied"
  | "plan.completed"
  | "plan.rejected"
  | "plan.retry_requested"
  | "plan.attention"
  | "plan.failed"
  | "plan.reopened";

export type GovernorPlanReviewStatus = "passed" | "revision_exhausted" | "attention" | "failed";

export type GovernorPlanReviewVerdict = "approve" | "revise" | "attention";

export interface GovernorPlanReviewFinding {
  code: string;
  severity: "blocking" | "advisory";
  summary: string;
  recommendation: string;
}

export interface GovernorPlanReviewReviewer {
  specialist: string;
  verdict: GovernorPlanReviewVerdict;
  rationale: string;
  findings: GovernorPlanReviewFinding[];
}

export interface GovernorPlanReviewRound {
  round: number;
  candidate_sha256: string;
  reviewers: GovernorPlanReviewReviewer[];
  outcome: "approved" | "revise" | "attention" | "failed";
  revision_workflow_run_id?: string;
}

export interface GovernorPlanReviewReceipt {
  schema_version: typeof GOVERNOR_PLAN_SCHEMA_VERSION;
  plan_id: string;
  status: GovernorPlanReviewStatus;
  candidate_sha256: string;
  final_candidate: GovernorPlanProposal;
  rounds: GovernorPlanReviewRound[];
}

export interface GovernorPlanReviewSummary {
  status: GovernorPlanReviewStatus;
  candidate_sha256: string;
  rounds: number;
  blocking_findings: number;
  advisory_findings: number;
}

export interface GovernorPlanEvent {
  schema_version: typeof GOVERNOR_PLAN_SCHEMA_VERSION;
  plan_id: string;
  seq: number;
  ts: string;
  event: GovernorPlanEventType;
  actor: string;
  reason: string;
  approval_id?: string;
  root_work_id?: string;
  work_ids?: string[];
  /** Set on a `plan.failed` event whose planner workflow was uninformative about
   * the plan (ADR 0046): environment (the planner binary was absent), upstream
   * (the vendor refused), or decision (the planner determined a human must rule
   * before this can be planned). Read from the planner run's `run.class`.
   * Absent ⇒ a charged replan, exactly as before. */
  class?: RunFailureClass;
}

export type GovernorPlanStatus =
  | "interrupted"
  | "awaiting_approval"
  | "resumable"
  | "proposed"
  | "applied"
  | "completed"
  | "reopened"
  | "rejected"
  | "retry_requested"
  | "attention"
  | "failed";

export interface GovernorPlanRecord {
  request: GovernorPlanRequest;
  proposal?: GovernorPlanProposal;
  review?: GovernorPlanReviewSummary;
  events: GovernorPlanEvent[];
  status: GovernorPlanStatus;
  approval_id?: string;
  root_work_id?: string;
  work_ids: string[];
  reason?: string;
  /** Set on a `failed` plan the planner run classified as uninformative about the
   * plan (ADR 0046). Drives the projection's do-not-charge / stop handling and
   * the consecutive-uncharged bound. Absent ⇒ a charged replan. */
  class?: RunFailureClass;
}

export interface GovernorPlanHistory {
  plans: GovernorPlanRecord[];
  active_root_work_id: string;
  generation: number;
  applied_work_ids: string[];
  materialized_work_ids: string[];
  milestones_completed: number;
  completed: boolean;
  latest?: GovernorPlanRecord;
}

export interface GovernorPlanOutcome {
  plan_id: string;
  status: GovernorPlanStatus;
  workflow_run_id: string;
  reason?: string;
  root_work_id?: string;
  work_ids: string[];
}

export function governorGraphFingerprint(input: {
  rootWorkId: string;
  generation: number;
  work: ReadonlyArray<{
    intent: { id: string };
    projection: { state: string; next_action: string; attempts_used: number };
    events: readonly unknown[];
  }>;
}): string {
  return JSON.stringify([
    input.rootWorkId,
    input.generation,
    input.work.map((work) => [
      work.intent.id,
      work.projection.state,
      work.projection.next_action,
      work.projection.attempts_used,
      work.events.length,
    ]),
  ]);
}
