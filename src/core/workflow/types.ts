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
  timeoutMs: number;
  maxTurns: number;
  cwd: string;
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
  spawner: Spawner;
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
  costUsd: number;
  durationMs: number;
  journalPath: string;
}
