import type { SupervisorPlanOutcome } from "./plan-types.ts";
import {
  applySupervisorPlanProposal,
  rejectSupervisorPlanProposal,
  reopenSupervisorMissionPlan,
  retrySupervisorPlanProposal,
} from "./planning.ts";
import { acquireSupervisorLease, listSupervisors, readSupervisorIgnoringLease } from "./state.ts";

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

/** The goal of a succeeded mission that governs this work item, if there is one.
 *
 * A work item holds no back-reference to its goal, so this is a scan. It exists so
 * `work reopen` can tell the difference between an item nothing is watching and one
 * whose mission has already been declared complete — the case where reopening the
 * item alone leaves it in `ready_work` that the supervisor will never dispatch. */
export function findCompletedMissionGoverning(
  coordRoot: string,
  workId: string,
): string | undefined {
  for (const record of listSupervisors(coordRoot)) {
    if (record.projection.state !== "succeeded" || !record.intent.mission) continue;
    if (record.projection.root_work_id === workId || record.projection.work_ids.includes(workId)) {
      return record.intent.id;
    }
  }
  return undefined;
}

/** ADR 0050: reopen an accepted mission completion by appending to the plan log.
 * Held under the goal lease so it cannot race a foreground supervisor run. */
export function reopenSupervisorMission(input: {
  coordRoot: string;
  goalId: string;
  actor?: string;
  reason: string;
}): SupervisorPlanOutcome {
  const actor = input.actor?.trim() || `supervisor:${input.goalId}`;
  const release = acquireSupervisorLease(input.coordRoot, input.goalId);
  try {
    return reopenSupervisorMissionPlan({
      coordRoot: input.coordRoot,
      record: readSupervisorIgnoringLease(input.coordRoot, input.goalId),
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
