import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertWorkId, readWorkItem, type WorkRecord } from "../work/read.ts";
import { workflowScriptDigest } from "../workflow/run-state.ts";
import { normalizeWorkflowSpecialists } from "../workflow/specialists.ts";
import type { WorkflowSpecialistProfile } from "../workflow/types.ts";
import { readGovernorPlans } from "./plan-read.ts";
import {
  type CreateGovernorReplanningInput,
  type GovernorPlanHistory,
  type GovernorPlanRecord,
  type GovernorReplanningPolicy,
  governorGraphFingerprint,
  MAX_GOVERNOR_PLAN_REVIEWERS,
  MAX_GOVERNOR_PLAN_REVISION_ROUNDS,
} from "./plan-types.ts";

export const GOVERNOR_INTENT_SCHEMA_VERSION = 1 as const;

const GOAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_TITLE = 200;
const MAX_OBJECTIVE = 4_000;
const MAX_ACCEPTANCE = 50;
const MAX_INTENT_BYTES = 256 * 1024;
const MAX_TEMPLATES = 20;
const TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FOREIGN_LEASE_STALE_MS = 24 * 60 * 60 * 1_000;
/** Ceiling on CONSECUTIVE uncharged (upstream) replans (ADR 0046). Because an
 * uncharged replan does not spend `max_replans`, an unending vendor outage would
 * otherwise replan forever; this bound stops it and names the outside service.
 * Kept low — each replan is a real planner round-trip — and a module constant
 * rather than a policy field to keep the frozen replanning schema unchanged; an
 * environment failure self-bounds at one because it stops immediately. */
const MAX_UNCHARGED_REPLANS = 3;

export interface GovernorLimits {
  max_cycles: number;
  max_runtime_ms: number;
  max_parallel_work: number;
  max_total_attempts: number;
  max_agents_per_work: number;
  agent_concurrency: number;
}

export interface GovernorAutomationPolicy {
  accept_passing_proof: boolean;
  resume_approved: boolean;
  retry_blocked: boolean;
}

export interface GovernorMission {
  objective: string;
  acceptance: string[];
  max_milestones: number;
}

export interface CreateGovernorMissionInput {
  objective: string;
  acceptance: readonly string[];
  maxMilestones?: number;
}

export interface GovernorIntent {
  schema_version: typeof GOVERNOR_INTENT_SCHEMA_VERSION;
  id: string;
  title: string;
  root_work_id: string;
  specialists: Record<string, WorkflowSpecialistProfile>;
  limits: GovernorLimits;
  automation: GovernorAutomationPolicy;
  mission?: GovernorMission;
  replanning?: GovernorReplanningPolicy;
  created_at: string;
}

export type GovernorState =
  | "ready"
  | "running"
  | "awaiting_attention"
  | "blocked"
  | "budget_exhausted"
  | "succeeded";

export type GovernorNextAction =
  | "run"
  | "wait_for_run"
  | "resolve_approval"
  | "review"
  | "retry"
  | "replan"
  | "plan_initial"
  | "plan_milestone"
  | "review_plan"
  | "retry_plan"
  | "none";

export interface GovernorProjection {
  id: string;
  title: string;
  root_work_id: string;
  root_materialized: boolean;
  state: GovernorState;
  reason: string;
  next_action: GovernorNextAction;
  work_ids: string[];
  ready_work: string[];
  resumable_work: string[];
  retryable_work: string[];
  attention_work: string[];
  attempts_used: number;
  attempts_remaining: number;
  specialists: string[];
  plan_generation: number;
  replans_used: number;
  replans_remaining: number;
  milestones_completed: number;
  milestones_remaining: number;
  pending_plan_id?: string;
  attention_plan_id?: string;
  latest_plan_status?: GovernorPlanRecord["status"];
  /**
   * How consumed (charged) replans that did not advance the graph broke down,
   * present only when at least one replan was spent by a planner run that
   * produced no proposal. `reviewer_rejection` counts replans where a proposal
   * was produced and independent review rejected it (review-round exhaustion,
   * reviewer attention, or review failure); `planner_no_proposal` counts replans
   * where the planner run produced no reviewable proposal at all. Absent when a
   * goal has no planner no-proposal history, so goals that only ever reached
   * review project exactly as before this field existed.
   */
  replan_consumption?: {
    reviewer_rejection: number;
    planner_no_proposal: number;
  };
  governed_work_ids: string[];
}

export interface GovernorRecord {
  intent: GovernorIntent;
  projection: GovernorProjection;
  work: WorkRecord[];
  plans: GovernorPlanRecord[];
}

export interface CreateGovernorInput {
  coordRoot: string;
  rootWorkId?: string;
  specialists: Readonly<Record<string, WorkflowSpecialistProfile>>;
  title?: string;
  id?: string;
  limits?: Partial<GovernorLimits>;
  automation?: Partial<GovernorAutomationPolicy>;
  mission?: CreateGovernorMissionInput;
  replanning?: CreateGovernorReplanningInput;
}

