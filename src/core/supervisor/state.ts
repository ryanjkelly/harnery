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
import { readSupervisorPlans } from "./plan-read.ts";
import {
  type CreateSupervisorReplanningInput,
  type SupervisorPlanHistory,
  type SupervisorPlanRecord,
  type SupervisorReplanningPolicy,
  supervisorGraphFingerprint,
} from "./plan-types.ts";

export const SUPERVISOR_INTENT_SCHEMA_VERSION = 1 as const;

const GOAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_TITLE = 200;
const MAX_INTENT_BYTES = 256 * 1024;
const MAX_TEMPLATES = 20;
const TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FOREIGN_LEASE_STALE_MS = 24 * 60 * 60 * 1_000;

export interface SupervisorLimits {
  max_cycles: number;
  max_runtime_ms: number;
  max_parallel_work: number;
  max_total_attempts: number;
  max_agents_per_work: number;
  agent_concurrency: number;
}

export interface SupervisorAutomationPolicy {
  accept_passing_proof: boolean;
  resume_approved: boolean;
  retry_blocked: boolean;
}

export interface SupervisorIntent {
  schema_version: typeof SUPERVISOR_INTENT_SCHEMA_VERSION;
  id: string;
  title: string;
  root_work_id: string;
  specialists: Record<string, WorkflowSpecialistProfile>;
  limits: SupervisorLimits;
  automation: SupervisorAutomationPolicy;
  replanning?: SupervisorReplanningPolicy;
  created_at: string;
}

export type SupervisorState =
  | "ready"
  | "running"
  | "awaiting_attention"
  | "blocked"
  | "budget_exhausted"
  | "succeeded";

export type SupervisorNextAction =
  | "run"
  | "wait_for_run"
  | "resolve_approval"
  | "review"
  | "retry"
  | "replan"
  | "review_plan"
  | "none";

export interface SupervisorProjection {
  id: string;
  title: string;
  root_work_id: string;
  state: SupervisorState;
  reason: string;
  next_action: SupervisorNextAction;
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
  pending_plan_id?: string;
  latest_plan_status?: SupervisorPlanRecord["status"];
  governed_work_ids: string[];
}

export interface SupervisorRecord {
  intent: SupervisorIntent;
  projection: SupervisorProjection;
  work: WorkRecord[];
  plans: SupervisorPlanRecord[];
}

export interface CreateSupervisorInput {
  coordRoot: string;
  rootWorkId: string;
  specialists: Readonly<Record<string, WorkflowSpecialistProfile>>;
  title?: string;
  id?: string;
  limits?: Partial<SupervisorLimits>;
  automation?: Partial<SupervisorAutomationPolicy>;
  replanning?: CreateSupervisorReplanningInput;
}

