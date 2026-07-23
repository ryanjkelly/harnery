export const SUPERVISOR_PLAN_SCHEMA_VERSION = 1 as const;
export const MAX_SUPERVISOR_PLAN_REVIEWERS = 5 as const;
export const MAX_SUPERVISOR_PLAN_REVISION_ROUNDS = 3 as const;

export interface SupervisorPlanTemplate {
  workflow: { path: string; sha256: string };
  max_attempts: number;
  root: boolean;
}

export interface SupervisorReplanningPolicy {
  planner_specialist: string;
  auto_apply: boolean;
  max_replans: number;
  max_work_items_per_plan: number;
  max_total_work_items: number;
  templates: Record<string, SupervisorPlanTemplate>;
  review?: {
    reviewer_specialists: string[];
    max_revision_rounds: number;
  };
}

export interface CreateSupervisorPlanTemplateInput {
  workflowPath: string;
  maxAttempts?: number;
  root?: boolean;
}

export interface CreateSupervisorReplanningInput {
  plannerSpecialist: string;
  autoApply?: boolean;
  maxReplans?: number;
  maxWorkItemsPerPlan?: number;
  maxTotalWorkItems?: number;
  templates: Readonly<Record<string, CreateSupervisorPlanTemplateInput>>;
  review?: {
    reviewerSpecialists: readonly string[];
    maxRevisionRounds: number;
  };
}

export interface SupervisorPlanRequest {
  schema_version: typeof SUPERVISOR_PLAN_SCHEMA_VERSION;
  id: string;
  goal_id: string;
  sequence: number;
  trigger?: "initial" | "recovery" | "milestone";
  trigger_fingerprint: string;
  prior_root_work_id: string;
  workflow_run_id: string;
  created_at: string;
}

export interface SupervisorPlanMilestone {
  sequence: number;
  title: string;
  objective: string;
  acceptance: string[];
}

export interface SupervisorPlanWorkSpec {
  key: string;
  title: string;
  objective: string;
  acceptance: string[];
  dependencies: string[];
  template: string;
}

export interface SupervisorPlanProposal {
  schema_version: typeof SUPERVISOR_PLAN_SCHEMA_VERSION;
  plan_id: string;
  decision: "apply" | "complete" | "attention";
  rationale: string;
  root: string;
  work: SupervisorPlanWorkSpec[];
  milestone?: SupervisorPlanMilestone;
  proposed_at: string;
}

export type SupervisorPlanEventType =
  | "plan.awaiting_approval"
  | "plan.resumed"
  | "plan.reviewed"
  | "plan.proposed"
  | "plan.applied"
  | "plan.completed"
  | "plan.rejected"
  | "plan.retry_requested"
  | "plan.attention"
  | "plan.failed";

export type SupervisorPlanReviewStatus = "passed" | "revision_exhausted" | "attention" | "failed";

export type SupervisorPlanReviewVerdict = "approve" | "revise" | "attention";

export interface SupervisorPlanReviewFinding {
  code: string;
  severity: "blocking" | "advisory";
  summary: string;
  recommendation: string;
}

export interface SupervisorPlanReviewReviewer {
  specialist: string;
  verdict: SupervisorPlanReviewVerdict;
  rationale: string;
  findings: SupervisorPlanReviewFinding[];
}

export interface SupervisorPlanReviewRound {
  round: number;
  candidate_sha256: string;
  reviewers: SupervisorPlanReviewReviewer[];
  outcome: "approved" | "revise" | "attention" | "failed";
  revision_workflow_run_id?: string;
}

export interface SupervisorPlanReviewReceipt {
  schema_version: typeof SUPERVISOR_PLAN_SCHEMA_VERSION;
  plan_id: string;
  status: SupervisorPlanReviewStatus;
  candidate_sha256: string;
  final_candidate: SupervisorPlanProposal;
  rounds: SupervisorPlanReviewRound[];
}

export interface SupervisorPlanReviewSummary {
  status: SupervisorPlanReviewStatus;
  candidate_sha256: string;
  rounds: number;
  blocking_findings: number;
  advisory_findings: number;
}

export interface SupervisorPlanEvent {
  schema_version: typeof SUPERVISOR_PLAN_SCHEMA_VERSION;
  plan_id: string;
  seq: number;
  ts: string;
  event: SupervisorPlanEventType;
  actor: string;
  reason: string;
  approval_id?: string;
  root_work_id?: string;
  work_ids?: string[];
}

export type SupervisorPlanStatus =
  | "interrupted"
  | "awaiting_approval"
  | "resumable"
  | "proposed"
  | "applied"
  | "completed"
  | "rejected"
  | "retry_requested"
  | "attention"
  | "failed";

export interface SupervisorPlanRecord {
  request: SupervisorPlanRequest;
  proposal?: SupervisorPlanProposal;
  review?: SupervisorPlanReviewSummary;
  events: SupervisorPlanEvent[];
  status: SupervisorPlanStatus;
  approval_id?: string;
  root_work_id?: string;
  work_ids: string[];
  reason?: string;
}

export interface SupervisorPlanHistory {
  plans: SupervisorPlanRecord[];
  active_root_work_id: string;
  generation: number;
  applied_work_ids: string[];
  materialized_work_ids: string[];
  milestones_completed: number;
  completed: boolean;
  latest?: SupervisorPlanRecord;
}

export interface SupervisorPlanOutcome {
  plan_id: string;
  status: SupervisorPlanStatus;
  workflow_run_id: string;
  reason?: string;
  root_work_id?: string;
  work_ids: string[];
}

export function supervisorGraphFingerprint(input: {
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
