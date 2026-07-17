/**
 * Workflow engine contracts. A workflow is a small throwaway JS script with
 * bounded, schema-gated stages that fan work out to headless harness-CLI
 * subagents; the SCRIPT (deterministic code), not any model, decides routing
 * between stages, and the run always terminates when the script returns.
 *
 * Design record: decision 0015 (portable coordination-aware workflows).
 */

/** JSON-schema *subset* accepted by stage gates (see validate.ts). */
export interface StageSchema {
  type: "object" | "array" | "string" | "number" | "boolean";
  /** type=object */
  properties?: Record<string, StageSchema>;
  required?: string[];
  /** type=array */
  items?: StageSchema;
  /** any type: closed value set (compared with ===) */
  enum?: Array<string | number | boolean>;
}

export interface AgentOpts {
  /** Stage gate: when present, the agent's reply must strict-parse as JSON and
   * validate; the engine retries with the validation error appended, up to
   * `maxAttempts`. Without it, `agent()` resolves to the raw reply text. */
  schema?: StageSchema;
  /** Model slug passed through to the harness CLI (default: the CLI's default). */
  model?: string;
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

export type HarnessName = "claude-code" | "codex" | "cursor";

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
  timeoutMs: number;
  maxTurns: number;
  cwd: string;
  /** Run id, stamped into the child env (HARNERY_WORKFLOW_RUN_ID) so the
   * coord layer can associate child sessions with their workflow run. */
  runId?: string;
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
}

export interface WorkflowMeta {
  name: string;
  description?: string;
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
  spawners: Partial<Record<HarnessName, Spawner>>;
  /** Harness used when an agent() call doesn't name one (default "claude-code"). */
  defaultHarness?: HarnessName;
  /** Resume: run id of a prior run whose journal supplies cached results.
   * agent() calls whose (stage, prompt, model, maxTurns, schema) key matches a
   * completed prior agent return the journaled result without spawning. */
  resumeFrom?: string;
  /** Total-agent ceiling for the run (default 50): the runaway backstop. */
  maxAgents?: number;
  /** Concurrent-subagent cap for parallel() (default 4). */
  concurrency?: number;
  /** Working directory children spawn in (default: coordRoot). */
  cwd?: string;
  /** Progress sink (default: process.stderr). */
  onLog?: (line: string) => void;
}

export interface RunReport {
  runId: string;
  name: string;
  /** What the script's default export returned. */
  result: unknown;
  agentsSpawned: number;
  /** agent() calls satisfied from the resumeFrom journal without spawning. */
  agentsCached: number;
  costUsd: number;
  durationMs: number;
  journalPath: string;
  /** Estimated tokens of repo instructions (CLAUDE.md/AGENTS.md at the child
   * cwd) that EVERY child cache-writes on spawn — the fixed per-child context
   * overhead a fan-out multiplies. bytes/4 heuristic; 0 when no such file. */
  contextTokensPerChildEstimate: number;
}
