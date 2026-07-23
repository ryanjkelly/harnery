import { resolve } from "node:path";
import { runWorkflow } from "../workflow/engine.ts";
import type { EngineOpts, RunReport } from "../workflow/types.ts";
import { WORKFLOW_WORK_CONTEXT_SCHEMA_VERSION } from "../workflow/types.ts";
import {
  acquireWorkLease,
  appendReconcileIfChanged,
  appendWorkEvent,
  assertWorkflowUnchanged,
  boundedActor,
  newWorkflowRunId,
  readWorkItemIgnoringLease,
} from "./state.ts";

export interface RunWorkItemInput {
  coordRoot: string;
  workId: string;
  engine: Omit<EngineOpts, "coordRoot" | "runId" | "resumeRunId" | "workItemId" | "workContext">;
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
    if (!(record.projection.state === "ready" || record.projection.state === "blocked")) {
      throw new Error(`work item ${input.workId} cannot run from state ${record.projection.state}`);
    }
    if (record.projection.attempts_used >= record.intent.max_attempts) {
      throw new Error(
        `work item ${input.workId} exhausted its ${record.intent.max_attempts} attempts`,
      );
    }
    const attempt = record.projection.attempts_used + 1;
    const runId = newWorkflowRunId();
    appendWorkEvent(coordRoot, input.workId, {
      event: "attempt.started",
      actor: boundedActor(input.actor),
      reason: input.retry ? "explicit retry started" : "workflow attempt started",
      run_id: runId,
      attempt,
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
