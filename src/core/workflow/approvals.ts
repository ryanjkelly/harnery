import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { PolicyEvaluation, PolicyRequestSummary, PolicyVerdict } from "../policy/index.ts";

export const WORKFLOW_APPROVAL_SCHEMA_VERSION = 1 as const;

const RECORD_LIMIT_BYTES = 128 * 1024;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const APPROVAL_ID = /^apr-[a-f0-9]{20}$/;
const DECISION_ID = /^p[1-9][0-9]{0,4}$/;
const MAX_ACTOR = 200;
const MAX_REASON = 2_000;
const MAX_ADDRESSEE = 200;

export type WorkflowApprovalStatus = "pending" | "approved" | "denied";

export interface WorkflowApprovalRequest {
  schema_version: typeof WORKFLOW_APPROVAL_SCHEMA_VERSION;
  id: string;
  run_id: string;
  decision_id: string;
  requested_at: string;
  addressed_to: string;
  policy: { name: string; sha256: string };
  initial_verdict: Extract<PolicyVerdict, "ask">;
  request: PolicyRequestSummary;
  evaluation: PolicyEvaluation;
  request_sha256: string;
}

export interface WorkflowApprovalDecision {
  schema_version: typeof WORKFLOW_APPROVAL_SCHEMA_VERSION;
  approval_id: string;
  run_id: string;
  verdict: "allow" | "deny";
  actor: string;
  reason?: string;
  decided_at: string;
}

export interface WorkflowApproval {
  request: WorkflowApprovalRequest;
  decision?: WorkflowApprovalDecision;
  status: WorkflowApprovalStatus;
}

export interface CreateWorkflowApprovalInput {
  coordRoot: string;
  runId: string;
  decisionId: string;
  addressedTo?: string;
  policy: { name: string; sha256: string };
  request: PolicyRequestSummary;
  evaluation: PolicyEvaluation;
  now?: () => string;
}

export interface ResolveWorkflowApprovalInput {
  coordRoot: string;
  approvalId: string;
  verdict: "allow" | "deny";
  actor: string;
  reason?: string;
  now?: () => string;
}

export function workflowApprovalId(runId: string, decisionId: string): string {
  assertRunId(runId);
  if (!DECISION_ID.test(decisionId)) {
    throw new Error(`invalid workflow policy decision id ${JSON.stringify(decisionId)}`);
  }
  return `apr-${createHash("sha256").update(`${runId}\0${decisionId}`).digest("hex").slice(0, 20)}`;
}

