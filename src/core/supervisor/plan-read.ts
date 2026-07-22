import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readWorkItem } from "../work/read.ts";
import {
  SUPERVISOR_PLAN_SCHEMA_VERSION,
  type SupervisorPlanEvent,
  type SupervisorPlanEventType,
  type SupervisorPlanHistory,
  type SupervisorPlanProposal,
  type SupervisorPlanRecord,
  type SupervisorPlanRequest,
} from "./plan-types.ts";

const PLAN_ID = /^plan-[0-9]{4}-[a-f0-9]{8}$/;
const GOAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const APPROVAL_ID = /^apr-[a-f0-9]{20}$/;
const PLAN_KEY = /^[a-z][a-z0-9-]{0,31}$/;
const TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PLANS = 100;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_EVENTS_BYTES = 512 * 1024;
const MAX_EVENTS = 100;
const EVENT_TYPES = new Set<SupervisorPlanEventType>([
  "plan.awaiting_approval",
  "plan.resumed",
  "plan.proposed",
  "plan.applied",
  "plan.completed",
  "plan.rejected",
  "plan.attention",
  "plan.failed",
]);

export function readSupervisorPlans(
  coordRootRaw: string,
  goalId: string,
  originalRootWorkId: string,
): SupervisorPlanHistory {
  assertId(goalId, GOAL_ID, "supervisor id");
  assertId(originalRootWorkId, WORK_ID, "work id");
  const coordRoot = resolve(coordRootRaw);
  const root = plansRoot(coordRoot, goalId);
  if (!existsSync(root)) {
    return {
      plans: [],
      active_root_work_id: originalRootWorkId,
      generation: 0,
      applied_work_ids: [],
      materialized_work_ids: [],
      milestones_completed: 0,
      completed: false,
    };
  }
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PLAN_ID.test(entry.name))
    .map((entry) => entry.name);
  if (entries.length > MAX_PLANS) throw new Error(`supervisor plan history exceeds ${MAX_PLANS}`);
  const plans = entries
    .map((planId) => readSupervisorPlan(coordRootRaw, goalId, planId))
    .sort((left, right) => left.request.sequence - right.request.sequence);
  const sequences = new Set<number>();
  for (const plan of plans) {
    if (sequences.has(plan.request.sequence)) {
      throw new Error(`supervisor ${goalId} has duplicate plan sequence ${plan.request.sequence}`);
    }
    sequences.add(plan.request.sequence);
  }
  let activeRoot = originalRootWorkId;
  let generation = 0;
  let milestonesCompleted = 0;
  let completed = false;
  const appliedWork = new Set<string>();
  const materializedWork = new Set<string>();
  for (const plan of plans) {
    for (const spec of plan.proposal?.work ?? []) {
      const workId = `${plan.request.id}-${spec.key}`;
      if (existsSync(join(coordRoot, ".harnery", "work", workId, "intent.json"))) {
        materializedWork.add(workId);
      }
    }
    if (plan.status !== "applied" || !plan.root_work_id) continue;
    activeRoot = plan.root_work_id;
    generation++;
    if (
      plan.proposal?.milestone &&
      readWorkItem(coordRoot, plan.root_work_id).projection.state === "succeeded"
    ) {
      milestonesCompleted++;
    }
    for (const workId of plan.work_ids) appliedWork.add(workId);
  }
  const completedPlans = plans.filter((plan) => plan.status === "completed");
  if (
    completedPlans.length > 1 ||
    (completedPlans.length === 1 && completedPlans[0] !== plans.at(-1))
  ) {
    throw new Error(`supervisor ${goalId} has invalid completion history`);
  }
  completed = completedPlans.length === 1;
  return {
    plans,
    active_root_work_id: activeRoot,
    generation,
    applied_work_ids: [...appliedWork],
    materialized_work_ids: [...materializedWork],
    milestones_completed: milestonesCompleted,
    completed,
    latest: plans.at(-1),
  };
}

export function readSupervisorPlan(
  coordRootRaw: string,
  goalId: string,
  planId: string,
): SupervisorPlanRecord {
  assertId(goalId, GOAL_ID, "supervisor id");
  assertId(planId, PLAN_ID, "supervisor plan id");
  const coordRoot = resolve(coordRootRaw);
  const dir = planDir(coordRoot, goalId, planId);
  const request = readJson<SupervisorPlanRequest>(join(dir, "request.json"), "plan request");
  validateRequest(request, goalId, planId);
  const proposalPath = join(dir, "proposal.json");
  const proposal = existsSync(proposalPath)
    ? readJson<SupervisorPlanProposal>(proposalPath, "plan proposal")
    : undefined;
  if (proposal) validateProposalEnvelope(proposal, planId);
  const events = readEvents(join(dir, "events.jsonl"), planId);
  const derived = deriveStatus(coordRoot, events, proposal);
  return { request, proposal, events, ...derived };
}

