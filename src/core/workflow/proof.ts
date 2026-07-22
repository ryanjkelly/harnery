import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { RepoSnapshot } from "../context/index.ts";
import type {
  NormalizedPolicy,
  PolicyDecision,
  PolicyIsolation,
  PolicyNetworkAccess,
} from "../policy/index.ts";
import { policyDigest } from "../policy/index.ts";
import type {
  AcceptanceCriterion,
  AcceptanceResult,
  AcceptanceSummary,
  HarnessEvidenceCapability,
  HarnessEvidenceCoverage,
  ResultDigest,
  WorkflowAgentProof,
  WorkflowEvidenceInput,
  WorkflowEvidenceRecord,
  WorkflowMeta,
  WorkflowPolicyProof,
  WorkflowProof,
  WorkflowProofUnknown,
  WorkflowRepoEvidence,
  WorkflowRepoSnapshot,
} from "./types.ts";
import { WORKFLOW_PROOF_SCHEMA_VERSION } from "./types.ts";

const MAX_ACCEPTANCE_CRITERIA = 50;
const MAX_EVIDENCE_RECORDS = 200;
const MAX_PACKET_BYTES = 512 * 1024;
const MAX_NAME_CHARS = 200;
const MAX_OBJECTIVE_CHARS = 2_000;
const MAX_CRITERION_CHARS = 500;
const MAX_LABEL_CHARS = 200;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_REF_CHARS = 1_000;
const ACCEPTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface NormalizedWorkflowMeta {
  name: string;
  description?: string;
  objective?: string;
  acceptance: AcceptanceCriterion[];
}

export interface BuildWorkflowProofInput {
  runId: string;
  workItemId?: string;
  meta: NormalizedWorkflowMeta;
  status: "succeeded" | "failed";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  journalPath: string;
  before: RepoSnapshot;
  after: RepoSnapshot;
  agents: WorkflowAgentProof[];
  evidence: WorkflowEvidenceRecord[];
  harnessEvidence?: Readonly<Record<string, HarnessEvidenceCapability | undefined>>;
  policy?: {
    config: Readonly<NormalizedPolicy>;
    decisions: readonly PolicyDecision[];
    isolation: PolicyIsolation;
    networkAccess: PolicyNetworkAccess;
  };
  result?: unknown;
  error?: string;
}

export function normalizeWorkflowMeta(
  meta: WorkflowMeta | undefined,
  fallbackName: string,
): NormalizedWorkflowMeta {
  const name = boundedRequired(meta?.name ?? fallbackName, "workflow name", MAX_NAME_CHARS);
  const objective = boundedOptional(meta?.objective, "workflow objective", MAX_OBJECTIVE_CHARS);
  const description = boundedOptional(
    meta?.description,
    "workflow description",
    MAX_OBJECTIVE_CHARS,
  );
  const acceptance = meta?.acceptance ?? [];
  if (!Array.isArray(acceptance)) throw new Error("workflow acceptance must be an array");
  if (acceptance.length > MAX_ACCEPTANCE_CRITERIA) {
    throw new Error(`workflow acceptance exceeds ${MAX_ACCEPTANCE_CRITERIA} criteria`);
  }

  const seen = new Set<string>();
  const normalized = acceptance.map((criterion, index) => {
    if (!criterion || typeof criterion !== "object") {
      throw new Error(`workflow acceptance[${index}] must be an object`);
    }
    const id = boundedRequired(criterion.id, `workflow acceptance[${index}].id`, 64);
    if (!ACCEPTANCE_ID.test(id)) {
      throw new Error(
        `workflow acceptance id ${JSON.stringify(id)} must match ${ACCEPTANCE_ID.source}`,
      );
    }
    if (seen.has(id)) throw new Error(`duplicate workflow acceptance id ${JSON.stringify(id)}`);
    seen.add(id);
    return {
      id,
      statement: boundedRequired(
        criterion.statement,
        `workflow acceptance[${index}].statement`,
        MAX_CRITERION_CHARS,
      ),
    };
  });
  return { name, description, objective, acceptance: normalized };
}