export function createWorkflowApproval(input: CreateWorkflowApprovalInput): {
  approval: WorkflowApproval;
  created: boolean;
} {
  const id = workflowApprovalId(input.runId, input.decisionId);
  const addressedTo = bounded(input.addressedTo ?? "operator", "approval addressee", MAX_ADDRESSEE);
  const requestSha256 = approvalRequestDigest(input.policy.sha256, input.request, input.evaluation);
  const record: WorkflowApprovalRequest = {
    schema_version: WORKFLOW_APPROVAL_SCHEMA_VERSION,
    id,
    run_id: input.runId,
    decision_id: input.decisionId,
    requested_at: (input.now ?? (() => new Date().toISOString()))(),
    addressed_to: addressedTo,
    policy: {
      name: bounded(input.policy.name, "approval policy name", MAX_ACTOR),
      sha256: sha256(input.policy.sha256, "approval policy sha256"),
    },
    initial_verdict: "ask",
    request: input.request,
    evaluation: input.evaluation,
    request_sha256: requestSha256,
  };
  const dir = approvalDir(input.coordRoot, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const created = writeExclusiveJson(join(dir, "request.json"), record);
  const approval = readWorkflowApproval(input.coordRoot, id);
  if (
    approval.request.run_id !== record.run_id ||
    approval.request.decision_id !== record.decision_id ||
    approval.request.request_sha256 !== record.request_sha256 ||
    approval.request.policy.sha256 !== record.policy.sha256
  ) {
    throw new Error(`approval ${id} already exists for a different policy request`);
  }
  return { approval, created };
}

export function resolveWorkflowApproval(input: ResolveWorkflowApprovalInput): {
  approval: WorkflowApproval;
  applied: boolean;
} {
  const approval = readWorkflowApproval(input.coordRoot, input.approvalId);
  const decision: WorkflowApprovalDecision = {
    schema_version: WORKFLOW_APPROVAL_SCHEMA_VERSION,
    approval_id: approval.request.id,
    run_id: approval.request.run_id,
    verdict: input.verdict,
    actor: bounded(input.actor, "approval actor", MAX_ACTOR),
    reason:
      input.reason === undefined ? undefined : bounded(input.reason, "approval reason", MAX_REASON),
    decided_at: (input.now ?? (() => new Date().toISOString()))(),
  };
  const applied = writeExclusiveJson(
    join(approvalDir(input.coordRoot, input.approvalId), "decision.json"),
    decision,
  );
  const resolved = readWorkflowApproval(input.coordRoot, input.approvalId);
  if (resolved.decision?.verdict !== input.verdict) {
    throw new Error(
      `approval ${input.approvalId} is already ${resolved.status}; conflicting ${input.verdict === "allow" ? "approval" : "denial"} refused`,
    );
  }
  if (applied) appendResolutionJournal(input.coordRoot, resolved);
  return { approval: resolved, applied };
}

export function readWorkflowApproval(coordRoot: string, approvalId: string): WorkflowApproval {
  assertApprovalId(approvalId);
  const dir = approvalDir(coordRoot, approvalId);
  const request = readJsonRecord<WorkflowApprovalRequest>(join(dir, "request.json"));
  validateRequest(request, approvalId);
  const decisionPath = join(dir, "decision.json");
  const decision = existsSync(decisionPath)
    ? readJsonRecord<WorkflowApprovalDecision>(decisionPath)
    : undefined;
  if (decision) validateDecision(decision, request);
  return {
    request,
    decision,
    status: decision?.verdict === "allow" ? "approved" : decision ? "denied" : "pending",
  };
}

export function listWorkflowApprovals(
  coordRoot: string,
  options: { status?: WorkflowApprovalStatus; runId?: string } = {},
): WorkflowApproval[] {
  if (options.runId) assertRunId(options.runId);
  const root = approvalsRoot(coordRoot);
  if (!existsSync(root)) return [];
  const records: WorkflowApproval[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !APPROVAL_ID.test(entry.name)) continue;
    try {
      const approval = readWorkflowApproval(coordRoot, entry.name);
      if (options.status && approval.status !== options.status) continue;
      if (options.runId && approval.request.run_id !== options.runId) continue;
      records.push(approval);
    } catch {
      // A malformed record fails closed when addressed directly, but one bad
      // directory must not hide the rest of the operator's inbox.
    }
  }
  return records.sort((a, b) => b.request.requested_at.localeCompare(a.request.requested_at));
}

export function renderWorkflowApproval(approval: WorkflowApproval): string {
  const lines = [
    `${approval.request.id}: ${approval.status}`,
    `run: ${approval.request.run_id}`,
    `addressed to: ${approval.request.addressed_to}`,
    `requested: ${approval.request.requested_at}`,
    `policy: ${approval.request.policy.name}`,
    `phase: ${approval.request.request.phase}`,
    `action: ${approval.request.request.action}`,
    `reason: ${approval.request.evaluation.reason}`,
  ];
  if (approval.decision) {
    lines.push(`decided: ${approval.decision.decided_at} by ${approval.decision.actor}`);
    if (approval.decision.reason) lines.push(`decision reason: ${approval.decision.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

export function assertWorkflowRunId(runId: string): void {
  assertRunId(runId);
}

function appendResolutionJournal(coordRoot: string, approval: WorkflowApproval): void {
  const journalPath = join(
    coordRoot,
    ".harnery",
    "workflows",
    approval.request.run_id,
    "journal.jsonl",
  );
  if (!existsSync(journalPath) || !approval.decision) return;
  const event = {
    schema_version: 1,
    run_id: approval.request.run_id,
    ts: approval.decision.decided_at,
    event: "approval.resolved",
    stage: "",
    approval_id: approval.request.id,
    decision_id: approval.request.decision_id,
    verdict: approval.decision.verdict,
    actor: approval.decision.actor,
    reason: approval.decision.reason ?? null,
  };
  writeFileSync(journalPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
}

function approvalRequestDigest(
  policySha256: string,
  request: PolicyRequestSummary,
  evaluation: PolicyEvaluation,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ policy_sha256: policySha256, request, evaluation }))
    .digest("hex");
}

function writeExclusiveJson(path: string, value: unknown): boolean {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > RECORD_LIMIT_BYTES) {
    throw new Error(`approval record exceeds ${RECORD_LIMIT_BYTES} bytes`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    chmodSync(path, 0o600);
    return true;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readJsonRecord<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`approval record not found at ${path}`);
  const bytes = statSync(path).size;
  if (bytes <= 0 || bytes > RECORD_LIMIT_BYTES) {
    throw new Error(`approval record at ${path} has invalid size ${bytes}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`cannot parse approval record at ${path}: ${(error as Error).message}`);
  }
}