function deriveStatus(
  coordRoot: string,
  events: SupervisorPlanEvent[],
  proposal: SupervisorPlanProposal | undefined,
): Pick<SupervisorPlanRecord, "status" | "approval_id" | "root_work_id" | "work_ids" | "reason"> {
  const latest = events.at(-1);
  const completed = [...events].reverse().find((event) => event.event === "plan.completed");
  if (completed) {
    return { status: "completed", work_ids: [], reason: completed.reason };
  }
  const applied = [...events].reverse().find((event) => event.event === "plan.applied");
  if (applied) {
    return {
      status: "applied",
      root_work_id: applied.root_work_id,
      work_ids: applied.work_ids ?? [],
      reason: applied.reason,
    };
  }
  if (latest?.event === "plan.rejected") {
    return { status: "rejected", work_ids: [], reason: latest.reason };
  }
  if (latest?.event === "plan.attention") {
    return { status: "attention", work_ids: [], reason: latest.reason };
  }
  if (latest?.event === "plan.failed") {
    return { status: "failed", work_ids: [], reason: latest.reason };
  }
  const parked = [...events].reverse().find((event) => event.event === "plan.awaiting_approval");
  const resumedAfterPark =
    parked !== undefined &&
    events.some((event) => event.event === "plan.resumed" && event.seq > parked.seq);
  if (parked?.approval_id && !resumedAfterPark) {
    return {
      status: approvalIsResolved(coordRoot, parked.approval_id) ? "resumable" : "awaiting_approval",
      approval_id: parked.approval_id,
      work_ids: [],
      reason: parked.reason,
    };
  }
  if (proposal) return { status: "proposed", work_ids: [], reason: proposal.rationale };
  return { status: "interrupted", work_ids: [], reason: latest?.reason };
}

function readEvents(path: string, planId: string): SupervisorPlanEvent[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  if (size > MAX_EVENTS_BYTES) throw new Error("supervisor plan events exceed their byte limit");
  const body = readFileSync(path, "utf8");
  if (body && !body.endsWith("\n"))
    throw new Error(`supervisor plan ${planId} has a partial event`);
  const lines = body.split("\n").filter(Boolean);
  if (lines.length > MAX_EVENTS) throw new Error(`supervisor plan exceeds ${MAX_EVENTS} events`);
  return lines.map((line, index) => {
    let event: SupervisorPlanEvent;
    try {
      event = JSON.parse(line) as SupervisorPlanEvent;
    } catch (error) {
      throw new Error(
        `cannot parse supervisor plan ${planId} event ${index + 1}: ${(error as Error).message}`,
      );
    }
    validateEvent(event, planId, index + 1);
    return event;
  });
}

function validateRequest(request: SupervisorPlanRequest, goalId: string, planId: string): void {
  if (
    request.schema_version !== SUPERVISOR_PLAN_SCHEMA_VERSION ||
    request.id !== planId ||
    request.goal_id !== goalId ||
    !Number.isSafeInteger(request.sequence) ||
    request.sequence < 1 ||
    request.sequence > MAX_PLANS ||
    (request.trigger !== undefined &&
      !["initial", "recovery", "milestone"].includes(request.trigger)) ||
    typeof request.trigger_fingerprint !== "string" ||
    request.trigger_fingerprint.length < 1 ||
    request.trigger_fingerprint.length > 64_000 ||
    !WORK_ID.test(request.prior_root_work_id) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(request.workflow_run_id) ||
    !validTimestamp(request.created_at)
  ) {
    throw new Error(`supervisor plan request ${planId} has an unsupported schema`);
  }
}

