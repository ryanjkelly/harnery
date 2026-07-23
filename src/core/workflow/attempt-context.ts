import type {
  AcceptanceSummary,
  WorkflowAttemptContext,
  WorkflowAttemptFailureCause,
  WorkflowAttemptPriorContext,
  WorkflowAttemptUnresolvedCriterion,
} from "./types.ts";
import { WORKFLOW_ATTEMPT_CONTEXT_SCHEMA_VERSION } from "./types.ts";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ACCEPTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ATTEMPTS = 100;
const MAX_ERROR = 2_000;
const MAX_CRITERIA = 50;
const MAX_STATEMENT = 500;
const CONTEXT_FIELDS = new Set(["schema_version", "number", "trigger", "prior"]);
const PRIOR_FIELDS = new Set(["run_id", "causes", "error", "acceptance", "unresolved"]);
const SUMMARY_FIELDS = new Set(["satisfied", "unsatisfied", "unknown", "total"]);
const CRITERION_FIELDS = new Set(["id", "statement", "status"]);
const CAUSE_ORDER: readonly WorkflowAttemptFailureCause[] = [
  "workflow_error",
  "acceptance_unsatisfied",
  "acceptance_unknown",
  "lost",
];

export function normalizeWorkflowAttemptContext(value: unknown): WorkflowAttemptContext {
  const input = objectValue(value, "workflow attempt context");
  rejectExtraFields(input, CONTEXT_FIELDS, "workflow attempt context");
  if (input.schema_version !== WORKFLOW_ATTEMPT_CONTEXT_SCHEMA_VERSION) {
    throw new Error("workflow attempt context has an unsupported schema");
  }
  const number = safeInteger(input.number, "workflow attempt context number", 1, MAX_ATTEMPTS);
  if (input.trigger !== "initial" && input.trigger !== "retry") {
    throw new Error('workflow attempt context trigger must be "initial" or "retry"');
  }
  if (input.trigger === "initial") {
    if (input.prior !== undefined) {
      throw new Error("initial workflow attempt context cannot contain prior evidence");
    }
    return {
      schema_version: WORKFLOW_ATTEMPT_CONTEXT_SCHEMA_VERSION,
      number,
      trigger: "initial",
    };
  }
  if (number < 2) throw new Error("retry workflow attempt context number must be at least 2");
  if (input.prior === undefined) {
    throw new Error("retry workflow attempt context requires prior evidence");
  }
  return {
    schema_version: WORKFLOW_ATTEMPT_CONTEXT_SCHEMA_VERSION,
    number,
    trigger: "retry",
    prior: normalizePrior(input.prior),
  };
}

export function freezeWorkflowAttemptContext(value: unknown): Readonly<WorkflowAttemptContext> {
  const normalized = normalizeWorkflowAttemptContext(value);
  if (normalized.prior) {
    for (const criterion of normalized.prior.unresolved) Object.freeze(criterion);
    Object.freeze(normalized.prior.causes);
    Object.freeze(normalized.prior.acceptance);
    Object.freeze(normalized.prior.unresolved);
    Object.freeze(normalized.prior);
  }
  return Object.freeze(normalized);
}

export function isCanonicalWorkflowAttemptContext(value: unknown): value is WorkflowAttemptContext {
  try {
    const normalized = normalizeWorkflowAttemptContext(value);
    return JSON.stringify(normalized) === JSON.stringify(value);
  } catch {
    return false;
  }
}

