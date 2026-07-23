/**
 * Workflow engine contracts. A workflow is a small throwaway JS script with
 * bounded, schema-gated stages that fan work out to headless harness-CLI
 * subagents; the SCRIPT (deterministic code), not any model, decides routing
 * between stages, and the run always terminates when the script returns.
 *
 * Design record: decision 0015 (portable coordination-aware workflows).
 */

import type {
  DispatchCostEstimator,
  ExternalMutationRequest,
  NormalizedPolicy,
  PolicyAskResolver,
  PolicyDecision,
  PolicyIsolation,
  PolicyNetworkAccess,
  PolicySpec,
} from "../policy/index.ts";
import type { BillingMode, BillingProber } from "./billing.ts";

export const WORKFLOW_PROOF_SCHEMA_VERSION = 1 as const;

export type EvidenceKind = "test" | "command" | "artifact" | "change" | "review" | "observation";
export type EvidenceStatus = "passed" | "failed" | "observed" | "unknown";
export type EvidenceSource = "workflow" | "engine";
export type AcceptanceStatus = "satisfied" | "unsatisfied" | "unknown";
export type WorkflowRunStatus = "succeeded" | "failed";
export type WorkflowApprovalMode = "deny" | "park";

export interface AcceptanceCriterion {
  /** Stable identifier referenced by evidence, for example `tests-pass`. */
  id: string;
  statement: string;
}

export interface WorkflowEvidenceInput {
  kind: EvidenceKind;
  status: EvidenceStatus;
  label: string;
  summary?: string;
  /** Inspectable local path, URL, command name, or other bounded reference. */
  ref?: string;
  /** Declared acceptance criteria this evidence bears on. */
  acceptanceIds?: string[];
}

export interface WorkflowEvidenceRecord {
  id: string;
  source: EvidenceSource;
  recorded_at: string;
  kind: EvidenceKind;
  status: EvidenceStatus;
  label: string;
  summary?: string;
  ref?: string;
  stage?: string;
  acceptance_ids: string[];
}

export interface AcceptanceResult extends AcceptanceCriterion {
  status: AcceptanceStatus;
  evidence_ids: string[];
  /** Sources behind the decisive evidence. Empty when status is unknown. */
  sources: EvidenceSource[];
}

export interface AcceptanceSummary {
  satisfied: number;
  unsatisfied: number;
  unknown: number;
  total: number;
}

export interface ResultDigest {
  kind: "text" | "json";
  sha256: string;
  bytes: number;
}

export interface WorkflowAgentProof {
  id: string;
  label: string;
  stage?: string;
  specialist?: string;
  harness: HarnessName;
  model?: string;
  status: "succeeded" | "failed" | "cached";
  attempts: number;
  duration_ms: number;
  cost_usd?: number;
  session_id?: string;
  result?: ResultDigest;
  error?: string;
}

export interface WorkflowRepoSnapshot {
  cwd: string;
  root?: string;
  branch?: string;
  head?: string;
  dirty_paths: string[];
  dirty_paths_truncated?: boolean;
}

export interface WorkflowRepoEvidence {
  source: "engine";
  before: WorkflowRepoSnapshot;
  after: WorkflowRepoSnapshot;
  drift: {
    branch_changed: boolean;
    head_changed: boolean;
    dirty_paths_added: string[];
    dirty_paths_cleared: string[];
    dirty_paths_retained: string[];
    /** True when snapshots cannot prove whether every retained dirty path changed. */
    incomplete: boolean;
    note?: string;
  };
}

export interface HarnessEvidenceCoverage {
  harness: HarnessName;
  tool_evidence: {
    support: "supported" | "partial" | "unsupported" | "unknown";
    note?: string;
  };
  observed: {
    final_results: number;
    session_ids: number;
    costs: number;
  };
}

export interface WorkflowProofUnknown {
  code:
    | "tool_evidence_unavailable"
    | "harness_capability_unregistered"
    | "agent_cost_unreported"
    | "agent_session_unreported"
    | "repository_drift_incomplete";
  message: string;
  harness?: HarnessName;
  agent_id?: string;
}

export interface WorkflowProof {
  schema_version: typeof WORKFLOW_PROOF_SCHEMA_VERSION;
  run: {
    id: string;
    /** Durable objective this execution attempt belongs to, when linked. */
    work_item_id?: string;
    name: string;
    status: WorkflowRunStatus;
    started_at: string;
    ended_at: string;
    duration_ms: number;
    objective?: string;
    error?: string;
    result?: ResultDigest;
  };
  acceptance: {
    criteria: AcceptanceResult[];
    summary: AcceptanceSummary;
  };
  agents: WorkflowAgentProof[];
  evidence: WorkflowEvidenceRecord[];
  policy?: WorkflowPolicyProof;
  repository: WorkflowRepoEvidence;
  harnesses: HarnessEvidenceCoverage[];
  unknowns: WorkflowProofUnknown[];
  integrity: {
    journal: {
      path: "journal.jsonl";
      sha256: string;
      bytes: number;
    };
  };
}

