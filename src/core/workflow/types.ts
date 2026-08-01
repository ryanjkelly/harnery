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
import type {
  WorkspaceBinding,
  WorkspaceExecutionEvidence,
  WorkspaceProvider,
} from "./workspaces/index.ts";

export const WORKFLOW_PROOF_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_WORK_CONTEXT_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_ATTEMPT_CONTEXT_SCHEMA_VERSION = 1 as const;

/** The evidence vocabulary, as a value so the runtime validator and the
 * pre-flight source scan cannot drift from the type or from each other. */
export const EVIDENCE_KINDS = [
  "test",
  "command",
  "artifact",
  "change",
  "review",
  "observation",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
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
  /** Set on a failed agent whose spawn was classified uninformative about the
   * work (ADR 0046): environment (binary absent) or upstream (vendor refused).
   * Absent ⇒ a work failure. Recorded even when a script's parallel() swallows
   * the rejection, so the run-level class can still be derived from proof. */
  class?: SpawnFailureClass;
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

/** Bounded pointer to the live attestation backing a harness's claims
 * (ADR 0038). Structural facts only: no prompt text, no host paths. */
export interface HarnessAttestationCitation {
  binary_version: string;
  observed_at: string;
  record_digest: string;
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
  /** What backs this harness's capability claims (ADR 0038). Absent when the
   * host recorded no live attestation, which is the common case and is not by
   * itself a proof unknown. */
  attestation?: HarnessAttestationCitation;
}

export interface WorkflowSandboxProjectionEvidence {
  mode: SpawnFilesystemPolicy["mode"];
  writable_roots: string[];
  /** Which Git administrative grant the run asked for (ADR 0040). */
  git_grant: GitAdministrativeGrant;
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
    work_context?: WorkflowWorkContext;
    attempt_context?: WorkflowAttemptContext;
    objective?: string;
    error?: string;
    result?: ResultDigest;
    /** Set on a failed run that was uninformative about the work (ADR 0046):
     * environment or upstream. Derived from the agents' classes when no agent
     * produced a result; absent ⇒ the attempt is charged as before. The durable
     * work projection reads this to decide charging, stopping, and the
     * uncharged-attempt bound. */
    class?: SpawnFailureClass;
  };
  acceptance: {
    criteria: AcceptanceResult[];
    summary: AcceptanceSummary;
  };
  agents: WorkflowAgentProof[];
  evidence: WorkflowEvidenceRecord[];
  policy?: WorkflowPolicyProof;
  /** Immutable terminal provider evidence for isolated execution. */
  execution?: WorkspaceExecutionEvidence;
  repository: WorkflowRepoEvidence;
  /** Filesystem policy projected into every child's vendor sandbox (ADR 0039).
   * Absent means no projection was applied, which is the default. Present means
   * the run can be audited for exactly what its children could write. */
  sandbox_projection?: WorkflowSandboxProjectionEvidence;
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

/** Durable role defaults supplied by a goal governor or embedding host.
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

/**
 * Why a failed run was uninformative about the work (ADR 0046). Absent means
 * the attempt produced information about the work (or succeeded), which is the
 * default and is charged against the attempt budget exactly as before.
 *
 * - `environment`: the run never started — a precondition was missing (the
 *   vendor binary was absent). Uncharged AND not retried: retrying an unchanged
 *   environment cannot help, so the work item stops and names the precondition.
 * - `upstream`: the vendor was reached and refused (5xx, 429, circuit open).
 *   Uncharged, but retry stays available (bounded by max_uncharged_attempts).
 */
export type SpawnFailureClass = "environment" | "upstream";

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
  /** Set when ok=false and the failure was positively identified as
   * uninformative about the work. Absent ⇒ a work failure (charged). */
  class?: SpawnFailureClass;
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
  /** Journal agent id (`a1`, `a2`, …), stamped into the child env
   * (HARNERY_WORKFLOW_AGENT_ID) so in-flight child activity attributes to one
   * agent row rather than only to the run. */
  agentId?: string;
  /** Scrub all API-key vars from the child env so it can only authenticate
   * via its stored (subscription) login. See billing.ts. */
  subscriptionOnly?: boolean;
  /** Filesystem policy to project into the child's own vendor sandbox
   * (ADR 0039). Absent leaves the adapter's default invocation untouched, which
   * is what shared-checkout runs use. An adapter that cannot represent the
   * requested projection refuses before launch rather than downgrading. */
  filesystemPolicy?: SpawnFilesystemPolicy;
}

/**
 * Whether a run may write the Git administrative directory (ADR 0040).
 *
 * There is no middle setting, and the reason is a property of Git rather than a
 * design choice. A linked worktree has a private administrative directory and a
 * shared one, but object writes and branch refs live in the shared half, so even
 * `git add` fails without it. A grant that enables a commit is therefore always
 * a grant on the repository every worktree shares, including the operator's own
 * checkout. That is why it has to be asked for by name.
 */