export function createEvidenceRecord(input: {
  value: WorkflowEvidenceInput;
  sequence: number;
  acceptanceIds: ReadonlySet<string>;
  stage?: string;
  recordedAt?: string;
}): WorkflowEvidenceRecord {
  if (input.sequence > MAX_EVIDENCE_RECORDS) {
    throw new Error(`workflow evidence exceeds ${MAX_EVIDENCE_RECORDS} records`);
  }
  const value = input.value;
  const acceptanceIds = value.acceptanceIds ?? [];
  if (!Array.isArray(acceptanceIds)) throw new Error("evidence acceptanceIds must be an array");
  const uniqueAcceptanceIds = [...new Set(acceptanceIds)];
  for (const id of uniqueAcceptanceIds) {
    if (typeof id !== "string" || !input.acceptanceIds.has(id)) {
      throw new Error(`evidence references unknown acceptance id ${JSON.stringify(id)}`);
    }
  }
  return {
    id: `e${input.sequence}`,
    source: "workflow",
    recorded_at: input.recordedAt ?? new Date().toISOString(),
    kind: enumValue(
      value.kind,
      ["test", "command", "artifact", "change", "review", "observation"],
      "evidence kind",
    ),
    status: enumValue(value.status, ["passed", "failed", "observed", "unknown"], "evidence status"),
    label: boundedRequired(value.label, "evidence label", MAX_LABEL_CHARS),
    summary: boundedOptional(value.summary, "evidence summary", MAX_SUMMARY_CHARS),
    ref: boundedOptional(value.ref, "evidence ref", MAX_REF_CHARS),
    stage: boundedOptional(input.stage, "evidence stage", MAX_LABEL_CHARS),
    acceptance_ids: uniqueAcceptanceIds,
  };
}

export function rollupAcceptance(
  criteria: AcceptanceCriterion[],
  evidence: WorkflowEvidenceRecord[],
): { criteria: AcceptanceResult[]; summary: AcceptanceSummary } {
  const results = criteria.map((criterion): AcceptanceResult => {
    const attached = evidence.filter((item) => item.acceptance_ids.includes(criterion.id));
    const failed = attached.filter((item) => item.status === "failed");
    const passed = attached.filter((item) => item.status === "passed");
    const decisive = failed.length > 0 ? failed : passed;
    const status = failed.length > 0 ? "unsatisfied" : passed.length > 0 ? "satisfied" : "unknown";
    return {
      ...criterion,
      status,
      evidence_ids: attached.map((item) => item.id),
      sources: [...new Set(decisive.map((item) => item.source))],
    };
  });
  return {
    criteria: results,
    summary: {
      satisfied: results.filter((item) => item.status === "satisfied").length,
      unsatisfied: results.filter((item) => item.status === "unsatisfied").length,
      unknown: results.filter((item) => item.status === "unknown").length,
      total: results.length,
    },
  };
}

export function digestResult(value: unknown, kind?: "text" | "json"): ResultDigest {
  const resolvedKind = kind ?? (typeof value === "string" ? "text" : "json");
  const serialized = resolvedKind === "text" ? String(value) : (JSON.stringify(value) ?? "null");
  return {
    kind: resolvedKind,
    sha256: createHash("sha256").update(serialized).digest("hex"),
    bytes: Buffer.byteLength(serialized),
  };
}

export function buildWorkflowProof(input: BuildWorkflowProofInput): WorkflowProof {
  const acceptance = rollupAcceptance(input.meta.acceptance, input.evidence);
  const repository = buildRepoEvidence(input.before, input.after);
  const agents = input.agents.map((agent) => ({
    ...agent,
    label: clipped(agent.label, MAX_LABEL_CHARS),
    specialist: clippedOptional(agent.specialist, MAX_LABEL_CHARS),
    model: clippedOptional(agent.model, MAX_LABEL_CHARS),
    session_id: clippedOptional(agent.session_id, MAX_REF_CHARS),
    error: clippedOptional(agent.error, MAX_SUMMARY_CHARS),
  }));
  const harnesses = buildHarnessCoverage(agents, input.harnessEvidence);
  const unknowns = buildUnknowns(agents, harnesses, repository);
  const journal = readFileSync(input.journalPath);
  return {
    schema_version: WORKFLOW_PROOF_SCHEMA_VERSION,
    run: {
      id: input.runId,
      work_item_id: input.workItemId,
      name: input.meta.name,
      status: input.status,
      started_at: input.startedAt,
      ended_at: input.endedAt,
      duration_ms: input.durationMs,
      objective: input.meta.objective,
      error: clippedOptional(input.error, MAX_SUMMARY_CHARS),
      result: input.result === undefined ? undefined : digestResult(input.result),
    },
    acceptance,
    agents,
    evidence: input.evidence,
    policy: input.policy ? buildPolicyProof(input.policy) : undefined,
    repository,
    harnesses,
    unknowns,
    integrity: {
      journal: {
        path: "journal.jsonl",
        sha256: createHash("sha256").update(journal).digest("hex"),
        bytes: journal.byteLength,
      },
    },
  };
}

