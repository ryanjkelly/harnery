import type { WorkflowWorkContext } from "./types.ts";
import { WORKFLOW_WORK_CONTEXT_SCHEMA_VERSION } from "./types.ts";

const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_TITLE = 200;
const MAX_OBJECTIVE = 4_000;
const MAX_ACCEPTANCE = 50;
const MAX_ACCEPTANCE_ITEM = 500;
const FIELDS = new Set(["schema_version", "id", "title", "objective", "acceptance"]);

export function normalizeWorkflowWorkContext(value: unknown): WorkflowWorkContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workflow work context must be an object");
  }
  const input = value as Record<string, unknown>;
  const extra = Object.keys(input).filter((key) => !FIELDS.has(key));
  if (extra.length > 0) {
    throw new Error(`workflow work context has unknown field ${JSON.stringify(extra[0])}`);
  }
  if (input.schema_version !== WORKFLOW_WORK_CONTEXT_SCHEMA_VERSION) {
    throw new Error("workflow work context has an unsupported schema");
  }
  const id = requiredString(input.id, "workflow work context id", 100);
  if (!WORK_ID.test(id)) {
    throw new Error(`invalid workflow work context id ${JSON.stringify(id)}`);
  }
  if (!Array.isArray(input.acceptance) || input.acceptance.length > MAX_ACCEPTANCE) {
    throw new Error(
      `workflow work context acceptance must contain at most ${MAX_ACCEPTANCE} criteria`,
    );
  }
  const acceptance = input.acceptance.map((criterion, index) =>
    requiredString(criterion, `workflow work context acceptance[${index}]`, MAX_ACCEPTANCE_ITEM),
  );
  return {
    schema_version: WORKFLOW_WORK_CONTEXT_SCHEMA_VERSION,
    id,
    title: requiredString(input.title, "workflow work context title", MAX_TITLE),
    objective: requiredString(input.objective, "workflow work context objective", MAX_OBJECTIVE),
    acceptance,
  };
}

export function freezeWorkflowWorkContext(value: unknown): Readonly<WorkflowWorkContext> {
  const normalized = normalizeWorkflowWorkContext(value);
  Object.freeze(normalized.acceptance);
  return Object.freeze(normalized);
}

export function isCanonicalWorkflowWorkContext(value: unknown): value is WorkflowWorkContext {
  try {
    const normalized = normalizeWorkflowWorkContext(value);
    return JSON.stringify(normalized) === JSON.stringify(value);
  } catch {
    return false;
  }
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}
