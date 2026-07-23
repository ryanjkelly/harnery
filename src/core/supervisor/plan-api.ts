import type { SupervisorPlanOutcome } from "./plan-types.ts";
import {
  applySupervisorPlanProposal,
  rejectSupervisorPlanProposal,
  retrySupervisorPlanProposal,
} from "./planning.ts";
import { acquireSupervisorLease, readSupervisorIgnoringLease } from "./state.ts";

export function approveSupervisorPlan(input: {
  coordRoot: string;
  goalId: string;
  planId: string;
  actor?: string;
  reason?: string;
}): SupervisorPlanOutcome {
  const actor = input.actor?.trim() || `supervisor:${input.goalId}`;
  const release = acquireSupervisorLease(input.coordRoot, input.goalId);
  try {
    return applySupervisorPlanProposal({
      coordRoot: input.coordRoot,
      record: readSupervisorIgnoringLease(input.coordRoot, input.goalId),
      planId: input.planId,
      actor,
      reason: input.reason,
    });
  } finally {
    release();
  }
}

export function rejectSupervisorPlan(input: {
  coordRoot: string;
  goalId: string;
  planId: string;
  actor?: string;
  reason: string;
}): SupervisorPlanOutcome {
  const actor = input.actor?.trim() || `supervisor:${input.goalId}`;
  const release = acquireSupervisorLease(input.coordRoot, input.goalId);
  try {
    return rejectSupervisorPlanProposal({
      coordRoot: input.coordRoot,
      goalId: input.goalId,
      planId: input.planId,
      actor,
      reason: input.reason,
    });
  } finally {
    release();
  }
}

export function retrySupervisorPlan(input: {
  coordRoot: string;
  goalId: string;
  planId: string;
  actor?: string;
  reason: string;
}): SupervisorPlanOutcome {
  const actor = input.actor?.trim() || `supervisor:${input.goalId}`;
  const release = acquireSupervisorLease(input.coordRoot, input.goalId);
  try {
    return retrySupervisorPlanProposal({
      coordRoot: input.coordRoot,
      record: readSupervisorIgnoringLease(input.coordRoot, input.goalId),
      planId: input.planId,
      actor,
      reason: input.reason,
    });
  } finally {
    release();
  }
}