function validateRequest(request: WorkflowApprovalRequest, approvalId: string): void {
  if (
    request.schema_version !== WORKFLOW_APPROVAL_SCHEMA_VERSION ||
    request.id !== approvalId ||
    !RUN_ID.test(request.run_id) ||
    !DECISION_ID.test(request.decision_id) ||
    workflowApprovalId(request.run_id, request.decision_id) !== approvalId ||
    !validTimestamp(request.requested_at) ||
    bounded(request.addressed_to, "approval addressee", MAX_ADDRESSEE) !== request.addressed_to ||
    bounded(request.policy?.name, "approval policy name", MAX_ACTOR) !== request.policy.name ||
    request.initial_verdict !== "ask" ||
    !/^[a-f0-9]{64}$/.test(request.request_sha256) ||
    !/^[a-f0-9]{64}$/.test(request.policy?.sha256) ||
    !validPolicyRequest(request.request) ||
    !validPolicyEvaluation(request.evaluation) ||
    approvalRequestDigest(request.policy.sha256, request.request, request.evaluation) !==
      request.request_sha256
  ) {
    throw new Error(`approval ${approvalId} has an unsupported or mismatched request record`);
  }
}

function validateDecision(
  decision: WorkflowApprovalDecision,
  request: WorkflowApprovalRequest,
): void {
  if (
    decision.schema_version !== WORKFLOW_APPROVAL_SCHEMA_VERSION ||
    decision.approval_id !== request.id ||
    decision.run_id !== request.run_id ||
    (decision.verdict !== "allow" && decision.verdict !== "deny") ||
    bounded(decision.actor, "approval actor", MAX_ACTOR) !== decision.actor ||
    (decision.reason !== undefined &&
      bounded(decision.reason, "approval reason", MAX_REASON) !== decision.reason) ||
    !validTimestamp(decision.decided_at)
  ) {
    throw new Error(`approval ${request.id} has an unsupported or mismatched decision record`);
  }
}

function validPolicyRequest(request: PolicyRequestSummary): boolean {
  if (!request || typeof request !== "object") return false;
  return (
    (request.phase === "dispatch" || request.phase === "external_mutation") &&
    typeof request.action === "string" &&
    request.action.length > 0 &&
    ["shared", "worktree", "sandbox", "remote"].includes(request.isolation) &&
    ["enabled", "disabled", "unknown"].includes(request.network_access)
  );
}

function validPolicyEvaluation(evaluation: PolicyEvaluation): boolean {
  if (!evaluation || typeof evaluation !== "object") return false;
  return (
    evaluation.verdict === "ask" &&
    typeof evaluation.reason === "string" &&
    evaluation.reason.length > 0 &&
    Array.isArray(evaluation.rules) &&
    evaluation.rules.every(
      (rule) =>
        rule &&
        typeof rule.code === "string" &&
        (rule.verdict === "allow" || rule.verdict === "ask" || rule.verdict === "deny") &&
        typeof rule.reason === "string",
    )
  );
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function approvalsRoot(coordRoot: string): string {
  return join(coordRoot, ".harnery", "approvals");
}

function approvalDir(coordRoot: string, approvalId: string): string {
  assertApprovalId(approvalId);
  return join(approvalsRoot(coordRoot), approvalId);
}

function assertApprovalId(approvalId: string): void {
  if (!APPROVAL_ID.test(approvalId)) {
    throw new Error(`invalid workflow approval id ${JSON.stringify(approvalId)}`);
  }
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error(`invalid workflow run id ${JSON.stringify(runId)}`);
}

function sha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be a SHA-256 digest`);
  return value;
}

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}
