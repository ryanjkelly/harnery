import { resolve } from "node:path";
import {
  acceptWorkItem,
  type RunWorkItemInput,
  reconcileWorkItem,
  runWorkItem,
  type WorkRecord,
} from "../work/index.ts";
import type { SupervisorPlanOutcome } from "./plan-types.ts";
import { runSupervisorPlanner } from "./planning.ts";
import {
  acquireSupervisorLease,
  readSupervisorIgnoringLease,
  type SupervisorProjection,
  type SupervisorRecord,
} from "./state.ts";

export type SupervisorStopReason =
  | "succeeded"
  | "awaiting_attention"
  | "blocked"
  | "budget_exhausted"
  | "no_progress"
  | "tick_complete";

export interface SupervisorDispatchOutcome {
  work_id: string;
  action: "run" | "resume" | "retry";
  status: "completed" | "parked" | "failed";
  run_id?: string;
  error?: string;
}

export interface SupervisorRunReport {
  goal_id: string;
  mode: "tick" | "run";
  stop_reason: SupervisorStopReason;
  reason: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  cycles: number;
  dispatches: number;
  acceptances: number;
  replans: number;
  outcomes: SupervisorDispatchOutcome[];
  plan_outcomes: SupervisorPlanOutcome[];
  projection: SupervisorProjection;
}

export interface RunSupervisorInput {
  coordRoot: string;
  goalId: string;
  mode?: "tick" | "run";
  actor?: string;
  engine: Omit<RunWorkItemInput["engine"], "maxAgents" | "concurrency" | "specialists">;
  onLog?: (line: string) => void;
}

interface Candidate {
  record: WorkRecord;
  action: "run" | "resume" | "retry";
  consumesAttempt: boolean;
}

export async function runSupervisor(input: RunSupervisorInput): Promise<SupervisorRunReport> {
  const coordRoot = resolve(input.coordRoot);
  const mode = input.mode ?? "run";
  const actor = input.actor?.trim() || `supervisor:${input.goalId}`;
  const log = input.onLog ?? (() => undefined);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const release = acquireSupervisorLease(coordRoot, input.goalId);
  let cycles = 0;
  let dispatches = 0;
  let acceptances = 0;
  let replans = 0;
  const outcomes: SupervisorDispatchOutcome[] = [];
  const planOutcomes: SupervisorPlanOutcome[] = [];
  try {
    const initial = readSupervisorIgnoringLease(coordRoot, input.goalId);
    const cycleLimit = mode === "tick" ? 1 : initial.intent.limits.max_cycles;
    const deadline = startedMs + initial.intent.limits.max_runtime_ms;
    while (cycles < cycleLimit) {
      cycles++;
      let record = refreshGraph(coordRoot, input.goalId, actor);
      log(
        `[${record.intent.title}] cycle ${cycles}: ${record.projection.state}; ` +
          `${record.projection.ready_work.length} ready, ${record.projection.attention_work.length} attention`,
      );
      if (record.projection.state === "succeeded") {
        return report("succeeded", record.projection.reason, record);
      }
      if (Date.now() >= deadline) {
        return report("budget_exhausted", "supervisor wall-time limit reached", record);
      }

      const before = graphFingerprint(record);
      let changed = false;
      if (
        record.projection.next_action === "replan" ||
        record.projection.next_action === "plan_initial" ||
        record.projection.next_action === "plan_milestone"
      ) {
        log(
          `[${record.intent.title}] ${record.projection.next_action} at graph generation ${record.projection.plan_generation}`,
        );
        const plan = await runSupervisorPlanner({
          coordRoot,
          record,
          engine: input.engine,
          actor,
          onLog: input.onLog,
        });
        replans++;
        planOutcomes.push(plan);
        record = refreshGraph(coordRoot, input.goalId, actor);
        if (mode === "tick") {
          return report(
            "tick_complete",
            `planner produced ${plan.status} plan ${plan.plan_id}`,
            record,
          );
        }
        if (record.projection.state === "succeeded") {
          return report("succeeded", record.projection.reason, record);
        }
        if (record.projection.state !== "ready") {
          return report(stopForProjection(record.projection), record.projection.reason, record);
        }
        continue;
      }
      if (record.intent.automation.accept_passing_proof) {
        for (const work of record.work) {
          if (work.projection.state !== "in_review") continue;
          acceptWorkItem(coordRoot, work.intent.id, {
            actor,
            reason: "passing proof accepted by frozen supervisor policy",
          });
          acceptances++;
          changed = true;
          log(`[${record.intent.title}] accepted ${work.intent.id} from passing proof`);
        }
        if (changed) record = refreshGraph(coordRoot, input.goalId, actor);
        if (record.projection.state === "succeeded") {
          return report("succeeded", record.projection.reason, record);
        }
      }

      const candidates = selectCandidates(record);
      const selected = selectWithinAttemptBudget(record, candidates).slice(
        0,
        record.intent.limits.max_parallel_work,
      );
      if (selected.length > 0 && Date.now() < deadline) {
        const settled = await Promise.all(
          selected.map(async (candidate) => {
            dispatches++;
            log(`[${record.intent.title}] ${candidate.action} ${candidate.record.intent.id}`);
            try {
              const result = await runWorkItem({
                coordRoot,
                workId: candidate.record.intent.id,
                retry: candidate.action === "retry",
                actor,
                engine: {
                  ...input.engine,
                  specialists: record.intent.specialists,
                  maxAgents: record.intent.limits.max_agents_per_work,
                  concurrency: record.intent.limits.agent_concurrency,
                },
              });
              return {
                work_id: candidate.record.intent.id,
                action: candidate.action,
                status: "completed",
                run_id: result.runId,
              } satisfies SupervisorDispatchOutcome;
            } catch (error) {
              const latest = reconcileWorkItem(coordRoot, candidate.record.intent.id, actor);
              return {
                work_id: candidate.record.intent.id,
                action: candidate.action,
                status: latest.projection.state === "awaiting_approval" ? "parked" : "failed",
                run_id: latest.projection.latest_run_id,
                error: boundedError((error as Error).message),
              } satisfies SupervisorDispatchOutcome;
            }
          }),
        );
        outcomes.push(...settled);
        changed = true;
      }

      record = refreshGraph(coordRoot, input.goalId, actor);
      const after = graphFingerprint(record);
      if (record.projection.state === "succeeded") {
        return report("succeeded", record.projection.reason, record);
      }
      if (mode === "tick") {
        return report(
          before === after ? "no_progress" : "tick_complete",
          before === after
            ? "the tick found no legal progress action"
            : "one bounded supervisor cycle completed",
          record,
        );
      }
      if (Date.now() >= deadline) {
        return report("budget_exhausted", "supervisor wall-time limit reached", record);
      }
      if (record.projection.state === "budget_exhausted") {
        return report("budget_exhausted", record.projection.reason, record);
      }
      if (selected.length === 0 && !changed) {
        return report(stopForProjection(record.projection), record.projection.reason, record);
      }
      if (selected.length === 0 && record.projection.state !== "ready") {
        return report(stopForProjection(record.projection), record.projection.reason, record);
      }
      if (before === after) {
        return report("no_progress", "a supervisor cycle produced no durable state change", record);
      }
    }
    const final = refreshGraph(coordRoot, input.goalId, actor);
    return report("budget_exhausted", `supervisor cycle limit reached (${cycleLimit})`, final);
  } finally {
    release();
  }

  function report(
    stopReason: SupervisorStopReason,
    reason: string,
    record: SupervisorRecord,
  ): SupervisorRunReport {
    const endedAt = new Date().toISOString();
    return {
      goal_id: input.goalId,
      mode,
      stop_reason: stopReason,
      reason,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: Date.now() - startedMs,
      cycles,
      dispatches,
      acceptances,
      replans,
      outcomes,
      plan_outcomes: planOutcomes,
      projection: record.projection,
    };
  }
}

