import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createWorkItem, readWorkItem } from "../work/index.ts";
import {
  type EngineOpts,
  runWorkflow,
  WorkflowParkedError,
  workflowScriptDigest,
} from "../workflow/index.ts";
import { readSupervisorPlan, readSupervisorPlans } from "./plan-read.ts";
import {
  SUPERVISOR_PLAN_SCHEMA_VERSION,
  type SupervisorPlanEvent,
  type SupervisorPlanOutcome,
  type SupervisorPlanProposal,
  type SupervisorPlanRequest,
  type SupervisorPlanWorkSpec,
  supervisorGraphFingerprint,
} from "./plan-types.ts";
import type { SupervisorRecord } from "./state.ts";

const PLAN_KEY = /^[a-z][a-z0-9-]{0,31}$/;
const TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_EVENTS_BYTES = 512 * 1024;
const MAX_REASON = 2_000;

export interface RunSupervisorPlannerInput {
  coordRoot: string;
  record: SupervisorRecord;
  engine: Omit<EngineOpts, "coordRoot" | "runId" | "resumeRunId" | "specialists">;
  actor: string;
  onLog?: (line: string) => void;
}

export async function runSupervisorPlanner(
  input: RunSupervisorPlannerInput,
): Promise<SupervisorPlanOutcome> {
  const coordRoot = resolve(input.coordRoot);
  const policy = input.record.intent.replanning;
  if (!policy) throw new Error(`supervisor ${input.record.intent.id} does not allow replanning`);
  const history = readSupervisorPlans(
    coordRoot,
    input.record.intent.id,
    input.record.intent.root_work_id,
  );
  const triggerFingerprint = supervisorGraphFingerprint({
    rootWorkId: input.record.projection.root_work_id,
    generation: input.record.projection.plan_generation,
    work: input.record.work,
  });
  const resumable =
    history.latest?.status === "resumable" &&
    history.latest.request.trigger_fingerprint === triggerFingerprint &&
    history.latest.request.prior_root_work_id === input.record.projection.root_work_id
      ? history.latest
      : undefined;
  const request = resumable
    ? resumable.request
    : createPlanRequest(coordRoot, input.record, history.plans.length + 1, triggerFingerprint);
  const scriptPath = planScriptPath(coordRoot, input.record.intent.id, request.id);
  if (resumable) {
    appendPlanEvent(coordRoot, input.record.intent.id, request.id, {
      event: "plan.resumed",
      actor: input.actor,
      reason: `resuming planner workflow after approval ${resumable.approval_id}`,
      approval_id: resumable.approval_id,
    });
  }
  let proposalWritten = false;
  try {
    const report = await runWorkflow(scriptPath, {
      ...input.engine,
      coordRoot,
      ...(resumable
        ? { resumeRunId: request.workflow_run_id }
        : { runId: request.workflow_run_id }),
      specialists: input.record.intent.specialists,
      maxAgents: 1,
      concurrency: 1,
      onLog: input.onLog,
    });
    const proposal = normalizeProposal(
      request.id,
      report.result,
      input.record,
      history.materialized_work_ids.length,
    );
    writeExclusiveJson(
      planProposalPath(coordRoot, input.record.intent.id, request.id),
      proposal,
      "supervisor plan proposal",
    );
    appendPlanEvent(coordRoot, input.record.intent.id, request.id, {
      event: "plan.proposed",
      actor: input.actor,
      reason: proposal.rationale,
    });
    proposalWritten = true;
    if (proposal.decision === "attention") {
      appendPlanEvent(coordRoot, input.record.intent.id, request.id, {
        event: "plan.attention",
        actor: input.actor,
        reason: proposal.rationale,
      });
      return outcome(readSupervisorPlan(coordRoot, input.record.intent.id, request.id));
    }
    if (policy.auto_apply) {
      return applySupervisorPlanProposal({
        coordRoot,
        record: input.record,
        planId: request.id,
        actor: input.actor,
        reason: "proposal applied by frozen supervisor replanning policy",
      });
    }
    return outcome(readSupervisorPlan(coordRoot, input.record.intent.id, request.id));
  } catch (error) {
    if (proposalWritten) throw error;
    if (error instanceof WorkflowParkedError) {
      appendPlanEvent(coordRoot, input.record.intent.id, request.id, {
        event: "plan.awaiting_approval",
        actor: input.actor,
        reason: `planner workflow parked for approval ${error.approvalId}`,
        approval_id: error.approvalId,
      });
      return outcome(readSupervisorPlan(coordRoot, input.record.intent.id, request.id));
    }
    appendPlanEvent(coordRoot, input.record.intent.id, request.id, {
      event: "plan.failed",
      actor: input.actor,
      reason: bounded((error as Error).message, "plan failure", MAX_REASON),
    });
    throw error;
  }
}