export interface WorkflowPolicyProof {
  schema_version: 1;
  name: string;
  sha256: string;
  isolation: PolicyIsolation;
  network_access: PolicyNetworkAccess;
  config: NormalizedPolicy;
  decisions: PolicyDecision[];
  summary: {
    allowed: number;
    denied: number;
    asked: number;
    total: number;
  };
}

export interface HarnessEvidenceCapability {
  toolEvidence: HarnessEvidenceCoverage["tool_evidence"];
}

/** JSON-schema *subset* accepted by stage gates (see validate.ts). */
export interface StageSchema {
  type: "object" | "array" | "string" | "number" | "boolean";
  /** Exact-one branch selection, evaluated before the base schema. */
  oneOf?: StageSchema[];
  /** type=object */
  properties?: Record<string, StageSchema>;
  required?: string[];
  additionalProperties?: boolean;
  /** type=array */
  items?: StageSchema;
  minItems?: number;
  maxItems?: number;
  /** type=string */
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** any type: closed value set (compared with ===) */
  enum?: Array<string | number | boolean>;
}

export interface AgentOpts {
  /** Frozen specialist profile whose instructions and defaults wrap this
   * assignment. The host supplies profiles through EngineOpts.specialists. */
  specialist?: string;
  /** Stage gate: when present, the agent's reply must strict-parse as JSON and
   * validate; the engine retries with the validation error appended, up to
   * `maxAttempts`. Without it, `agent()` resolves to the raw reply text. */
  schema?: StageSchema;
  /** Model slug passed through to the harness CLI (default: the CLI's default). */
  model?: string;
  /** Reasoning effort mapped through the selected harness profile. Unsupported
   * values fail before the vendor process starts. */
  effort?: string;
  /** Attempt ceiling for the schema-retry loop (default 2). */
  maxAttempts?: number;
  /** Subprocess timeout ms (default 300_000). */
  timeoutMs?: number;
  /** Harness-turn ceiling for the child (default 25; use 1 for pure
   * classification stages — cheaper and faster). */
  maxTurns?: number;
  /** Display label in the journal (default: prompt head). */
  label?: string;
  /** Which harness runs this agent (default: the run's default harness).
   * Mixed-harness workflows are legal: triage on one CLI, deep work on
   * another. */
  harness?: HarnessName;
}

/** Open registry key. The built-in catalog currently contains Claude Code,
 * Codex, and Cursor; consumers may register another adapter without widening
 * a package-owned union first. */
export type HarnessName = string;

/** Durable role defaults supplied by a goal supervisor or embedding host.
 * Profiles are frozen into a workflow run manifest before the first spawn. */
export interface WorkflowSpecialistProfile {
  instructions: string;
  harness?: HarnessName;
  model?: string;
  effort?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  maxTurns?: number;
}

/** What a spawn adapter returns for one subagent run. */
export interface SpawnResult {
  ok: boolean;
  /** The model's final reply text (envelope-unwrapped). */
  text: string;
  /** Child harness session id when the envelope carries one. */
  sessionId?: string;
  costUsd?: number;
  durationMs: number;
  /** Populated when ok=false. */
  error?: string;
}

export interface SpawnRequest {
  prompt: string;
  model?: string;
  effort?: string;
  timeoutMs: number;
  maxTurns: number;
  cwd: string;
  /** Run id, stamped into the child env (HARNERY_WORKFLOW_RUN_ID) so the
   * coord layer can associate child sessions with their workflow run. */
  runId?: string;
  /** Scrub all API-key vars from the child env so it can only authenticate
   * via its stored (subscription) login. See billing.ts. */
  subscriptionOnly?: boolean;
}

/** One headless-subagent runner. The engine is adapter-agnostic; claude-code
 * ships first, codex/cursor land behind the same signature (plan Phase 4). */
export type Spawner = (req: SpawnRequest) => Promise<SpawnResult>;

/** The API surface injected into a workflow script's default export. Explicit
 * injection (no ambient globals): keeps scripts portable and unit-testable. */
export interface WorkflowContext {
  /** Spawn one subagent; resolves to validated JSON (schema) or reply text. */
  agent: (prompt: string, opts?: AgentOpts) => Promise<unknown>;
  /** Run thunks with bounded concurrency; a rejected thunk resolves to null. */
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>;
  /** Declare the current stage (journal + progress grouping). */
  stage: (title: string) => void;
  /** Narrate progress (stderr + journal). */
  log: (message: string) => void;
  /** Attach a bounded, sourced receipt to the run and optional acceptance criteria. */
  evidence: (input: WorkflowEvidenceInput) => string;
  /** Authorize one host-mediated external mutation before performing it. */
  authorize: (input: ExternalMutationRequest) => Promise<PolicyDecision>;
}