function refreshGraph(coordRoot: string, goalId: string, actor: string): SupervisorRecord {
  const before = readSupervisorIgnoringLease(coordRoot, goalId);
  for (const work of before.work) reconcileWorkItem(coordRoot, work.intent.id, actor);
  return readSupervisorIgnoringLease(coordRoot, goalId);
}

function selectCandidates(record: SupervisorRecord): Candidate[] {
  const candidates: Candidate[] = [];
  for (const work of record.work) {
    if (work.projection.state === "ready") {
      candidates.push({ record: work, action: "run", consumesAttempt: true });
      continue;
    }
    if (
      work.projection.state === "awaiting_approval" &&
      work.projection.next_action === "resume" &&
      record.intent.automation.resume_approved
    ) {
      candidates.push({ record: work, action: "resume", consumesAttempt: false });
      continue;
    }
    if (
      work.projection.state === "blocked" &&
      work.projection.next_action === "retry" &&
      record.intent.automation.retry_blocked
    ) {
      candidates.push({ record: work, action: "retry", consumesAttempt: true });
    }
  }
  return candidates;
}

function selectWithinAttemptBudget(record: SupervisorRecord, candidates: Candidate[]): Candidate[] {
  let remaining = record.projection.attempts_remaining;
  return candidates.filter((candidate) => {
    if (!candidate.consumesAttempt) return true;
    if (remaining <= 0) return false;
    remaining--;
    return true;
  });
}

function graphFingerprint(record: SupervisorRecord): string {
  return JSON.stringify([
    record.projection.root_work_id,
    record.projection.plan_generation,
    record.projection.latest_plan_status,
    record.work.map((work) => [
      work.intent.id,
      work.projection.state,
      work.projection.next_action,
      work.projection.attempts_used,
      work.events.length,
    ]),
  ]);
}

function stopForProjection(projection: SupervisorProjection): SupervisorStopReason {
  if (projection.state === "budget_exhausted") return "budget_exhausted";
  if (projection.state === "blocked") return "blocked";
  return "awaiting_attention";
}

function boundedError(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.length > 2_000 ? `${normalized.slice(0, 1_999)}…` : normalized;
}