function normalizePrior(value: unknown): WorkflowAttemptPriorContext {
  const input = objectValue(value, "workflow attempt prior context");
  rejectExtraFields(input, PRIOR_FIELDS, "workflow attempt prior context");
  const runId = requiredString(input.run_id, "workflow attempt prior run id", 200);
  if (!RUN_ID.test(runId)) {
    throw new Error(`invalid workflow attempt prior run id ${JSON.stringify(runId)}`);
  }
  if (!Array.isArray(input.causes) || input.causes.length === 0) {
    throw new Error("workflow attempt prior causes must be a non-empty array");
  }
  const seen = new Set<WorkflowAttemptFailureCause>();
  for (const cause of input.causes) {
    if (!CAUSE_ORDER.includes(cause as WorkflowAttemptFailureCause)) {
      throw new Error(`unsupported workflow attempt failure cause ${JSON.stringify(cause)}`);
    }
    if (seen.has(cause as WorkflowAttemptFailureCause)) {
      throw new Error(`duplicate workflow attempt failure cause ${JSON.stringify(cause)}`);
    }
    seen.add(cause as WorkflowAttemptFailureCause);
  }
  const causes = CAUSE_ORDER.filter((cause) => seen.has(cause));
  if (causes.includes("lost")) {
    if (causes.length !== 1)
      throw new Error("lost must be the only workflow attempt failure cause");
    if (input.error !== undefined || input.acceptance !== undefined) {
      throw new Error("lost workflow attempt evidence cannot contain proof-derived fields");
    }
    const unresolved = normalizeUnresolved(input.unresolved);
    if (unresolved.length > 0) {
      throw new Error("lost workflow attempt evidence cannot contain unresolved criteria");
    }
    return { run_id: runId, causes, unresolved };
  }

  const acceptance = normalizeAcceptanceSummary(input.acceptance);
  const unresolved = normalizeUnresolved(input.unresolved);
  const unsatisfied = unresolved.filter((criterion) => criterion.status === "unsatisfied").length;
  const unknown = unresolved.filter((criterion) => criterion.status === "unknown").length;
  if (
    unsatisfied !== acceptance.unsatisfied ||
    unknown !== acceptance.unknown ||
    causes.includes("acceptance_unsatisfied") !== acceptance.unsatisfied > 0 ||
    causes.includes("acceptance_unknown") !== acceptance.unknown > 0
  ) {
    throw new Error("workflow attempt failure evidence does not match acceptance");
  }
  if (!causes.includes("workflow_error") && acceptance.unsatisfied + acceptance.unknown === 0) {
    throw new Error("workflow attempt prior context does not describe a failure");
  }
  const error =
    input.error === undefined
      ? undefined
      : requiredString(input.error, "workflow attempt prior error", MAX_ERROR);
  return {
    run_id: runId,
    causes,
    ...(error === undefined ? {} : { error }),
    acceptance,
    unresolved,
  };
}

function normalizeAcceptanceSummary(value: unknown): AcceptanceSummary {
  const input = objectValue(value, "workflow attempt acceptance summary");
  rejectExtraFields(input, SUMMARY_FIELDS, "workflow attempt acceptance summary");
  const satisfied = safeInteger(input.satisfied, "acceptance satisfied", 0, MAX_CRITERIA);
  const unsatisfied = safeInteger(input.unsatisfied, "acceptance unsatisfied", 0, MAX_CRITERIA);
  const unknown = safeInteger(input.unknown, "acceptance unknown", 0, MAX_CRITERIA);
  const total = safeInteger(input.total, "acceptance total", 0, MAX_CRITERIA);
  if (satisfied + unsatisfied + unknown !== total) {
    throw new Error("workflow attempt acceptance summary total does not match its counts");
  }
  return { satisfied, unsatisfied, unknown, total };
}

function normalizeUnresolved(value: unknown): WorkflowAttemptUnresolvedCriterion[] {
  if (!Array.isArray(value) || value.length > MAX_CRITERIA) {
    throw new Error(
      `workflow attempt unresolved criteria must contain at most ${MAX_CRITERIA} entries`,
    );
  }
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    const input = objectValue(candidate, `workflow attempt unresolved[${index}]`);
    rejectExtraFields(input, CRITERION_FIELDS, `workflow attempt unresolved[${index}]`);
    const id = requiredString(input.id, `workflow attempt unresolved[${index}].id`, 64);
    if (!ACCEPTANCE_ID.test(id)) {
      throw new Error(`invalid workflow attempt acceptance id ${JSON.stringify(id)}`);
    }
    if (ids.has(id))
      throw new Error(`duplicate workflow attempt acceptance id ${JSON.stringify(id)}`);
    ids.add(id);
    if (input.status !== "unsatisfied" && input.status !== "unknown") {
      throw new Error(`workflow attempt unresolved[${index}].status is invalid`);
    }
    return {
      id,
      statement: requiredString(
        input.statement,
        `workflow attempt unresolved[${index}].statement`,
        MAX_STATEMENT,
      ),
      status: input.status,
    };
  });
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectExtraFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) throw new Error(`${field} has unknown field ${JSON.stringify(extra)}`);
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function safeInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}