export interface WorkflowMeta {
  name: string;
  description?: string;
  objective?: string;
  acceptance?: AcceptanceCriterion[];
}

/** Loaded script shape: `export const meta` + `export default async (ctx) => …`. */
export interface WorkflowModule {
  meta?: WorkflowMeta;
  default: (ctx: WorkflowContext) => Promise<unknown>;
}

export interface EngineOpts {
  /** Repo root whose .harnery/ receives the run journal. */
  coordRoot: string;
  /** Spawner registry keyed by harness. A single-harness caller registers one
   * entry and names it in `defaultHarness`. */
  spawners: Readonly<Record<HarnessName, Spawner | undefined>>;
  /** Harness used when an agent() call doesn't name one (default "claude-code"). */
  defaultHarness?: HarnessName;
  /** Named specialist roles available to agent(..., { specialist }). */
  specialists?: Readonly<Record<string, WorkflowSpecialistProfile>>;
  /** Resume: run id of a prior run whose journal supplies cached results.
   * agent() calls whose (stage, prompt, model, maxTurns, schema) key matches a
   * completed prior agent return the journaled result without spawning. */
  resumeFrom?: string;
  /** Continue a parked run in its original directory after its durable
   * approval has been resolved. The frozen run manifest supplies execution
   * options and the original repository-before snapshot. */
  resumeRunId?: string;
  /** Stable id for a new run allocated by a durable-work host. */
  runId?: string;
  /** Durable objective this execution attempt belongs to. */
  workItemId?: string;
  /** Total-agent ceiling for the run (default 50): the runaway backstop. */
  maxAgents?: number;
  /** Concurrent-subagent cap for parallel() (default 4). */
  concurrency?: number;
  /** Working directory children spawn in (default: coordRoot). */
  cwd?: string;
  /** Progress sink (default: process.stderr). */
  onLog?: (line: string) => void;
  /** Guarantee subscription billing: API-key vars are scrubbed from every
   * child env, and a harness whose stored login is provably absent fails
   * loud before spawning. */
  subscriptionOnly?: boolean;
  /** Permit the api-key-override billing state (an exported API key silently
   * shadowing a stored subscription login), which the engine otherwise
   * refuses. Deliberate key-only hosts don't need this — only the
   * both-present case does. */
  allowApiBilling?: boolean;
  /** Billing-probe override for tests (default: the real probeBilling). */
  probeBilling?: BillingProber;
  /** Capability claims used to state whether adapter-native tool evidence was
   * available. Missing claims remain unknown. */
  harnessEvidence?: Readonly<Record<HarnessName, HarnessEvidenceCapability | undefined>>;
  /** Immutable host policy. Workflow scripts and model prompts cannot replace it. */
  policy?: PolicySpec | NormalizedPolicy;
  /** Host callback for ASK. Missing, invalid, throwing, or timed-out resolution denies. */
  resolvePolicyAsk?: PolicyAskResolver;
  /** Host-owned cost projection. Required to allow budgeted dispatches with known pricing. */
  estimateDispatchCost?: DispatchCostEstimator;
  /** Maximum wait for an ASK resolver (default 60 seconds). */
  policyAskTimeoutMs?: number;
  /** Missing or unavailable ASK resolver behavior (library default: deny). */
  approvalMode?: WorkflowApprovalMode;
  /** Bounded address recorded on newly parked approval requests. */
  approvalAddressee?: string;
  /** Execution boundary created by the host (default shared). */
  isolation?: PolicyIsolation;
  /** Network state of spawned harness subprocesses (default unknown). */
  networkAccess?: PolicyNetworkAccess;
}

export interface RunReport {
  runId: string;
  workItemId?: string;
  name: string;
  /** What the script's default export returned. */
  result: unknown;
  agentsSpawned: number;
  /** agent() calls satisfied from the resumeFrom journal without spawning. */
  agentsCached: number;
  costUsd: number;
  durationMs: number;
  journalPath: string;
  proofPath: string;
  acceptance: AcceptanceSummary;
  /** Estimated tokens of repo instructions (CLAUDE.md/AGENTS.md at the child
   * cwd) that EVERY child cache-writes on spawn — the fixed per-child context
   * overhead a fan-out multiplies. bytes/4 heuristic; 0 when no such file. */
  contextTokensPerChildEstimate: number;
  /** Billing mode per harness actually used this run (probed on first use). */
  billing: Array<{ harness: HarnessName; mode: BillingMode }>;
  /** Policy verdict totals when the host supplied a policy. */
  policy?: WorkflowPolicyProof["summary"];
}