export function applySupervisorPlanProposal(input: {
  coordRoot: string;
  record: SupervisorRecord;
  planId: string;
  actor: string;
  reason?: string;
}): SupervisorPlanOutcome {
  const coordRoot = resolve(input.coordRoot);
  const policy = input.record.intent.replanning;
  if (!policy) throw new Error(`supervisor ${input.record.intent.id} does not allow replanning`);
  const plan = readSupervisorPlan(coordRoot, input.record.intent.id, input.planId);
  if (plan.status === "applied") return outcome(plan);
  if (plan.status !== "proposed" || !plan.proposal || plan.proposal.decision !== "apply") {
    throw new Error(`supervisor plan ${input.planId} cannot be applied from ${plan.status}`);
  }
  if (plan.request.prior_root_work_id !== input.record.projection.root_work_id) {
    throw new Error(
      `supervisor plan ${input.planId} targets stale root ${plan.request.prior_root_work_id}`,
    );
  }
  const history = readSupervisorPlans(
    coordRoot,
    input.record.intent.id,
    input.record.intent.root_work_id,
  );
  const proposal = normalizeProposal(
    input.planId,
    plan.proposal,
    input.record,
    history.materialized_work_ids.filter((workId) => !workId.startsWith(`${input.planId}-`)).length,
  );
  const ids = new Map<string, string>();
  const created: string[] = [];
  for (const spec of proposal.work) {
    const template = policy.templates[spec.template];
    if (!template)
      throw new Error(`plan work ${spec.key} references unknown template ${spec.template}`);
    if (workflowScriptDigest(template.workflow.path) !== template.workflow.sha256) {
      throw new Error(`replanning template ${spec.template} changed after goal creation`);
    }
    const workId = `${input.planId}-${spec.key}`;
    const dependencies = spec.dependencies.map((dependency) => ids.get(dependency) ?? dependency);
    const expected = {
      title: spec.title,
      objective: spec.objective,
      acceptance: spec.acceptance,
      dependencies,
      workflow: template.workflow,
      max_attempts: template.max_attempts,
      source: {
        kind: "workflow" as const,
        ref: `supervisor:${input.record.intent.id}/plan:${input.planId}`,
      },
    };
    if (existsSync(join(coordRoot, ".harnery", "work", workId, "intent.json"))) {
      const current = readWorkItem(coordRoot, workId).intent;
      const actual = {
        title: current.title,
        objective: current.objective,
        acceptance: current.acceptance,
        dependencies: current.dependencies,
        workflow: current.workflow,
        max_attempts: current.max_attempts,
        source: current.source,
      };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`partial plan work ${workId} conflicts with the durable proposal`);
      }
    } else {
      createWorkItem({
        coordRoot,
        id: workId,
        title: spec.title,
        objective: spec.objective,
        acceptance: spec.acceptance,
        dependencies,
        workflowPath: template.workflow.path,
        maxAttempts: template.max_attempts,
        source: expected.source,
        actor: input.actor,
      });
    }
    ids.set(spec.key, workId);
    created.push(workId);
  }
  const rootWorkId = ids.get(proposal.root);
  if (!rootWorkId) throw new Error(`plan root ${proposal.root} was not materialized`);
  appendPlanEvent(coordRoot, input.record.intent.id, input.planId, {
    event: "plan.applied",
    actor: input.actor,
    reason: input.reason ?? "supervisor plan explicitly approved",
    root_work_id: rootWorkId,
    work_ids: created,
  });
  return outcome(readSupervisorPlan(coordRoot, input.record.intent.id, input.planId));
}