export type GitAdministrativeGrant = "none" | "shared-repository";

/** What the host has decided the child may write. `full-access` is deliberately
 * not a mode: Harnery does not project a no-sandbox state into a vendor CLI. */
export interface SpawnFilesystemPolicy {
  mode: "read-only" | "workspace-write";
  /** Explicit absolute paths the child may write, declared rather than derived
   * from `cwd`. The path that needs writing (a repository's administrative
   * directory, for instance) is routinely outside the working directory. */
  writableRoots?: readonly string[];
}

/** One headless-subagent runner. The engine is adapter-agnostic; claude-code
 * ships first, codex/cursor land behind the same signature (plan Phase 4). */
export type Spawner = (req: SpawnRequest) => Promise<SpawnResult>;

/** The API surface injected into a workflow script's default export. Explicit
 * injection (no ambient globals): keeps scripts portable and unit-testable. */
export interface WorkflowContext {
  /** Frozen durable-work assignment for work-linked runs. Standalone and
   * legacy-resumed workflows have no work context. */
  work?: Readonly<WorkflowWorkContext>;
  /** Frozen attempt identity and, on retry, a bounded synopsis of prior
   * terminal evidence. Absent for standalone and legacy-resumed workflows. */
  attempt?: Readonly<WorkflowAttemptContext>;
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

/** Minimal immutable durable-work input exposed to reusable workflow code. */
export interface WorkflowWorkContext {
  readonly schema_version: typeof WORKFLOW_WORK_CONTEXT_SCHEMA_VERSION;
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly acceptance: readonly string[];
}

export type WorkflowAttemptFailureCause =
  | "workflow_error"
  | "acceptance_unsatisfied"
  | "acceptance_unknown"
  | "lost";

export interface WorkflowAttemptUnresolvedCriterion {
  readonly id: string;
  readonly statement: string;
  readonly status: "unsatisfied" | "unknown";
}

export interface WorkflowAttemptPriorContext {
  readonly run_id: string;
  readonly causes: readonly WorkflowAttemptFailureCause[];
  readonly error?: string;
  readonly acceptance?: Readonly<AcceptanceSummary>;
  readonly unresolved: readonly WorkflowAttemptUnresolvedCriterion[];
}

export interface WorkflowAttemptContext {
  readonly schema_version: typeof WORKFLOW_ATTEMPT_CONTEXT_SCHEMA_VERSION;
  readonly number: number;
  readonly trigger: "initial" | "retry";
  readonly prior?: Readonly<WorkflowAttemptPriorContext>;
  /** Open findings an operator raised against a prior attempt. Present on any
   * trigger, because a reopen with findings starts a fresh initial attempt.
   * Distinct from `prior`, which is evidence the run itself produced. */
  readonly findings?: readonly Readonly<WorkflowOperatorFinding>[];
}

/** One correction an operator raised against work they judged wrong. Authored
 * by a human, not derived from proof, and carried until explicitly disposed. */
export interface WorkflowOperatorFinding {
  readonly id: string;
  readonly actor: string;
  readonly statement: string;
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
  /** Frozen assignment data supplied by a durable-work host. Requires the
   * matching `workItemId`; parked resume always uses the manifest copy. */
  workContext?: WorkflowWorkContext;
  /** Frozen attempt data supplied by a durable-work host. Requires matching
   * work item and work contexts; parked resume uses the manifest copy. */
  attemptContext?: WorkflowAttemptContext;
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
  /** Live attestations backing each harness's claims (ADR 0038). Read once by
   * the host and injected, so the engine performs no capability lookups. */
  harnessAttestations?: Readonly<Record<HarnessName, HarnessAttestationCitation | undefined>>;
  /** Filesystem policy projected into every child's own vendor sandbox
   * (ADR 0039). Validated against the workspace binding before the first spawn,
   * and recorded in proof. Absent leaves every adapter invocation unchanged. */
  filesystemPolicy?: SpawnFilesystemPolicy;
  /**
   * Whether children may write the repository's administrative directory
   * (ADR 0040). Defaults to `"none"`.
   *
   * The caller asks for the grant by name and never supplies the path: the
   * engine resolves it from the workspace binding the provider already
   * verified. That asymmetry is deliberate. `filesystemPolicy.writableRoots` is
   * caller-supplied and must stay inside the workspace, so a caller cannot use
   * it to reach the source repository; this grant can, which is exactly why it
   * is a named capability rather than another path.
   */
  gitWrite?: GitAdministrativeGrant;
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
  /** Explicit provider and host-owned roots. Omit for shared or declaration-only execution. */
  workspace?: {
    provider: WorkspaceProvider;
    writableRoots: readonly string[];
  };
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
  /** Isolated workspace binding when this run requested a provider capability. */
  workspaceBinding?: WorkspaceBinding;
}
