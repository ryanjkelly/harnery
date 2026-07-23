import { resolve } from "node:path";
import { runWorkflow } from "../workflow/engine.ts";
import { readWorkflowProof } from "../workflow/proof.ts";
import type {
  EngineOpts,
  RunReport,
  WorkflowAttemptContext,
  WorkflowAttemptFailureCause,
} from "../workflow/types.ts";
import {
  WORKFLOW_ATTEMPT_CONTEXT_SCHEMA_VERSION,
  WORKFLOW_WORK_CONTEXT_SCHEMA_VERSION,
} from "../workflow/types.ts";
import {
  acquireWorkLease,
  appendReconcileIfChanged,
  appendWorkEvent,
  assertWorkflowUnchanged,
  boundedActor,
  newWorkflowRunId,
  readWorkItemIgnoringLease,
  type WorkAttempt,
} from "./state.ts";

export interface RunWorkItemInput {
  coordRoot: string;
  workId: string;
  engine: Omit<
    EngineOpts,
    "coordRoot" | "runId" | "resumeRunId" | "workItemId" | "workContext" | "attemptContext"
  >;
  retry?: boolean;
  actor?: string;
}

export async function runWorkItem(input: RunWorkItemInput): Promise<RunReport> {
  const coordRoot = resolve(input.coordRoot);
  const release = acquireWorkLease(coordRoot, input.workId);
  try {
    const record = readWorkItemIgnoringLease(coordRoot, input.workId);
    assertWorkflowUnchanged(record.intent);
    const latest = record.projection.attempts.at(-1);
    if (record.projection.state === "awaiting_approval" && latest) {
      if (record.projection.next_action !== "resume") {
        throw new Error(`work item ${input.workId} is waiting for approval ${latest.approval_id}`);
      }
      appendWorkEvent(coordRoot, input.workId, {
        event: "attempt.resumed",
        actor: boundedActor(input.actor),
        reason: "resuming the parked workflow attempt",
        run_id: latest.run_id,
        attempt: latest.number,
      });
      return await runWorkflow(record.intent.workflow.path, {
        ...input.engine,
        coordRoot,
        resumeRunId: latest.run_id,
        workItemId: input.workId,
      });
    }
    if (record.projection.state === "blocked" && !input.retry) {
      throw new Error(`work item ${input.workId} is blocked; use an explicit retry`);
    }
    if (record.projection.state === "ready" && input.retry) {
      throw new Error(`work item ${input.workId} is ready; retry requires a blocked prior attempt`);
    }
    if (!(record.projection.state === "ready" || record.projection.state === "blocked")) {
      throw new Error(`work item ${input.workId} cannot run from state ${record.projection.state}`);
    }
    if (record.projection.attempts_used >= record.intent.max_attempts) {
      throw new Error(
        `work item ${input.workId} exhausted its ${record.intent.max_attempts} attempts`,
      );
    }
    const attempt = record.projection.attempts_used + 1;
    const trigger = input.retry ? "retry" : "initial";
    let prior: WorkflowAttemptContext["prior"];
    if (trigger === "retry") {
      if (!latest) {
        throw new Error(`work item ${input.workId} has no prior attempt to retry`);
      }
      prior = priorContext(coordRoot, latest);
    }
    const attemptContext: WorkflowAttemptContext = {
      schema_version: WORKFLOW_ATTEMPT_CONTEXT_SCHEMA_VERSION,
      number: attempt,
      trigger,
      ...(prior ? { prior } : {}),
    };
    const runId = newWorkflowRunId();
    appendWorkEvent(coordRoot, input.workId, {
      event: "attempt.started",
      actor: boundedActor(input.actor),
      reason: input.retry ? "explicit retry started" : "workflow attempt started",
      run_id: runId,
      attempt,
      trigger,
    });
    return await runWorkflow(record.intent.workflow.path, {
      ...input.engine,
      coordRoot,
      runId,
      workItemId: input.workId,
      workContext: {
        schema_version: WORKFLOW_WORK_CONTEXT_SCHEMA_VERSION,
        id: record.intent.id,
        title: record.intent.title,
        objective: record.intent.objective,
        acceptance: [...record.intent.acceptance],
      },
      attemptContext,
    });
  } finally {
    try {
      const current = readWorkItemIgnoringLease(coordRoot, input.workId);
      appendReconcileIfChanged(coordRoot, current, boundedActor(input.actor, "work-runner"));
    } finally {
      release();
    }
  }
}

function priorContext(
  coordRoot: string,
  prior: WorkAttempt,
): NonNullable<WorkflowAttemptContext["prior"]> {
  if (!prior.proof_path) {
    return {
      run_id: prior.run_id,
      causes: ["lost"],
      unresolved: [],
    };
  }
  const proof = readWorkflowProof(coordRoot, prior.run_id);
  const causes: WorkflowAttemptFailureCause[] = [];
  if (proof.run.status === "failed") causes.push("workflow_error");
  if (proof.acceptance.summary.unsatisfied > 0) causes.push("acceptance_unsatisfied");
  if (proof.acceptance.summary.unknown > 0) causes.push("acceptance_unknown");
  if (causes.length === 0) {
    throw new Error(`workflow proof ${prior.run_id} does not describe a retryable failure`);
  }
  return {
    run_id: prior.run_id,
    causes,
    error: proof.run.error,
    acceptance: { ...proof.acceptance.summary },
    unresolved: proof.acceptance.criteria
      .filter((criterion) => criterion.status !== "satisfied")
      .map((criterion) => ({
        id: criterion.id,
        statement: criterion.statement,
        status: criterion.status as "unsatisfied" | "unknown",
      })),
  };
}