export function rejectSupervisorPlanProposal(input: {
  coordRoot: string;
  goalId: string;
  planId: string;
  actor: string;
  reason: string;
}): SupervisorPlanOutcome {
  const plan = readSupervisorPlan(input.coordRoot, input.goalId, input.planId);
  if (plan.status === "rejected") return outcome(plan);
  if (plan.status !== "proposed") {
    throw new Error(`supervisor plan ${input.planId} cannot be rejected from ${plan.status}`);
  }
  appendPlanEvent(input.coordRoot, input.goalId, input.planId, {
    event: "plan.rejected",
    actor: input.actor,
    reason: input.reason,
  });
  return outcome(readSupervisorPlan(input.coordRoot, input.goalId, input.planId));
}

function createPlanRequest(
  coordRoot: string,
  record: SupervisorRecord,
  sequence: number,
  triggerFingerprint: string,
): SupervisorPlanRequest {
  const policy = record.intent.replanning;
  if (!policy) throw new Error(`supervisor ${record.intent.id} does not allow replanning`);
  if (sequence > policy.max_replans) {
    throw new Error(`supervisor ${record.intent.id} exhausted its ${policy.max_replans} replans`);
  }
  const planId = `plan-${String(sequence).padStart(4, "0")}-${randomBytes(4).toString("hex")}`;
  const request: SupervisorPlanRequest = {
    schema_version: SUPERVISOR_PLAN_SCHEMA_VERSION,
    id: planId,
    goal_id: record.intent.id,
    sequence,
    trigger_fingerprint: triggerFingerprint,
    prior_root_work_id: record.projection.root_work_id,
    workflow_run_id: `${planId}-workflow`,
    created_at: new Date().toISOString(),
  };
  const dir = planDir(coordRoot, record.intent.id, planId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeExclusiveJson(join(dir, "request.json"), request, "supervisor plan request");
  const script = plannerScript(record, planId);
  writeExclusive(join(dir, "planner.mjs"), script, "supervisor planner script");
  return request;
}

function plannerScript(record: SupervisorRecord, planId: string): string {
  const policy = record.intent.replanning;
  if (!policy) throw new Error(`supervisor ${record.intent.id} does not allow replanning`);
  const prompt = [
    "You are producing a bounded replacement plan for a durable supervised goal.",
    "The current graph is blocked and cannot make a legal scheduling step.",
    "Return decision=apply with a new immutable root graph, or decision=attention when human judgment is required.",
    "Never claim work is complete. Never request a workflow outside the frozen template catalog.",
    "Dependencies may name an active work ID or an earlier key in your proposed work array.",
    "Every proposed item must be reachable from root. The root must be a proposed key using a root-capable template.",
    `Plan id: ${planId}`,
    `Goal: ${record.intent.title}`,
    `Original root: ${record.intent.root_work_id}`,
    `Active root: ${record.projection.root_work_id}`,
    `Remaining work attempts: ${record.projection.attempts_remaining}`,
    `Remaining replans: ${record.projection.replans_remaining}`,
    `Latest planner outcome: ${JSON.stringify(
      record.plans.at(-1)
        ? {
            status: record.plans.at(-1)?.status,
            reason: record.plans.at(-1)?.reason,
          }
        : null,
    )}`,
    `Templates: ${JSON.stringify(policy.templates)}`,
    `Active work: ${JSON.stringify(
      record.work.map((work) => ({
        id: work.intent.id,
        title: work.intent.title,
        objective: work.intent.objective,
        acceptance: work.intent.acceptance,
        dependencies: work.intent.dependencies,
        state: work.projection.state,
        reason: work.projection.reason,
      })),
    )}`,
  ].join("\n\n");
  const schema = {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["apply", "attention"] },
      rationale: { type: "string" },
      root: { type: "string" },
      work: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            title: { type: "string" },
            objective: { type: "string" },
            acceptance: { type: "array", items: { type: "string" } },
            dependencies: { type: "array", items: { type: "string" } },
            template: { type: "string" },
          },
          required: ["key", "title", "objective", "acceptance", "dependencies", "template"],
        },
      },
    },
    required: ["decision", "rationale", "root", "work"],
  };
  return [
    `export const meta = ${JSON.stringify({ name: `replan-${planId}` })};`,
    "export default async ({ agent, stage }) => {",
    '  stage("Replan blocked goal");',
    `  return await agent(${JSON.stringify(prompt)}, ${JSON.stringify({
      specialist: policy.planner_specialist,
      schema,
      label: "Produce bounded replacement plan",
    })});`,
    "};",
    "",
  ].join("\n");
}

