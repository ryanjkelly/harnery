import type { GovernorPlanOutcome } from "./plan-types.ts";
import {
  applyGovernorPlanProposal,
  rejectGovernorPlanProposal,
  reopenGovernorMissionPlan,
  retryGovernorPlanProposal,
} from "./planning.ts";
import { acquireGovernorLease, listGovernors, readGovernorIgnoringLease } from "./state.ts";

export function approveGovernorPlan(input: {
  coordRoot: string;
  goalId: string;
  planId: string;
  actor?: string;
  reason?: string;
}): GovernorPlanOutcome {
  const actor = input.actor?.trim() || `governor:${input.goalId}`;
  const release = acquireGovernorLease(input.coordRoot, input.goalId);
  try {
    return applyGovernorPlanProposal({
      coordRoot: input.coordRoot,
      record: readGovernorIgnoringLease(input.coordRoot, input.goalId),
      planId: input.planId,
      actor,
      reason: input.reason,
    });
  } finally {
    release();
  }
}

export function rejectGovernorPlan(input: {
  coordRoot: string;
  goalId: string;
  planId: string;
  actor?: string;
  reason: string;
}): GovernorPlanOutcome {
  const actor = input.actor?.trim() || `governor:${input.goalId}`;
  const release = acquireGovernorLease(input.coordRoot, input.goalId);
  try {
    return rejectGovernorPlanProposal({
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

/** The goal of a succeeded mission that governs this work item, if there is one.
 *
 * A work item holds no back-reference to its goal, so this is a scan. It exists so
 * `work reopen` can tell the difference between an item nothing is watching and one
 * whose mission has already been declared complete — the case where reopening the
 * item alone leaves it in `ready_work` that the governor will never dispatch. */
export function findCompletedMissionGoverning(
  coordRoot: string,
  workId: string,
): string | undefined {
  for (const record of listGovernors(coordRoot)) {
    if (record.projection.state !== "succeeded" || !record.intent.mission) continue;
    if (record.projection.root_work_id === workId || record.projection.work_ids.includes(workId)) {
      return record.intent.id;
    }
  }
  return undefined;
}

/** ADR 0050: reopen an accepted mission completion by appending to the plan log.
 * Held under the goal lease so it cannot race a foreground governor run. */
export function reopenGovernorMission(input: {
  coordRoot: string;
  goalId: string;
  actor?: string;
  reason: string;
}): GovernorPlanOutcome {
  const actor = input.actor?.trim() || `governor:${input.goalId}`;
  const release = acquireGovernorLease(input.coordRoot, input.goalId);
  try {
    return reopenGovernorMissionPlan({
      coordRoot: input.coordRoot,
      record: readGovernorIgnoringLease(input.coordRoot, input.goalId),
      actor,
      reason: input.reason,
    });
  } finally {
    release();
  }
}

export function retryGovernorPlan(input: {
  coordRoot: string;
  goalId: string;
  planId: string;
  actor?: string;
  reason: string;
}): GovernorPlanOutcome {
  const actor = input.actor?.trim() || `governor:${input.goalId}`;
  const release = acquireGovernorLease(input.coordRoot, input.goalId);
  try {
    return retryGovernorPlanProposal({
      coordRoot: input.coordRoot,
      record: readGovernorIgnoringLease(input.coordRoot, input.goalId),
      planId: input.planId,
      actor,
      reason: input.reason,
    });
  } finally {
    release();
  }
}