function validateProposalEnvelope(proposal: SupervisorPlanProposal, planId: string): void {
  if (
    proposal.schema_version !== SUPERVISOR_PLAN_SCHEMA_VERSION ||
    proposal.plan_id !== planId ||
    !["apply", "complete", "attention"].includes(proposal.decision) ||
    typeof proposal.rationale !== "string" ||
    proposal.rationale.length < 1 ||
    proposal.rationale.length > 2_000 ||
    !Array.isArray(proposal.work) ||
    proposal.work.length > 25 ||
    typeof proposal.root !== "string" ||
    proposal.root.length > 32 ||
    !validTimestamp(proposal.proposed_at)
  ) {
    throw new Error(`supervisor plan proposal ${planId} has an unsupported schema`);
  }
  if (proposal.milestone !== undefined) {
    const milestone = proposal.milestone;
    if (
      !Number.isSafeInteger(milestone.sequence) ||
      milestone.sequence < 1 ||
      milestone.sequence > 20 ||
      typeof milestone.title !== "string" ||
      milestone.title.length < 1 ||
      milestone.title.length > 200 ||
      typeof milestone.objective !== "string" ||
      milestone.objective.length < 1 ||
      milestone.objective.length > 4_000 ||
      !Array.isArray(milestone.acceptance) ||
      milestone.acceptance.length < 1 ||
      milestone.acceptance.length > 50 ||
      milestone.acceptance.some(
        (criterion) =>
          typeof criterion !== "string" || criterion.length < 1 || criterion.length > 500,
      )
    ) {
      throw new Error(`supervisor plan proposal ${planId} milestone is invalid`);
    }
  }
  if (
    (proposal.decision === "attention" || proposal.decision === "complete") &&
    (proposal.root !== "" || proposal.work.length > 0 || proposal.milestone !== undefined)
  ) {
    throw new Error(`supervisor plan proposal ${planId} terminal decision contains work`);
  }
  for (const [index, spec] of proposal.work.entries()) {
    if (
      !spec ||
      typeof spec !== "object" ||
      !PLAN_KEY.test(spec.key) ||
      typeof spec.title !== "string" ||
      spec.title.length < 1 ||
      spec.title.length > 200 ||
      typeof spec.objective !== "string" ||
      spec.objective.length < 1 ||
      spec.objective.length > 4_000 ||
      !Array.isArray(spec.acceptance) ||
      spec.acceptance.length > 50 ||
      spec.acceptance.some((value) => typeof value !== "string" || value.length > 500) ||
      !Array.isArray(spec.dependencies) ||
      spec.dependencies.length > 50 ||
      spec.dependencies.some((value) => typeof value !== "string" || value.length > 100) ||
      !TEMPLATE_ID.test(spec.template)
    ) {
      throw new Error(`supervisor plan proposal ${planId} work[${index}] is invalid`);
    }
  }
}

function validateEvent(event: SupervisorPlanEvent, planId: string, sequence: number): void {
  if (
    event.schema_version !== SUPERVISOR_PLAN_SCHEMA_VERSION ||
    event.plan_id !== planId ||
    event.seq !== sequence ||
    !EVENT_TYPES.has(event.event) ||
    !validTimestamp(event.ts) ||
    typeof event.actor !== "string" ||
    event.actor.length < 1 ||
    event.actor.length > 200 ||
    typeof event.reason !== "string" ||
    event.reason.length < 1 ||
    event.reason.length > 2_000
  ) {
    throw new Error(`supervisor plan ${planId} event ${sequence} has an unsupported schema`);
  }
  if (event.approval_id !== undefined && !APPROVAL_ID.test(event.approval_id)) {
    throw new Error(`supervisor plan ${planId} event ${sequence} has an invalid approval id`);
  }
  if (event.root_work_id !== undefined && !WORK_ID.test(event.root_work_id)) {
    throw new Error(`supervisor plan ${planId} event ${sequence} has an invalid root work id`);
  }
  if (event.work_ids !== undefined) {
    if (!Array.isArray(event.work_ids) || event.work_ids.some((id) => !WORK_ID.test(id))) {
      throw new Error(`supervisor plan ${planId} event ${sequence} has invalid work ids`);
    }
  }
}

function approvalIsResolved(coordRoot: string, approvalId: string): boolean {
  const path = join(coordRoot, ".harnery", "approvals", approvalId, "decision.json");
  if (!existsSync(path)) return false;
  try {
    const value = readJson<Record<string, unknown>>(path, "workflow approval decision");
    return value.approval_id === approvalId && ["allow", "deny"].includes(String(value.verdict));
  } catch {
    return false;
  }
}

function readJson<T>(path: string, label: string): T {
  if (!existsSync(path)) throw new Error(`${label} does not exist at ${path}`);
  const size = statSync(path).size;
  if (size <= 0 || size > MAX_RECORD_BYTES) throw new Error(`${label} has invalid size ${size}`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`cannot parse ${label} at ${path}: ${(error as Error).message}`);
  }
}

function plansRoot(coordRoot: string, goalId: string): string {
  return join(coordRoot, ".harnery", "supervisors", goalId, "plans");
}

function planDir(coordRoot: string, goalId: string, planId: string): string {
  return join(plansRoot(coordRoot, goalId), planId);
}

function assertId(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new Error(`invalid ${label} ${JSON.stringify(value)}`);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}