function normalizeProposal(
  planId: string,
  raw: unknown,
  record: SupervisorRecord,
  previouslyApplied: number,
): SupervisorPlanProposal {
  const policy = record.intent.replanning;
  if (!policy) throw new Error(`supervisor ${record.intent.id} does not allow replanning`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("planner result must be an object");
  }
  const value = raw as Record<string, unknown>;
  const decision = enumValue(value.decision, ["apply", "attention"], "plan decision");
  const rationale = bounded(value.rationale, "plan rationale", MAX_REASON);
  const root = typeof value.root === "string" ? value.root.trim() : "";
  if (!Array.isArray(value.work)) throw new Error("plan work must be an array");
  if (decision === "attention") {
    if (root || value.work.length > 0) throw new Error("attention plan must not contain work");
    return {
      schema_version: SUPERVISOR_PLAN_SCHEMA_VERSION,
      plan_id: planId,
      decision,
      rationale,
      root: "",
      work: [],
      proposed_at: new Date().toISOString(),
    };
  }
  if (value.work.length < 1 || value.work.length > policy.max_work_items_per_plan) {
    throw new Error(`plan work must contain 1 to ${policy.max_work_items_per_plan} items`);
  }
  if (previouslyApplied + value.work.length > policy.max_total_work_items) {
    throw new Error(`plan would exceed ${policy.max_total_work_items} total planned work items`);
  }
  const active = new Set(record.projection.work_ids);
  const seen = new Set<string>();
  const work = value.work.map((candidate, index): SupervisorPlanWorkSpec => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`plan work[${index}] must be an object`);
    }
    const item = candidate as Record<string, unknown>;
    const key = bounded(item.key, `plan work[${index}].key`, 32);
    if (!PLAN_KEY.test(key) || seen.has(key))
      throw new Error(`invalid or duplicate plan key ${key}`);
    const template = bounded(item.template, `plan work[${index}].template`, 64);
    if (!TEMPLATE_ID.test(template) || !policy.templates[template]) {
      throw new Error(`plan work ${key} references unknown template ${template}`);
    }
    if (!Array.isArray(item.dependencies))
      throw new Error(`plan work ${key} dependencies must be an array`);
    const dependencies = [
      ...new Set(
        item.dependencies.map((dependency, dependencyIndex) =>
          bounded(dependency, `plan work ${key} dependency[${dependencyIndex}]`, 100),
        ),
      ),
    ];
    if (dependencies.length > 50) throw new Error(`plan work ${key} exceeds 50 dependencies`);
    for (const dependency of dependencies) {
      if (!active.has(dependency) && !seen.has(dependency)) {
        throw new Error(
          `plan work ${key} dependency ${dependency} is not active or earlier in the plan`,
        );
      }
    }
    if (!Array.isArray(item.acceptance))
      throw new Error(`plan work ${key} acceptance must be an array`);
    const acceptance = item.acceptance.map((criterion, criterionIndex) =>
      bounded(criterion, `plan work ${key} acceptance[${criterionIndex}]`, 500),
    );
    if (acceptance.length > 50) throw new Error(`plan work ${key} exceeds 50 acceptance criteria`);
    seen.add(key);
    return {
      key,
      title: bounded(item.title, `plan work ${key} title`, 200),
      objective: bounded(item.objective, `plan work ${key} objective`, 4_000),
      acceptance,
      dependencies,
      template,
    };
  });
  if (!seen.has(root)) throw new Error(`plan root ${root || "(empty)"} is not a proposed key`);
  const rootSpec = work.find((item) => item.key === root);
  if (!rootSpec || !policy.templates[rootSpec.template]?.root) {
    throw new Error(`plan root ${root} must use a root-capable template`);
  }
  const reachable = new Set<string>();
  const byKey = new Map(work.map((item) => [item.key, item]));
  const visit = (key: string): void => {
    if (reachable.has(key)) return;
    reachable.add(key);
    for (const dependency of byKey.get(key)?.dependencies ?? []) {
      if (byKey.has(dependency)) visit(dependency);
    }
  };
  visit(root);
  const unused = work.filter((item) => !reachable.has(item.key));
  if (unused.length)
    throw new Error(
      `plan contains work not reachable from root: ${unused.map((item) => item.key).join(", ")}`,
    );
  return {
    schema_version: SUPERVISOR_PLAN_SCHEMA_VERSION,
    plan_id: planId,
    decision,
    rationale,
    root,
    work,
    proposed_at: new Date().toISOString(),
  };
}