export function createSupervisor(input: CreateSupervisorInput): SupervisorRecord {
  const coordRoot = resolve(input.coordRoot);
  assertWorkId(input.rootWorkId);
  const root = readWorkItem(coordRoot, input.rootWorkId);
  const id = input.id ?? newSupervisorId();
  assertSupervisorId(id);
  const replanning = input.replanning
    ? normalizeReplanning(input.replanning, input.specialists)
    : undefined;
  const intent: SupervisorIntent = {
    schema_version: SUPERVISOR_INTENT_SCHEMA_VERSION,
    id,
    title: bounded(input.title ?? root.intent.title, "supervisor title", MAX_TITLE),
    root_work_id: input.rootWorkId,
    specialists: normalizeWorkflowSpecialists(input.specialists),
    limits: normalizeLimits(input.limits),
    automation: normalizeAutomation(input.automation),
    ...(replanning ? { replanning } : {}),
    created_at: new Date().toISOString(),
  };
  const path = supervisorIntentPath(coordRoot, id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writePrivateJson(path, intent);
  return readSupervisor(coordRoot, id);
}

export function readSupervisor(coordRoot: string, goalId: string): SupervisorRecord {
  return readSupervisorInternal(coordRoot, goalId, false);
}

/** @internal Runner seam; ignores the lease held by this supervisor process. */
export function readSupervisorIgnoringLease(coordRoot: string, goalId: string): SupervisorRecord {
  return readSupervisorInternal(coordRoot, goalId, true);
}

export function listSupervisors(coordRoot: string): SupervisorRecord[] {
  const base = join(resolve(coordRoot), ".harnery", "supervisors");
  if (!existsSync(base)) return [];
  const records: SupervisorRecord[] = [];
  for (const name of readdirSync(base)) {
    if (!GOAL_ID.test(name) || !existsSync(supervisorIntentPath(coordRoot, name))) continue;
    records.push(readSupervisor(coordRoot, name));
  }
  return records.sort((left, right) =>
    right.intent.created_at.localeCompare(left.intent.created_at),
  );
}

export function collectSupervisorWork(coordRoot: string, rootWorkId: string): WorkRecord[] {
  const records = new Map<string, WorkRecord>();
  const visiting = new Set<string>();
  const visit = (workId: string): void => {
    if (records.has(workId)) return;
    if (visiting.has(workId))
      throw new Error(`supervisor work graph contains a cycle at ${workId}`);
    visiting.add(workId);
    const record = readWorkItem(coordRoot, workId);
    for (const dependency of record.intent.dependencies) visit(dependency);
    visiting.delete(workId);
    records.set(workId, record);
  };
  visit(rootWorkId);
  return Array.from(records.values());
}

export function assertSupervisorId(goalId: string): void {
  if (!GOAL_ID.test(goalId)) throw new Error(`invalid supervisor id ${JSON.stringify(goalId)}`);
}

export function newSupervisorId(): string {
  return `goal-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
}

/** @internal Runner seam; one exclusive crash-recoverable supervisor lease. */
export function acquireSupervisorLease(coordRoot: string, goalId: string): () => void {
  readSupervisorIntent(coordRoot, goalId);
  const path = join(supervisorDir(coordRoot, goalId), "lease.json");
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
        `supervisor ${goalId} is already running under pid ${existing.pid} on ${existing.host}`,
      );
    }
    unlinkSync(path);
    if (!acquire()) throw new Error(`supervisor ${goalId} lease raced with another process`);
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

function readSupervisorInternal(
  coordRootRaw: string,
  goalId: string,
  ignoreLease: boolean,
): SupervisorRecord {
  const coordRoot = resolve(coordRootRaw);
  const intent = readSupervisorIntent(coordRoot, goalId);
  const plans = readSupervisorPlans(coordRoot, intent.id, intent.root_work_id);
  const work = collectSupervisorWork(coordRoot, plans.active_root_work_id);
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
  intent: SupervisorIntent,
  work: WorkRecord[],
  governed: WorkRecord[],
  plans: SupervisorPlanHistory,
  ignoreLease: boolean,
): SupervisorProjection {
  const root = work.find((record) => record.intent.id === plans.active_root_work_id);
  if (!root) throw new Error(`supervisor ${intent.id} root work is missing`);
  const attemptsUsed = governed.reduce((sum, record) => sum + record.projection.attempts_used, 0);
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
  const base = {
    id: intent.id,
    title: intent.title,
    root_work_id: plans.active_root_work_id,
    work_ids: work.map((record) => record.intent.id),
    ready_work: readyWork,
    resumable_work: resumableWork,
    retryable_work: retryableWork,
    attention_work: attentionWork,
    attempts_used: attemptsUsed,
    attempts_remaining: Math.max(0, intent.limits.max_total_attempts - attemptsUsed),
    specialists: Object.keys(intent.specialists),
    plan_generation: plans.generation,
    replans_used: plans.plans.length,
    replans_remaining: Math.max(0, (intent.replanning?.max_replans ?? 0) - plans.plans.length),
    pending_plan_id: plans.latest?.status === "proposed" ? plans.latest.request.id : undefined,
    latest_plan_status: plans.latest?.status,
    governed_work_ids: governed.map((record) => record.intent.id),
  };
  if (!ignoreLease && supervisorLeaseIsLive(coordRoot, intent.id)) {
    return {
      ...base,
      state: "running",
      reason: "the foreground supervisor holds the goal lease",
      next_action: "wait_for_run",
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
  const resumableDispatchable = intent.automation.resume_approved ? resumableWork : [];
  const attemptDispatchable = [
    ...readyWork,
    ...(intent.automation.retry_blocked ? retryableWork : []),
  ];
  const dispatchable = [...resumableDispatchable, ...attemptDispatchable];
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
  if (attemptsUsed >= intent.limits.max_total_attempts && attemptDispatchable.length > 0) {
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
  if (attemptsUsed >= intent.limits.max_total_attempts && cancelled.length === 0) {
    return {
      ...base,
      state: "budget_exhausted",
      reason: `goal exhausted its ${intent.limits.max_total_attempts} total attempts`,
      next_action: "none",
    };
  }
  const triggerFingerprint = supervisorGraphFingerprint({
    rootWorkId: plans.active_root_work_id,
    generation: plans.generation,
    work,
  });
  const latestHandledSameGraph =
    plans.latest?.request.trigger_fingerprint === triggerFingerprint &&
    plans.latest.request.prior_root_work_id === plans.active_root_work_id &&
    plans.latest.status === "attention";
  const canReplan =
    intent.replanning !== undefined &&
    plans.plans.length < intent.replanning.max_replans &&
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
    plans.plans.length >= intent.replanning.max_replans &&
    cancelled.length === 0
  ) {
    return {
      ...base,
      state: "budget_exhausted",
      reason: `goal exhausted its ${intent.replanning.max_replans} replans`,
      next_action: "none",
    };
  }
  if (latestHandledSameGraph && plans.latest) {
    return {
      ...base,
      state: "awaiting_attention",
      reason: plans.latest.reason ?? `plan ${plans.latest.request.id} requires attention`,
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

function readSupervisorIntent(coordRoot: string, goalId: string): SupervisorIntent {
  assertSupervisorId(goalId);
  const path = supervisorIntentPath(coordRoot, goalId);
  if (!existsSync(path)) throw new Error(`supervisor ${goalId} does not exist`);
  const size = statSync(path).size;
  if (size <= 0 || size > MAX_INTENT_BYTES) {
    throw new Error(`supervisor intent has invalid size ${size}`);
  }
  let intent: SupervisorIntent;
  try {
    intent = JSON.parse(readFileSync(path, "utf8")) as SupervisorIntent;
  } catch (error) {
    throw new Error(`cannot parse supervisor intent ${goalId}: ${(error as Error).message}`);
  }
  validateIntent(intent, goalId);
  return intent;
}

function validateIntent(intent: SupervisorIntent, goalId: string): void {
  if (
    intent.schema_version !== SUPERVISOR_INTENT_SCHEMA_VERSION ||
    intent.id !== goalId ||
    !validTimestamp(intent.created_at)
  ) {
    throw new Error(`supervisor intent ${goalId} has an unsupported or mismatched schema`);
  }
  bounded(intent.title, "supervisor title", MAX_TITLE);
  assertWorkId(intent.root_work_id);
  const specialists = normalizeWorkflowSpecialists(intent.specialists);
  if (JSON.stringify(specialists) !== JSON.stringify(intent.specialists)) {
    throw new Error(`supervisor intent ${goalId} specialists are not canonical`);
  }
  if (JSON.stringify(normalizeLimits(intent.limits)) !== JSON.stringify(intent.limits)) {
    throw new Error(`supervisor intent ${goalId} limits are not canonical`);
  }
  if (
    JSON.stringify(normalizeAutomation(intent.automation)) !== JSON.stringify(intent.automation)
  ) {
    throw new Error(`supervisor intent ${goalId} automation policy is not canonical`);
  }
  if (intent.replanning) validateReplanning(intent.replanning, specialists, goalId);
}

function normalizeLimits(input: Partial<SupervisorLimits> | undefined): SupervisorLimits {
  return {
    max_cycles: positive(input?.max_cycles ?? 50, "supervisor max_cycles", 1_000),
    max_runtime_ms: positive(
      input?.max_runtime_ms ?? 4 * 60 * 60 * 1_000,
      "supervisor max_runtime_ms",
      7 * 24 * 60 * 60 * 1_000,
    ),
    max_parallel_work: positive(input?.max_parallel_work ?? 1, "supervisor max_parallel_work", 20),
    max_total_attempts: positive(
      input?.max_total_attempts ?? 100,
      "supervisor max_total_attempts",
      10_000,
    ),
    max_agents_per_work: positive(
      input?.max_agents_per_work ?? 20,
      "supervisor max_agents_per_work",
      1_000,
    ),
    agent_concurrency: positive(input?.agent_concurrency ?? 4, "supervisor agent_concurrency", 100),
  };
}

function normalizeAutomation(
  input: Partial<SupervisorAutomationPolicy> | undefined,
): SupervisorAutomationPolicy {
  return {
    accept_passing_proof: boolean(input?.accept_passing_proof ?? false, "accept_passing_proof"),
    resume_approved: boolean(input?.resume_approved ?? true, "resume_approved"),
    retry_blocked: boolean(input?.retry_blocked ?? false, "retry_blocked"),
  };
}

function normalizeReplanning(
  input: CreateSupervisorReplanningInput,
  specialistsInput: Readonly<Record<string, WorkflowSpecialistProfile>>,
): SupervisorReplanningPolicy {
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
  return {
    planner_specialist: plannerSpecialist,
    auto_apply: boolean(input.autoApply ?? false, "replanning auto_apply"),
    max_replans: positive(input.maxReplans ?? 5, "replanning max_replans", 100),
    max_work_items_per_plan: maxWorkItemsPerPlan,
    max_total_work_items: maxTotalWorkItems,
    templates,
  };
}

function validateReplanning(
  policy: SupervisorReplanningPolicy,
  specialists: Record<string, WorkflowSpecialistProfile>,
  goalId: string,
): void {
  if (!specialists[policy.planner_specialist]) {
    throw new Error(`supervisor ${goalId} planner specialist is not in the frozen team`);
  }
  boolean(policy.auto_apply, "replanning auto_apply");
  positive(policy.max_replans, "replanning max_replans", 100);
  positive(policy.max_work_items_per_plan, "replanning max_work_items_per_plan", 25);
  positive(policy.max_total_work_items, "replanning max_total_work_items", 100);
  if (policy.max_work_items_per_plan > policy.max_total_work_items) {
    throw new Error(`supervisor ${goalId} replanning work-item bounds are inconsistent`);
  }
  const entries = Object.entries(policy.templates ?? {});
  if (entries.length < 1 || entries.length > MAX_TEMPLATES) {
    throw new Error(`supervisor ${goalId} has invalid replanning templates`);
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
      throw new Error(`supervisor ${goalId} replanning template ${id} is invalid`);
    }
    rootCapable ||= template.root;
  }
  if (!rootCapable) throw new Error(`supervisor ${goalId} has no root-capable replanning template`);
}

function collectGovernedWork(
  coordRoot: string,
  originalRootWorkId: string,
  plans: SupervisorPlanHistory,
  active: WorkRecord[],
): WorkRecord[] {
  const governed = new Map<string, WorkRecord>();
  for (const record of collectSupervisorWork(coordRoot, originalRootWorkId)) {
    governed.set(record.intent.id, record);
  }
  for (const workId of plans.applied_work_ids)
    governed.set(workId, readWorkItem(coordRoot, workId));
  for (const record of active) governed.set(record.intent.id, record);
  return [...governed.values()];
}

function supervisorDir(coordRoot: string, goalId: string): string {
  assertSupervisorId(goalId);
  return join(resolve(coordRoot), ".harnery", "supervisors", goalId);
}

function supervisorIntentPath(coordRoot: string, goalId: string): string {
  return join(supervisorDir(coordRoot, goalId), "intent.json");
}

function supervisorLeaseIsLive(coordRoot: string, goalId: string): boolean {
  const lease = readLease(join(supervisorDir(coordRoot, goalId), "lease.json"));
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
    throw new Error(`supervisor intent exceeds ${MAX_INTENT_BYTES} bytes`);
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

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`supervisor ${field} must be boolean`);
  return value;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