function buildPolicyProof(
  input: NonNullable<BuildWorkflowProofInput["policy"]>,
): WorkflowPolicyProof {
  const decisions = input.decisions.map((decision) => ({
    ...decision,
    reason: clipped(decision.reason, MAX_SUMMARY_CHARS),
    request: {
      ...decision.request,
      action: clipped(decision.request.action, MAX_REF_CHARS),
      path: clippedOptional(decision.request.path, MAX_REF_CHARS),
      target: clippedOptional(decision.request.target, MAX_REF_CHARS),
    },
  }));
  return {
    schema_version: input.config.schema_version,
    name: input.config.name,
    sha256: policyDigest(input.config),
    isolation: input.isolation,
    network_access: input.networkAccess,
    config: input.config as NormalizedPolicy,
    decisions,
    summary: {
      allowed: decisions.filter((decision) => decision.verdict === "allow").length,
      denied: decisions.filter((decision) => decision.verdict === "deny").length,
      asked: decisions.filter((decision) => decision.initial_verdict === "ask").length,
      total: decisions.length,
    },
  };
}

export function writeWorkflowProof(path: string, proof: WorkflowProof): void {
  const body = `${JSON.stringify(proof, null, 2)}\n`;
  const bytes = Buffer.byteLength(body);
  if (bytes > MAX_PACKET_BYTES) {
    throw new Error(`workflow proof is ${bytes} bytes; limit is ${MAX_PACKET_BYTES}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function readWorkflowProof(coordRoot: string, runId: string): WorkflowProof {
  if (!RUN_ID.test(runId)) throw new Error(`invalid workflow run id ${JSON.stringify(runId)}`);
  const path = join(coordRoot, ".harnery", "workflows", runId, "proof.json");
  if (!existsSync(path)) throw new Error(`workflow run ${runId} has no proof packet at ${path}`);
  const size = statSync(path).size;
  if (size > MAX_PACKET_BYTES) {
    throw new Error(`workflow proof is ${size} bytes; limit is ${MAX_PACKET_BYTES}`);
  }
  let proof: WorkflowProof;
  try {
    proof = JSON.parse(readFileSync(path, "utf8")) as WorkflowProof;
  } catch (error) {
    throw new Error(`cannot parse workflow proof at ${path}: ${(error as Error).message}`);
  }
  if (proof.schema_version !== WORKFLOW_PROOF_SCHEMA_VERSION || proof.run?.id !== runId) {
    throw new Error(`workflow proof at ${path} has an unsupported or mismatched schema`);
  }
  return proof;
}

export function renderWorkflowProof(proof: WorkflowProof): string {
  const lines = [
    `run ${proof.run.id} (${proof.run.name}): ${proof.run.status}`,
    `duration: ${Math.round(proof.run.duration_ms / 1000)}s`,
  ];
  if (proof.run.objective) lines.push(`objective: ${proof.run.objective}`);
  const summary = proof.acceptance.summary;
  lines.push(
    `acceptance: ${summary.satisfied} satisfied, ${summary.unsatisfied} unsatisfied, ${summary.unknown} unknown`,
  );
  for (const criterion of proof.acceptance.criteria) {
    const mark =
      criterion.status === "satisfied" ? "PASS" : criterion.status === "unsatisfied" ? "FAIL" : "?";
    const refs = criterion.evidence_ids.length > 0 ? ` [${criterion.evidence_ids.join(", ")}]` : "";
    lines.push(`  ${mark} ${criterion.id}: ${criterion.statement}${refs}`);
  }
  lines.push(`evidence: ${proof.evidence.length} record(s); agents: ${proof.agents.length}`);
  if (proof.policy) {
    lines.push(
      `policy: ${proof.policy.name}; ${proof.policy.summary.allowed} allowed, ` +
        `${proof.policy.summary.denied} denied, ${proof.policy.summary.asked} asked`,
    );
  }
  const repo = proof.repository;
  const drift = repo.drift;
  lines.push(
    `repository: branch ${repo.before.branch ?? "unknown"} -> ${repo.after.branch ?? "unknown"}; ` +
      `HEAD ${short(repo.before.head)} -> ${short(repo.after.head)}; ` +
      `${drift.dirty_paths_added.length} dirty added, ${drift.dirty_paths_cleared.length} cleared`,
  );
  if (proof.unknowns.length > 0) {
    lines.push(`unknowns: ${proof.unknowns.length}`);
    for (const unknown of proof.unknowns) lines.push(`  - ${unknown.message}`);
  }
  lines.push(`journal sha256: ${proof.integrity.journal.sha256}`);
  return `${lines.join("\n")}\n`;
}

function buildRepoEvidence(beforeRaw: RepoSnapshot, afterRaw: RepoSnapshot): WorkflowRepoEvidence {
  const before = normalizeRepoSnapshot(beforeRaw);
  const after = normalizeRepoSnapshot(afterRaw);
  const beforeDirty = new Set(before.dirty_paths);
  const afterDirty = new Set(after.dirty_paths);
  const retained = after.dirty_paths.filter((path) => beforeDirty.has(path));
  const incomplete = Boolean(
    before.dirty_paths_truncated || after.dirty_paths_truncated || retained.length > 0,
  );
  return {
    source: "engine",
    before,
    after,
    drift: {
      branch_changed: before.branch !== after.branch,
      head_changed: before.head !== after.head,
      dirty_paths_added: after.dirty_paths.filter((path) => !beforeDirty.has(path)),
      dirty_paths_cleared: before.dirty_paths.filter((path) => !afterDirty.has(path)),
      dirty_paths_retained: retained,
      incomplete,
      note: incomplete
        ? "Snapshots cannot prove whether retained dirty paths changed during the run, and truncated lists may omit paths."
        : undefined,
    },
  };
}

function normalizeRepoSnapshot(snapshot: RepoSnapshot): WorkflowRepoSnapshot {
  return {
    cwd: snapshot.cwd,
    root: snapshot.root,
    branch: snapshot.branch,
    head: snapshot.head,
    dirty_paths: snapshot.dirty_paths,
    dirty_paths_truncated: snapshot.dirty_paths_truncated,
  };
}

function buildHarnessCoverage(
  agents: WorkflowAgentProof[],
  claims: Readonly<Record<string, HarnessEvidenceCapability | undefined>> | undefined,
): HarnessEvidenceCoverage[] {
  return [...new Set(agents.map((agent) => agent.harness))].map((harness) => {
    const harnessAgents = agents.filter((agent) => agent.harness === harness);
    return {
      harness,
      tool_evidence: claims?.[harness]?.toolEvidence ?? {
        support: "unknown",
        note: "No harness capability claim was supplied to this workflow run.",
      },
      observed: {
        final_results: harnessAgents.filter((agent) => agent.result).length,
        session_ids: harnessAgents.filter((agent) => agent.session_id).length,
        costs: harnessAgents.filter((agent) => agent.cost_usd !== undefined).length,
      },
    };
  });
}

function buildUnknowns(
  agents: WorkflowAgentProof[],
  harnesses: HarnessEvidenceCoverage[],
  repository: WorkflowRepoEvidence,
): WorkflowProofUnknown[] {
  const unknowns: WorkflowProofUnknown[] = [];
  for (const harness of harnesses) {
    if (harness.tool_evidence.support === "unknown") {
      unknowns.push({
        code: "harness_capability_unregistered",
        harness: harness.harness,
        message: `${harness.harness}: tool-evidence capability was not registered for this run.`,
      });
    } else if (harness.tool_evidence.support !== "supported") {
      unknowns.push({
        code: "tool_evidence_unavailable",
        harness: harness.harness,
        message: `${harness.harness}: adapter-native tool evidence is ${harness.tool_evidence.support}.`,
      });
    }
  }
  for (const agent of agents.filter((item) => item.status !== "failed")) {
    if (agent.cost_usd === undefined) {
      unknowns.push({
        code: "agent_cost_unreported",
        harness: agent.harness,
        agent_id: agent.id,
        message: `${agent.id}: ${agent.harness} did not report per-run cost.`,
      });
    }
    if (!agent.session_id) {
      unknowns.push({
        code: "agent_session_unreported",
        harness: agent.harness,
        agent_id: agent.id,
        message: `${agent.id}: ${agent.harness} did not report a child session id.`,
      });
    }
  }
  if (repository.drift.incomplete) {
    unknowns.push({
      code: "repository_drift_incomplete",
      message: repository.drift.note ?? "Repository drift is incomplete.",
    });
  }
  return unknowns;
}

function boundedRequired(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function boundedOptional(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized === "") return undefined;
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value === "string" && values.includes(value as T)) return value as T;
  throw new Error(`${field} must be one of: ${values.join(", ")}`);
}

function short(value: string | undefined): string {
  return value ? value.slice(0, 8) : "unknown";
}

function clipped(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function clippedOptional(value: string | undefined, max: number): string | undefined {
  return value === undefined ? undefined : clipped(value, max);
}