function appendPlanEvent(
  coordRootRaw: string,
  goalId: string,
  planId: string,
  input: Omit<SupervisorPlanEvent, "schema_version" | "plan_id" | "seq" | "ts">,
): void {
  const coordRoot = resolve(coordRootRaw);
  const path = join(planDir(coordRoot, goalId, planId), "events.jsonl");
  const current = readSupervisorPlan(coordRoot, goalId, planId).events;
  const event: SupervisorPlanEvent = {
    schema_version: SUPERVISOR_PLAN_SCHEMA_VERSION,
    plan_id: planId,
    seq: current.length + 1,
    ts: new Date().toISOString(),
    ...input,
    actor: bounded(input.actor, "plan actor", 200),
    reason: bounded(input.reason, "plan reason", MAX_REASON),
  };
  const line = `${JSON.stringify(event)}\n`;
  const existing = existsSync(path) ? statSync(path).size : 0;
  if (existing + Buffer.byteLength(line) > MAX_EVENTS_BYTES) {
    throw new Error("supervisor plan event log would exceed its byte limit");
  }
  appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function outcome(plan: ReturnType<typeof readSupervisorPlan>): SupervisorPlanOutcome {
  return {
    plan_id: plan.request.id,
    status: plan.status,
    workflow_run_id: plan.request.workflow_run_id,
    reason: plan.reason,
    root_work_id: plan.root_work_id,
    work_ids: plan.work_ids,
  };
}

function writeExclusiveJson(path: string, value: unknown, label: string): void {
  writeExclusive(path, `${JSON.stringify(value, null, 2)}\n`, label);
}

function writeExclusive(path: string, body: string, label: string): void {
  if (Buffer.byteLength(body) > MAX_RECORD_BYTES) {
    throw new Error(`${label} exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readFileSync(path, "utf8");
      if (existing !== body) throw new Error(`${label} already exists with different content`);
    }
    chmodSync(path, 0o600);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary may already be absent after a failed exclusive write.
    }
  }
}

function planDir(coordRoot: string, goalId: string, planId: string): string {
  return join(coordRoot, ".harnery", "supervisors", goalId, "plans", planId);
}

function planScriptPath(coordRoot: string, goalId: string, planId: string): string {
  return join(planDir(coordRoot, goalId, planId), "planner.mjs");
}

function planProposalPath(coordRoot: string, goalId: string, planId: string): string {
  return join(planDir(coordRoot, goalId, planId), "proposal.json");
}

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${field} must be one of ${values.join(", ")}`);
  }
  return value as T;
}