export function createGovernor(input: CreateGovernorInput): GovernorRecord {
  const coordRoot = resolve(input.coordRoot);
  const id = input.id ?? newGovernorId();
  assertGovernorId(id);
  const mission = input.mission ? normalizeMission(input.mission) : undefined;
  if (mission && !input.replanning) {
    throw new Error("governor mission requires a replanning policy");
  }
  if (!input.rootWorkId && !mission) {
    throw new Error("governor creation without root work requires a mission and replanning policy");
  }
  if (input.rootWorkId) assertWorkId(input.rootWorkId);
  const root = input.rootWorkId ? readWorkItem(coordRoot, input.rootWorkId) : undefined;
  const limits = normalizeLimits(input.limits);
  const replanning = input.replanning
    ? normalizeReplanning(input.replanning, input.specialists, limits)
    : undefined;
  if (
    mission &&
    !input.rootWorkId &&
    replanning &&
    replanning.max_replans <= mission.max_milestones
  ) {
    throw new Error(
      "objective-first mission max_replans must exceed max_milestones to reserve completion review",
    );
  }
  const intent: GovernorIntent = {
    schema_version: GOVERNOR_INTENT_SCHEMA_VERSION,
    id,
    title: bounded(
      input.title ?? root?.intent.title ?? missionTitle(mission!),
      "governor title",
      MAX_TITLE,
    ),
    root_work_id: input.rootWorkId ?? missionRootId(id),
    specialists: normalizeWorkflowSpecialists(input.specialists),
    limits,
    automation: normalizeAutomation(input.automation),
    ...(mission ? { mission } : {}),
    ...(replanning ? { replanning } : {}),
    created_at: new Date().toISOString(),
  };
  const path = governorIntentPath(coordRoot, id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writePrivateJson(path, intent);
  return readGovernor(coordRoot, id);
}

export function readGovernor(coordRoot: string, goalId: string): GovernorRecord {
  return readGovernorInternal(coordRoot, goalId, false);
}

/** @internal Runner seam; ignores the lease held by this governor process. */
export function readGovernorIgnoringLease(coordRoot: string, goalId: string): GovernorRecord {
  return readGovernorInternal(coordRoot, goalId, true);
}

export function listGovernors(coordRoot: string): GovernorRecord[] {
  const base = join(resolve(coordRoot), ".harnery", "governors");
  if (!existsSync(base)) return [];
  const records: GovernorRecord[] = [];
  for (const name of readdirSync(base)) {
    if (!GOAL_ID.test(name) || !existsSync(governorIntentPath(coordRoot, name))) continue;
    records.push(readGovernor(coordRoot, name));
  }
  return records.sort((left, right) =>
    right.intent.created_at.localeCompare(left.intent.created_at),
  );
}

export function collectGovernorWork(coordRoot: string, rootWorkId: string): WorkRecord[] {
  const records = new Map<string, WorkRecord>();
  const visiting = new Set<string>();
  const visit = (workId: string): void => {
    if (records.has(workId)) return;
    if (visiting.has(workId)) throw new Error(`governor work graph contains a cycle at ${workId}`);
    visiting.add(workId);
    const record = readWorkItem(coordRoot, workId);
    for (const dependency of record.intent.dependencies) visit(dependency);
    visiting.delete(workId);
    records.set(workId, record);
  };
  visit(rootWorkId);
  return Array.from(records.values());
}

export function assertGovernorId(goalId: string): void {
  if (!GOAL_ID.test(goalId)) throw new Error(`invalid governor id ${JSON.stringify(goalId)}`);
}

export function newGovernorId(): string {
  return `goal-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
}

/** @internal Runner seam; one exclusive crash-recoverable governor lease. */
export function acquireGovernorLease(coordRoot: string, goalId: string): () => void {
  readGovernorIntent(coordRoot, goalId);
  const path = join(governorDir(coordRoot, goalId), "lease.json");
  const owner = {
    pid: process.pid,
    host: hostname(),
    created_at: new Date().toISOString(),
    nonce: randomUUID(),
  };
  const acquire = (): boolean => {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      chmodSync(path, 0o600);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };
  if (!acquire()) {
    const existing = readLease(path);
    if (existing && leaseIsLive(existing)) {
      throw new Error(
        `governor ${goalId} is already running under pid ${existing.pid} on ${existing.host}`,
      );
    }
    unlinkSync(path);
    if (!acquire()) throw new Error(`governor ${goalId} lease raced with another process`);
  }
  return () => {
    try {
      const existing = readLease(path);
      if (existing?.nonce === owner.nonce) unlinkSync(path);
    } catch {
      // A stale private lease is recoverable by the next explicit run.
    }
  };
}

function readGovernorInternal(
  coordRootRaw: string,
  goalId: string,
  ignoreLease: boolean,
): GovernorRecord {
  const coordRoot = resolve(coordRootRaw);
  const intent = readGovernorIntent(coordRoot, goalId);
  const plans = readGovernorPlans(coordRoot, intent.id, intent.root_work_id);
  const activeRootExists = workIntentExists(coordRoot, plans.active_root_work_id);
  if (!activeRootExists && (!intent.mission || plans.generation > 0)) {
    throw new Error(`governor ${intent.id} root work is missing`);
  }
  const work = activeRootExists ? collectGovernorWork(coordRoot, plans.active_root_work_id) : [];
  const governed = collectGovernedWork(coordRoot, intent.root_work_id, plans, work);
  return {
    intent,
    work,
    plans: plans.plans,
    projection: deriveProjection(coordRoot, intent, work, governed, plans, ignoreLease),
  };
}

function deriveProjection(
  coordRoot: string,
  intent: GovernorIntent,
  work: WorkRecord[],
  governed: WorkRecord[],
  plans: GovernorPlanHistory,
  ignoreLease: boolean,
): GovernorProjection {
  const root = work.find((record) => record.intent.id === plans.active_root_work_id);
  const attemptsUsed = governed.reduce((sum, record) => sum + record.projection.attempts_used, 0);
  // The goal budget, like the per-item budget, counts only charged attempts
  // (ADR 0046): an uncharged environment/upstream attempt on any child does not
  // spend the goal's total. attempts_used stays the raw count for display.
  const chargedUsed = governed.reduce((sum, record) => sum + record.projection.charged_attempts, 0);
  // Replans, like per-item attempts (ADR 0046), are budgeted by the CHARGED
  // count: an uncharged planner failure (environment/upstream) does not spend
  // max_replans. replans_used stays the raw count for display.
  const unchargedReplans = plans.plans.filter(
    (plan) =>
      plan.status === "failed" && (plan.class === "environment" || plan.class === "upstream"),
  ).length;
  const chargedReplans = plans.plans.length - unchargedReplans;
  // Attribute the consumed replans that did not advance the graph so the
  // projection can distinguish planner no-proposal exhaustion from reviewer
  // rejection through existing plan seams (review receipt presence), rather than
  // reporting both as a single undifferentiated replan exhaustion.
  const replanConsumption = classifyReplanConsumption(plans);
  const readyWork = work
    .filter((record) => record.projection.state === "ready")
    .map((record) => record.intent.id);
  const resumableWork = work
    .filter(
      (record) =>
        record.projection.state === "awaiting_approval" &&
        record.projection.next_action === "resume",
    )
    .map((record) => record.intent.id);
  const retryableWork = work
    .filter(
      (record) =>
        record.projection.state === "blocked" && record.projection.next_action === "retry",
    )
    .map((record) => record.intent.id);
  const pendingApproval = work
    .filter(
      (record) =>
        record.projection.state === "awaiting_approval" &&
        record.projection.next_action === "resolve_approval",
    )
    .map((record) => record.intent.id);
  const reviews = work
    .filter((record) => record.projection.state === "in_review")
    .map((record) => record.intent.id);
  const cancelled = work
    .filter((record) => record.projection.state === "cancelled")
    .map((record) => record.intent.id);
  const terminalBlocked = work
    .filter(
      (record) => record.projection.state === "blocked" && record.projection.next_action === "none",
    )
    .map((record) => record.intent.id);
  const attentionWork = unique([
    ...pendingApproval,
    ...(intent.automation.accept_passing_proof ? [] : reviews),
    ...(intent.automation.resume_approved ? [] : resumableWork),
    ...(intent.automation.retry_blocked ? [] : retryableWork),
    ...cancelled,
    ...terminalBlocked,
  ]);
  const initialRootAccepted =
    intent.mission !== undefined &&
    governed.some(
      (record) =>
        record.intent.id === intent.root_work_id && record.projection.state === "succeeded",
    );
  const milestonesCompleted = plans.milestones_completed + (initialRootAccepted ? 1 : 0);
  const resumableDispatchable = intent.automation.resume_approved ? resumableWork : [];
  const attemptDispatchable = [
    ...readyWork,
    ...(intent.automation.retry_blocked ? retryableWork : []),
  ];
  const dispatchable = [...resumableDispatchable, ...attemptDispatchable];
  const base = {
    id: intent.id,
    title: intent.title,
    root_work_id: plans.active_root_work_id,
    root_materialized: root !== undefined,
    work_ids: work.map((record) => record.intent.id),
    ready_work: readyWork,
    resumable_work: resumableWork,
    retryable_work: retryableWork,
    attention_work: attentionWork,
    attempts_used: attemptsUsed,
    attempts_remaining: Math.max(0, intent.limits.max_total_attempts - chargedUsed),
    specialists: Object.keys(intent.specialists),
    plan_generation: plans.generation,
    replans_used: plans.plans.length,
    replans_remaining: Math.max(0, (intent.replanning?.max_replans ?? 0) - chargedReplans),
    milestones_completed: milestonesCompleted,
    milestones_remaining: Math.max(0, (intent.mission?.max_milestones ?? 0) - milestonesCompleted),
    pending_plan_id: plans.latest?.status === "proposed" ? plans.latest.request.id : undefined,
    latest_plan_status: plans.latest?.status,
    ...(replanConsumption.planner_no_proposal > 0 ? { replan_consumption: replanConsumption } : {}),
    governed_work_ids: governed.map((record) => record.intent.id),
  };
  if (!ignoreLease && governorLeaseIsLive(coordRoot, intent.id)) {
    return {
      ...base,
      state: "running",
      reason: "the foreground governor holds the goal lease",
      next_action: "wait_for_run",
    };
  }
  if (intent.mission && plans.completed) {
    return {
      ...base,
      state: "succeeded",
      reason: "mission completion was explicitly accepted",
      next_action: "none",
    };
  }
  // ADR 0050: a mission whose completion was reopened dispatches the reopened work
  // before anything else. Without this the goal falls through to the milestone
  // branch below, which still sees a succeeded root when the reopened item is one
  // of its children, and would spend a replan reassessing a mission whose real
  // remaining work is already sitting in ready_work.
  if (intent.mission && plans.latest?.status === "reopened" && dispatchable.length > 0) {
    return {
      ...base,
      state: "ready",
      reason: `mission completion was reopened; ${dispatchable.length} work item${dispatchable.length === 1 ? " is" : "s are"} dispatchable`,
      next_action: "run",
    };
  }
  if (plans.latest?.status === "proposed") {
    return {
      ...base,
      state: "awaiting_attention",
      reason: `replacement plan ${plans.latest.request.id} awaits explicit review`,
      next_action: "review_plan",
    };
  }
  if (plans.latest?.status === "awaiting_approval") {
    return {
      ...base,
      state: "awaiting_attention",
      reason: `planner workflow awaits approval ${plans.latest.approval_id}`,
      next_action: "resolve_approval",
    };
  }
  if (plans.latest?.status === "resumable") {
    return {
      ...base,
      state: "ready",
      reason: `planner workflow ${plans.latest.request.workflow_run_id} is resumable`,
      next_action: "replan",
    };
  }
  // ADR 0046: a planner failure that never touched the plan is handled before
  // the replan path. Otherwise a "failed" plan falls through to canReplan and
  // the runner replans an unchanged environment on every tick — the failure mode
  // that burned the measured 19 "codex not found" replans.
  if (plans.latest?.status === "failed" && plans.latest.class === "environment") {
    // A missing precondition (the planner binary was absent). Retrying an
    // unchanged environment cannot help, so the goal STOPS and names it. A human
    // who installs the binary can re-run; the failure was uncharged, so the
    // replan budget is intact.
    return {
      ...base,
      state: "blocked",
      reason: `planning could not start; a required precondition is missing: ${plans.latest.reason ?? "the planner binary was absent"}`,
      next_action: "none",
    };
  }
  if (plans.latest?.status === "failed" && plans.latest.class === "upstream") {
    // The vendor refused. Uncharged replans do not spend max_replans, so the
    // only brake on an unending outage is this consecutive bound; at the limit
    // the goal stops and names the outside service, distinct from work-blocked.
    let trailingUncharged = 0;
    for (let index = plans.plans.length - 1; index >= 0; index--) {
      const plan = plans.plans[index]!;
      if (plan.status !== "failed" || (plan.class !== "environment" && plan.class !== "upstream")) {
        break;
      }
      trailingUncharged++;
    }
    if (trailingUncharged >= MAX_UNCHARGED_REPLANS) {
      return {
        ...base,
        state: "blocked",
        reason: `planning is blocked waiting on an outside service after ${trailingUncharged} consecutive uncharged attempt(s): ${plans.latest.reason ?? "the vendor refused"}`,
        next_action: "none",
      };
    }
    // Under the bound: fall through so the goal replans when nothing else is
    // dispatchable — the vendor may have recovered. canReplan reads
    // chargedReplans, so these uncharged attempts do not exhaust max_replans.
  }
  const triggerFingerprint = governorGraphFingerprint({
    rootWorkId: plans.active_root_work_id,
    generation: plans.generation,
    work,
  });
  const latestHandledSameGraph =
    plans.latest?.request.trigger_fingerprint === triggerFingerprint &&
    plans.latest.request.prior_root_work_id === plans.active_root_work_id &&
    plans.latest.status === "attention";
  if (latestHandledSameGraph && plans.latest) {
    const canRetry =
      intent.replanning !== undefined && chargedReplans < intent.replanning.max_replans;
    return {
      ...base,
      state: "awaiting_attention",
      reason: canRetry
        ? (plans.latest.reason ?? `plan ${plans.latest.request.id} requires attention`)
        : exhaustedAttentionReason(plans.latest, replanConsumption),
      attention_plan_id: plans.latest.request.id,
      next_action: canRetry ? "retry_plan" : "none",
    };
  }
  if (!root && intent.mission) {
    if (!intent.replanning || chargedReplans >= intent.replanning.max_replans) {
      return {
        ...base,
        state: "budget_exhausted",
        reason: replanBudgetReason(
          "mission exhausted its planning budget before creating an initial milestone",
          replanConsumption,
        ),
        next_action: "none",
      };
    }
    return {
      ...base,
      state: "ready",
      reason: "mission is ready for its initial bounded milestone plan",
      next_action: "plan_initial",
    };
  }
  if (!root) throw new Error(`governor ${intent.id} root work is missing`);
  if (root.projection.state === "succeeded" && intent.mission) {
    if (!intent.replanning || chargedReplans >= intent.replanning.max_replans) {
      return {
        ...base,
        state: "budget_exhausted",
        reason: replanBudgetReason(
          "mission exhausted its planning budget at a milestone boundary",
          replanConsumption,
        ),
        next_action: "none",
      };
    }
    return {
      ...base,
      state: "ready",
      reason: `milestone ${plans.milestones_completed} is accepted and requires mission reassessment`,
      next_action: "plan_milestone",
    };
  }
  if (root.projection.state === "succeeded") {
    return {
      ...base,
      state: "succeeded",
      reason: "root work was explicitly accepted",
      next_action: "none",
    };
  }
  if (intent.automation.accept_passing_proof && reviews.length > 0) {
    return {
      ...base,
      state: "ready",
      reason: `${reviews.length} passing work item${reviews.length === 1 ? "" : "s"} may be accepted by frozen policy`,
      next_action: "run",
    };
  }
  if (resumableDispatchable.length > 0) {
    return {
      ...base,
      state: "ready",
      reason: `${resumableDispatchable.length} parked run${resumableDispatchable.length === 1 ? " is" : "s are"} resumable`,
      next_action: "run",
    };
  }
  if (chargedUsed >= intent.limits.max_total_attempts && attemptDispatchable.length > 0) {
    return {
      ...base,
      state: "budget_exhausted",
      reason: `goal exhausted its ${intent.limits.max_total_attempts} total attempts`,
      next_action: "none",
    };
  }
  if (dispatchable.length > 0) {
    return {
      ...base,
      state: "ready",
      reason: `${dispatchable.length} work item${dispatchable.length === 1 ? " is" : "s are"} dispatchable`,
      next_action: "run",
    };
  }
  if (pendingApproval.length > 0) {
    return {
      ...base,
      state: "awaiting_attention",
      reason: `${pendingApproval.length} work item${pendingApproval.length === 1 ? " needs" : "s need"} approval`,
      next_action: "resolve_approval",
    };
  }
  if (reviews.length > 0) {
    return {
      ...base,
      state: "awaiting_attention",
      reason: `${reviews.length} work item${reviews.length === 1 ? " awaits" : "s await"} explicit review`,
      next_action: "review",
    };
  }
  if (resumableWork.length > 0) {
    return {
      ...base,
      state: "awaiting_attention",
      reason: `${resumableWork.length} resolved approval${resumableWork.length === 1 ? " requires" : "s require"} explicit resume`,
      next_action: "run",
    };
  }
  if (retryableWork.length > 0) {
    return {
      ...base,
      state: "blocked",
      reason: `${retryableWork.length} blocked work item${retryableWork.length === 1 ? " requires" : "s require"} explicit retry`,
      next_action: "retry",
    };
  }
  if (chargedUsed >= intent.limits.max_total_attempts && cancelled.length === 0) {
    return {
      ...base,
      state: "budget_exhausted",
      reason: `goal exhausted its ${intent.limits.max_total_attempts} total attempts`,
      next_action: "none",
    };
  }
  const canReplan =
    intent.replanning !== undefined &&
    chargedReplans < intent.replanning.max_replans &&
    cancelled.length === 0 &&
    !latestHandledSameGraph;
  if (canReplan) {
    return {
      ...base,
      state: "ready",
      reason: terminalBlocked.length
        ? `${terminalBlocked.length} terminally blocked work item${terminalBlocked.length === 1 ? " can" : "s can"} be replanned`
        : "the active graph has no legal progress action and may be replanned",
      next_action: "replan",
    };
  }
  if (
    intent.replanning &&
    chargedReplans >= intent.replanning.max_replans &&
    cancelled.length === 0
  ) {
    return {
      ...base,
      state: "budget_exhausted",
      reason: replanBudgetReason(
        `goal exhausted its ${intent.replanning.max_replans} replans`,
        replanConsumption,
      ),
      next_action: "none",
    };
  }
  return {
    ...base,
    state: "blocked",
    reason:
      attentionWork.length > 0
        ? `${attentionWork.length} work item${attentionWork.length === 1 ? " needs" : "s need"} intervention`
        : "goal graph has no legal progress action",
    next_action: "none",
  };
}

interface ReplanConsumption {
  reviewer_rejection: number;
  planner_no_proposal: number;
}

/**
 * Classify each consumed replan that did not advance the graph, using existing
 * plan seams only. A plan carries a review receipt exactly when a proposal was
 * produced and independently reviewed, so its presence separates a reviewer
 * rejection from a planner run that produced no reviewable proposal. Uncharged
 * environment/upstream planner failures (ADR 0046) do not spend the replan
 * budget and are attributed to their outside precondition, not counted here.
 */
function classifyReplanConsumption(plans: GovernorPlanHistory): ReplanConsumption {
  let reviewerRejection = 0;
  let plannerNoProposal = 0;
  for (const plan of plans.plans) {
    if (plan.status === "failed" && (plan.class === "environment" || plan.class === "upstream")) {
      continue;
    }
    if (plan.review && plan.review.status !== "passed") {
      reviewerRejection++;
    } else if (
      !plan.review &&
      (plan.status === "attention" ||
        plan.status === "interrupted" ||
        plan.status === "failed" ||
        plan.status === "retry_requested")
    ) {
      // `retry_requested` is a planner no-proposal attention the operator asked to
      // replan: the original run still produced no reviewable proposal and still
      // spent a charged replan, so it belongs in this bucket even though a later
      // plan superseded it. Omitting it would misattribute a retried no-proposal
      // to nothing and let the reason read as pure review exhaustion.
      plannerNoProposal++;
    }
  }
  return { reviewer_rejection: reviewerRejection, planner_no_proposal: plannerNoProposal };
}

/**
 * Reason for a goal held at `awaiting_attention/none` because its latest plan is
 * an unresolved attention and no replan slot remains. The latest plan's own
 * per-plan reason always leads (a reviewed-and-rejected latest reports its
 * review-round exhaustion verbatim), then `replanBudgetReason` names the planner
 * no-proposal share of the consumed budget. This keeps the `projection.reason`
 * field carrying the same truth the operator-visible row does: a goal whose
 * budget was mostly spent by planner no-proposal runs is not attributed wholesale
 * to review just because its final, reviewed plan happened to be rejected.
 */
function exhaustedAttentionReason(
  latest: GovernorPlanRecord,
  consumption: ReplanConsumption,
): string {
  const fallback = latest.reason ?? `plan ${latest.request.id} requires attention`;
  return replanBudgetReason(fallback, consumption);
}

/**
 * Append planner no-proposal attribution to a replan-exhaustion reason. Returns
 * the base reason unchanged when no consumed replan was a planner no-proposal
 * outcome, so goals without that history project exactly as before.
 */
function replanBudgetReason(base: string, consumption: ReplanConsumption): string {
  if (consumption.planner_no_proposal <= 0) return base;
  const count = consumption.planner_no_proposal;
  return `${base}; ${count} replan${count === 1 ? "" : "s"} ended with the planner producing no proposal`;
}

function readGovernorIntent(coordRoot: string, goalId: string): GovernorIntent {
  assertGovernorId(goalId);
  const path = governorIntentPath(coordRoot, goalId);
  if (!existsSync(path)) throw new Error(`governor ${goalId} does not exist`);
  const size = statSync(path).size;
  if (size <= 0 || size > MAX_INTENT_BYTES) {
    throw new Error(`governor intent has invalid size ${size}`);
  }
  let intent: GovernorIntent;
  try {
    intent = JSON.parse(readFileSync(path, "utf8")) as GovernorIntent;
  } catch (error) {
    throw new Error(`cannot parse governor intent ${goalId}: ${(error as Error).message}`);
  }
  validateIntent(intent, goalId);
  return intent;
}

function validateIntent(intent: GovernorIntent, goalId: string): void {
  if (
    intent.schema_version !== GOVERNOR_INTENT_SCHEMA_VERSION ||
    intent.id !== goalId ||
    !validTimestamp(intent.created_at)
  ) {
    throw new Error(`governor intent ${goalId} has an unsupported or mismatched schema`);
  }
  bounded(intent.title, "governor title", MAX_TITLE);
  assertWorkId(intent.root_work_id);
  if (intent.mission) {
    const normalizedMission = normalizeMission({
      objective: intent.mission.objective,
      acceptance: intent.mission.acceptance,
      maxMilestones: intent.mission.max_milestones,
    });
    if (JSON.stringify(normalizedMission) !== JSON.stringify(intent.mission)) {
      throw new Error(`governor intent ${goalId} mission is not canonical`);
    }
    if (!intent.replanning) {
      throw new Error(`governor intent ${goalId} mission requires replanning`);
    }
  }
  const specialists = normalizeWorkflowSpecialists(intent.specialists);
  if (JSON.stringify(specialists) !== JSON.stringify(intent.specialists)) {
    throw new Error(`governor intent ${goalId} specialists are not canonical`);
  }
  if (JSON.stringify(normalizeLimits(intent.limits)) !== JSON.stringify(intent.limits)) {
    throw new Error(`governor intent ${goalId} limits are not canonical`);
  }
  if (
    JSON.stringify(normalizeAutomation(intent.automation)) !== JSON.stringify(intent.automation)
  ) {
    throw new Error(`governor intent ${goalId} automation policy is not canonical`);
  }
  if (intent.replanning) validateReplanning(intent.replanning, specialists, intent.limits, goalId);
}

function normalizeMission(input: CreateGovernorMissionInput): GovernorMission {
  if (!Array.isArray(input.acceptance)) {
    throw new Error("governor mission acceptance must be an array");
  }
  if (input.acceptance.length < 1 || input.acceptance.length > MAX_ACCEPTANCE) {
    throw new Error(`governor mission acceptance must contain 1 to ${MAX_ACCEPTANCE} criteria`);
  }
  const acceptance = input.acceptance.map((criterion, index) =>
    bounded(criterion, `governor mission acceptance[${index}]`, 500),
  );
  if (new Set(acceptance).size !== acceptance.length) {
    throw new Error("governor mission acceptance criteria must be unique");
  }
  return {
    objective: bounded(input.objective, "governor mission objective", MAX_OBJECTIVE),
    acceptance,
    max_milestones: positive(input.maxMilestones ?? 4, "governor mission max_milestones", 20),
  };
}

function missionTitle(mission: GovernorMission): string {
  return mission.objective.length <= MAX_TITLE
    ? mission.objective
    : `${mission.objective.slice(0, MAX_TITLE - 1).trimEnd()}…`;
}

function normalizeLimits(input: Partial<GovernorLimits> | undefined): GovernorLimits {
  return {
    max_cycles: positive(input?.max_cycles ?? 50, "governor max_cycles", 1_000),
    max_runtime_ms: positive(
      input?.max_runtime_ms ?? 4 * 60 * 60 * 1_000,
      "governor max_runtime_ms",
      7 * 24 * 60 * 60 * 1_000,
    ),
    max_parallel_work: positive(input?.max_parallel_work ?? 1, "governor max_parallel_work", 20),
    max_total_attempts: positive(
      input?.max_total_attempts ?? 100,
      "governor max_total_attempts",
      10_000,
    ),
    max_agents_per_work: positive(
      input?.max_agents_per_work ?? 20,
      "governor max_agents_per_work",
      1_000,
    ),
    agent_concurrency: positive(input?.agent_concurrency ?? 4, "governor agent_concurrency", 100),
  };
}

function normalizeAutomation(
  input: Partial<GovernorAutomationPolicy> | undefined,
): GovernorAutomationPolicy {
  return {
    accept_passing_proof: boolean(input?.accept_passing_proof ?? false, "accept_passing_proof"),
    resume_approved: boolean(input?.resume_approved ?? true, "resume_approved"),
    retry_blocked: boolean(input?.retry_blocked ?? false, "retry_blocked"),
  };
}

function normalizeReplanning(
  input: CreateGovernorReplanningInput,
  specialistsInput: Readonly<Record<string, WorkflowSpecialistProfile>>,
  limits: GovernorLimits,
): GovernorReplanningPolicy {
  const specialists = normalizeWorkflowSpecialists(specialistsInput);
  const plannerSpecialist = bounded(input.plannerSpecialist, "planner specialist", 100);
  if (!specialists[plannerSpecialist]) {
    throw new Error(`planner specialist ${plannerSpecialist} is not present in the frozen team`);
  }
  const entries = Object.entries(input.templates);
  if (entries.length < 1 || entries.length > MAX_TEMPLATES) {
    throw new Error(`replanning templates must contain 1 to ${MAX_TEMPLATES} entries`);
  }
  const templates = Object.fromEntries(
    entries
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, template]) => {
        if (!TEMPLATE_ID.test(id)) throw new Error(`invalid replanning template id ${id}`);
        const path = resolve(template.workflowPath);
        if (!existsSync(path))
          throw new Error(`replanning template ${id} does not exist at ${path}`);
        const maxAttempts = positive(
          template.maxAttempts ?? 3,
          `replanning template ${id} maxAttempts`,
          100,
        );
        return [
          id,
          {
            workflow: { path, sha256: workflowScriptDigest(path) },
            max_attempts: maxAttempts,
            root: boolean(template.root ?? false, `replanning template ${id} root`),
          },
        ];
      }),
  );
  if (!Object.values(templates).some((template) => template.root)) {
    throw new Error("replanning requires at least one root-capable template");
  }
  const maxWorkItemsPerPlan = positive(
    input.maxWorkItemsPerPlan ?? 8,
    "replanning max_work_items_per_plan",
    25,
  );
  const maxTotalWorkItems = positive(
    input.maxTotalWorkItems ?? 25,
    "replanning max_total_work_items",
    100,
  );
  if (maxWorkItemsPerPlan > maxTotalWorkItems) {
    throw new Error("replanning max_work_items_per_plan cannot exceed max_total_work_items");
  }
  const review = input.review
    ? normalizeReviewPolicy(input.review, specialists, plannerSpecialist, limits)
    : undefined;
  return {
    planner_specialist: plannerSpecialist,
    auto_apply: boolean(input.autoApply ?? false, "replanning auto_apply"),
    max_replans: positive(input.maxReplans ?? 5, "replanning max_replans", 100),
    max_work_items_per_plan: maxWorkItemsPerPlan,
    max_total_work_items: maxTotalWorkItems,
    templates,
    ...(review ? { review } : {}),
  };
}

function normalizeReviewPolicy(
  input: NonNullable<CreateGovernorReplanningInput["review"]>,
  specialists: Record<string, WorkflowSpecialistProfile>,
  plannerSpecialist: string,
  limits: GovernorLimits,
): NonNullable<GovernorReplanningPolicy["review"]> {
  if (!Array.isArray(input.reviewerSpecialists) || input.reviewerSpecialists.length < 1) {
    throw new Error("replanning review requires at least one reviewer specialist");
  }
  if (input.reviewerSpecialists.length > MAX_GOVERNOR_PLAN_REVIEWERS) {
    throw new Error(
      `replanning review cannot exceed ${MAX_GOVERNOR_PLAN_REVIEWERS} reviewer specialists`,
    );
  }
  const reviewerSpecialists = input.reviewerSpecialists.map((specialist, index) =>
    bounded(specialist, `reviewer specialist[${index}]`, 100),
  );
  if (new Set(reviewerSpecialists).size !== reviewerSpecialists.length) {
    throw new Error("replanning reviewer specialists must be unique");
  }
  for (const specialist of reviewerSpecialists) {
    if (!specialists[specialist]) {
      throw new Error(`reviewer specialist ${specialist} is not present in the frozen team`);
    }
    if (specialist === plannerSpecialist) {
      throw new Error("reviewer specialist cannot be the planner specialist");
    }
  }
  const maxRevisionRounds = nonNegative(
    input.maxRevisionRounds,
    "replanning review max_revision_rounds",
    MAX_GOVERNOR_PLAN_REVISION_ROUNDS,
  );
  const worstCaseAgents =
    1 + reviewerSpecialists.length * (maxRevisionRounds + 1) + maxRevisionRounds;
  if (worstCaseAgents > limits.max_agents_per_work) {
    throw new Error(
      `replanning review worst-case ${worstCaseAgents} agents exceeds max_agents_per_work ${limits.max_agents_per_work}`,
    );
  }
  return {
    reviewer_specialists: reviewerSpecialists,
    max_revision_rounds: maxRevisionRounds,
  };
}

function validateReplanning(
  policy: GovernorReplanningPolicy,
  specialists: Record<string, WorkflowSpecialistProfile>,
  limits: GovernorLimits,
  goalId: string,
): void {
  if (!specialists[policy.planner_specialist]) {
    throw new Error(`governor ${goalId} planner specialist is not in the frozen team`);
  }
  boolean(policy.auto_apply, "replanning auto_apply");
  positive(policy.max_replans, "replanning max_replans", 100);
  positive(policy.max_work_items_per_plan, "replanning max_work_items_per_plan", 25);
  positive(policy.max_total_work_items, "replanning max_total_work_items", 100);
  if (policy.max_work_items_per_plan > policy.max_total_work_items) {
    throw new Error(`governor ${goalId} replanning work-item bounds are inconsistent`);
  }
  const entries = Object.entries(policy.templates ?? {});
  if (entries.length < 1 || entries.length > MAX_TEMPLATES) {
    throw new Error(`governor ${goalId} has invalid replanning templates`);
  }
  let rootCapable = false;
  for (const [id, template] of entries) {
    if (
      !TEMPLATE_ID.test(id) ||
      !isAbsolute(template.workflow?.path) ||
      !/^[a-f0-9]{64}$/.test(template.workflow?.sha256) ||
      !Number.isSafeInteger(template.max_attempts) ||
      template.max_attempts < 1 ||
      template.max_attempts > 100 ||
      typeof template.root !== "boolean"
    ) {
      throw new Error(`governor ${goalId} replanning template ${id} is invalid`);
    }
    rootCapable ||= template.root;
  }
  if (!rootCapable) throw new Error(`governor ${goalId} has no root-capable replanning template`);
  if (policy.review !== undefined) {
    const review = policy.review;
    if (
      !Array.isArray(review.reviewer_specialists) ||
      review.reviewer_specialists.length < 1 ||
      review.reviewer_specialists.length > MAX_GOVERNOR_PLAN_REVIEWERS ||
      !Number.isSafeInteger(review.max_revision_rounds) ||
      review.max_revision_rounds < 0 ||
      review.max_revision_rounds > MAX_GOVERNOR_PLAN_REVISION_ROUNDS
    ) {
      throw new Error(`governor ${goalId} replanning review policy is invalid`);
    }
    if (new Set(review.reviewer_specialists).size !== review.reviewer_specialists.length) {
      throw new Error(`governor ${goalId} replanning reviewers are not unique`);
    }
    for (const specialist of review.reviewer_specialists) {
      if (!specialists[specialist]) {
        throw new Error(`governor ${goalId} reviewer specialist is not in the frozen team`);
      }
      if (specialist === policy.planner_specialist) {
        throw new Error(`governor ${goalId} reviewer specialist cannot be planner`);
      }
    }
    const worstCaseAgents =
      1 +
      review.reviewer_specialists.length * (review.max_revision_rounds + 1) +
      review.max_revision_rounds;
    if (worstCaseAgents > limits.max_agents_per_work) {
      throw new Error(`governor ${goalId} review policy exceeds the agent budget`);
    }
  }
}

function collectGovernedWork(
  coordRoot: string,
  originalRootWorkId: string,
  plans: GovernorPlanHistory,
  active: WorkRecord[],
): WorkRecord[] {
  const governed = new Map<string, WorkRecord>();
  if (workIntentExists(coordRoot, originalRootWorkId)) {
    for (const record of collectGovernorWork(coordRoot, originalRootWorkId)) {
      governed.set(record.intent.id, record);
    }
  }
  for (const workId of plans.applied_work_ids)
    governed.set(workId, readWorkItem(coordRoot, workId));
  for (const record of active) governed.set(record.intent.id, record);
  return [...governed.values()];
}

function workIntentExists(coordRoot: string, workId: string): boolean {
  return existsSync(join(resolve(coordRoot), ".harnery", "work", workId, "intent.json"));
}

function missionRootId(goalId: string): string {
  return `${goalId.slice(0, 87)}-mission-root`;
}

function governorDir(coordRoot: string, goalId: string): string {
  assertGovernorId(goalId);
  return join(resolve(coordRoot), ".harnery", "governors", goalId);
}

function governorIntentPath(coordRoot: string, goalId: string): string {
  return join(governorDir(coordRoot, goalId), "intent.json");
}

function governorLeaseIsLive(coordRoot: string, goalId: string): boolean {
  const lease = readLease(join(governorDir(coordRoot, goalId), "lease.json"));
  return lease ? leaseIsLive(lease) : false;
}

function readLease(
  path: string,
): { pid: number; host: string; created_at: string; nonce?: string } | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.host === "string" &&
      typeof value.created_at === "string"
      ? {
          pid: value.pid,
          host: value.host,
          created_at: value.created_at,
          nonce: typeof value.nonce === "string" ? value.nonce : undefined,
        }
      : null;
  } catch {
    return null;
  }
}

function leaseIsLive(lease: { pid: number; host: string; created_at: string }): boolean {
  if (lease.host !== hostname()) {
    const age = Date.now() - Date.parse(lease.created_at);
    return Number.isFinite(age) && age < FOREIGN_LEASE_STALE_MS;
  }
  try {
    process.kill(lease.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function writePrivateJson(path: string, value: unknown): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_INTENT_BYTES) {
    throw new Error(`governor intent exceeds ${MAX_INTENT_BYTES} bytes`);
  }
  writeFileSync(path, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function positive(value: unknown, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`${field} must be an integer from 1 to ${max}`);
  }
  return value as number;
}

function nonNegative(value: unknown, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new Error(`${field} must be an integer between 0 and ${max}`);
  }
  return value as number;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`governor ${field} must be boolean`);
  return value;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
