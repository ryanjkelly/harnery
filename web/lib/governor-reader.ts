import {
  listGovernors,
  readGovernor,
  readGovernorServiceStatus,
  type GovernorPlanRecord,
  type GovernorPlanReviewStatus,
  type GovernorRecord,
  type GovernorServiceStatus,
  type GovernorState,
} from "harnery/core/governor/state";

type BadgeVariant = "muted" | "info" | "success" | "warning" | "destructive";

export type GovernorPlanDashboardState =
  | GovernorPlanRecord["status"]
  | "proposal_unreviewed"
  | "proposal_review_passed"
  | "proposal_revision_exhausted"
  | "proposal_review_attention"
  | "proposal_review_failed";

export interface GovernorPlanDashboardStatus {
  state: GovernorPlanDashboardState;
  label: string;
  badgeVariant: BadgeVariant;
  requiresReview: boolean;
  requiresDecision: boolean;
  reviewLabel?: string;
}

export interface GovernorDashboardDecision {
  nextAction: string;
  reason: string;
}

export type {
  GovernorPlanRecord,
  GovernorPlanReviewStatus,
  GovernorRecord,
  GovernorServiceStatus,
  GovernorState,
};

export function readGovernors(root: string): GovernorRecord[] {
  return listGovernors(root);
}

export function readGovernorGoal(root: string, goalId: string): GovernorRecord | null {
  try {
    return readGovernor(root, goalId);
  } catch {
    return null;
  }
}

export function readGovernorBackgroundService(root: string): GovernorServiceStatus {
  return readGovernorServiceStatus(root);
}

export function governorPlanDashboardStatus(
  plan: GovernorPlanRecord,
): GovernorPlanDashboardStatus {
  if (plan.status === "attention" && plan.review && plan.review.status !== "passed") {
    return {
      state: reviewedProposalState(plan.review.status),
      label: reviewedProposalLabel(plan.review.status),
      badgeVariant: reviewedProposalBadgeVariant(plan.review.status),
      requiresReview: false,
      requiresDecision: false,
      reviewLabel: formatGovernorPlanReview(plan),
    };
  }
  if (plan.status === "proposed") {
    if (!plan.review) {
      return {
        state: "proposal_unreviewed",
        label: "unreviewed proposal",
        badgeVariant: "warning",
        requiresReview: true,
        requiresDecision: false,
      };
    }
    return {
      state: reviewedProposalState(plan.review.status),
      label: reviewedProposalLabel(plan.review.status),
      badgeVariant: reviewedProposalBadgeVariant(plan.review.status),
      requiresReview: false,
      requiresDecision: plan.review.status === "passed",
      reviewLabel: formatGovernorPlanReview(plan),
    };
  }
  return {
    state: plan.status,
    label: plan.status.replaceAll("_", " "),
    badgeVariant:
      plan.status === "applied" || plan.status === "completed"
        ? "success"
        : plan.status === "retry_requested"
          ? "info"
          : plan.status === "failed" || plan.status === "rejected"
            ? "destructive"
            : plan.status === "awaiting_approval"
              ? "warning"
              : "muted",
    requiresReview: false,
    requiresDecision: false,
    reviewLabel: formatGovernorPlanReview(plan),
  };
}

export function governorDashboardDecision(record: GovernorRecord): GovernorDashboardDecision {
  const pendingPlan = record.projection.pending_plan_id
    ? record.plans.find((plan) => plan.request.id === record.projection.pending_plan_id)
    : undefined;
  const status = pendingPlan ? governorPlanDashboardStatus(pendingPlan) : undefined;
  if (pendingPlan && status?.requiresDecision) {
    return {
      nextAction: "approve_or_reject_plan",
      reason: `Plan ${pendingPlan.request.id} passed independent review and awaits explicit approval or rejection.`,
    };
  }
  return {
    nextAction: record.projection.next_action,
    reason: record.projection.reason,
  };
}

function reviewedProposalState(
  status: GovernorPlanReviewStatus,
): Extract<
  GovernorPlanDashboardState,
  | "proposal_review_passed"
  | "proposal_revision_exhausted"
  | "proposal_review_attention"
  | "proposal_review_failed"
> {
  if (status === "passed") return "proposal_review_passed";
  if (status === "revision_exhausted") return "proposal_revision_exhausted";
  if (status === "attention") return "proposal_review_attention";
  return "proposal_review_failed";
}

function reviewedProposalLabel(status: GovernorPlanReviewStatus): string {
  if (status === "passed") return "review passed";
  if (status === "revision_exhausted") return "revision exhausted";
  if (status === "attention") return "review needs attention";
  return "review failed";
}

function reviewedProposalBadgeVariant(status: GovernorPlanReviewStatus): BadgeVariant {
  if (status === "passed") return "info";
  if (status === "attention" || status === "revision_exhausted") return "warning";
  return "destructive";
}

function formatGovernorPlanReview(plan: GovernorPlanRecord): string | undefined {
  if (!plan.review) return undefined;
  const rounds = `${plan.review.rounds} review round${plan.review.rounds === 1 ? "" : "s"}`;
  const blocking = `${plan.review.blocking_findings} blocking`;
  const advisory = `${plan.review.advisory_findings} advisory`;
  return `${plan.review.status.replaceAll("_", " ")} · ${rounds} · ${blocking} · ${advisory}`;
}
