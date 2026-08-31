// Contracts for the qa-run matrix runner: one JSON job in, one JSON result
// out, with the coverage-merge and verdict rules as pure functions.
//
// The runner executes a whole page-QA matrix (planner, deterministic gates,
// interactions, critique, snapshot) in one process so the driving agent stops
// paying a model turn per browser command. These contracts are frozen first so
// the orchestrator, its tests, and downstream consumers build against the same
// shape.
//
// Two rules are load-bearing and enforced here, not in prose:
//   - A job may WIDEN coverage beyond the planner's manifest but can never
//     narrow it below the manifest (mergeCoverage is a union that keeps
//     manifest order first).
//   - A job must not carry credentials. Authentication is referenced through
//     existing browser profiles and cookie stores; validation refuses
//     secret-shaped fields before any browser or model work starts.
//
// Toolkit tier: this module must not import src/core (layering check).

import type { QaContext, QaManifest } from "./qa-plan.js";

export const QA_RUN_JOB_SCHEMA_VERSION = 1 as const;
export const QA_RUN_RESULT_SCHEMA_VERSION = 1 as const;

/** One rendering context the runner will capture and check. */
export interface QaRunContext {
  /** Stable ID, unique within the job; also the artifact prefix component.
   * Derived contexts use `<viewport>-<theme>-<state>`. */
  id: string;
  /** Viewport preset name (`desktop`, `mobile`, …) or `WxH`. */
  viewport: string;
  theme: "light" | "dark";
  /** Named UI state; `default` for the plain page. */
  state: string;
}

/** One deterministic gate: extra browse arguments appended to the context's
 * base capture command. Arguments are an array by contract — the runner never
 * builds a shell string. */
export interface QaRunCheck {
  /** Stable ID, unique within the job (e.g. `overflow`, `contrast-hero`). */
  id: string;
  /** Browse flags for this gate, e.g. ["--check-overflow", "--check-overflow-fail"]. */
  args: string[];
  /** Context IDs this gate applies to. Absent = every context. */
  contexts?: string[];
}

/** One named interaction state: setup actions plus outcome assertions that
 * prove the state changed, not merely that something was clicked. */
export interface QaRunInteraction {
  /** State name; must match a planner/state name when the planner declared one. */
  name: string;
  /** Browse flags that produce the state (e.g. ["--batch", "click #tab-2; wait 500"]). */
  setup: string[];
  /** Assertion specs passed as repeated --assert values. At least one is
   * required — a click without a proven outcome is not an interaction gate. */
  assertions: string[];
}

export interface QaRunPolicy {
  /** Permit the critique provider's metered-API fallback. Default false: an
   * exhausted headless-harness list becomes an `incomplete` blocker. */
  allow_metered_critique?: boolean;
  /** Concurrent deterministic captures (default 2). Interactions always run
   * serially regardless of this value. */
  command_concurrency?: number;
  /** Per-command timeout in milliseconds (default 120000). */
  command_timeout_ms?: number;
}

export interface QaRunJob {
  schema_version: typeof QA_RUN_JOB_SCHEMA_VERSION;
  /** URL, local file path, or framework route the runner will render. */
  target: string;
  /** Git SHA or content identifier of what is being tested. */
  tested_revision?: string;
  /** signoff persists a QA snapshot on a passing run; review never does. */
  mode: "signoff" | "review";
  /** Extra coverage beyond the planner manifest (union, never narrowing). */
  contexts?: QaRunContext[];
  /** Deterministic gates. Empty/absent = the runner's baseline capture only. */
  checks?: QaRunCheck[];
  interaction_states?: QaRunInteraction[];
  /** Forwarded to the planner as --qa-scope / --qa-states inputs. */
  qa_hints?: { scopes?: string[]; states?: string[] };
  policy?: QaRunPolicy;
}

/** Outcome of one executed browse command. */
export interface QaRunCommandOutcome {
  context_id: string;
  /** Gate ID, `capture` for the base capture, `plan`, `critique`, or an
   * interaction state name prefixed with `interaction:`. */
  check_id: string;
  argv: string[];
  exit_code: number | null;
  outcome: "passed" | "failed" | "unknown";
  /** Human-readable failure details parsed from the JSON artifact. */
  failures: string[];
  artifacts: { png?: string; html?: string; json?: string };
  wall_time_ms: number;
}

export interface QaRunCritiqueOutcome {
  context_id: string;
  provider: string;
  tiles_total: number;
  tiles_reviewed: number;
  tiles_reused: number;
  outcome: "passed" | "failed" | "unknown";
  findings: Array<{ severity: string; summary: string; selector?: string }>;
}

export interface QaRunBlocker {
  stage: "validate" | "plan" | "gates" | "interactions" | "critique" | "snapshot" | "result";
  context_id?: string;
  reason: string;
}

export type QaRunVerdict = "passed" | "failed" | "incomplete";

export interface QaRunResult {
  schema_version: typeof QA_RUN_RESULT_SCHEMA_VERSION;
  target: string;
  tested_revision?: string;
  mode: "signoff" | "review";
  /** The authoritative planner manifest, null when planning itself failed. */
  qa_plan: QaManifest | null;
  /** Merged coverage in manifest order (manifest contexts first). */
  contexts: QaRunContext[];
  commands: QaRunCommandOutcome[];
  critique: QaRunCritiqueOutcome[];
  snapshot: { saved: boolean; path?: string };
  wall_time_ms: {
    plan: number;
    gates: number;
    interactions: number;
    critique: number;
    snapshot: number;
    total: number;
  };
  blockers: QaRunBlocker[];
  verdict: QaRunVerdict;
}

// ---------------------------------------------------------------------------
// Job validation
// ---------------------------------------------------------------------------

/** Field names that indicate an embedded credential. Matched on any object
 * key anywhere in the job, case-insensitively. */
const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|api[-_]?key|authorization|cookie|credential|bearer)/i;

/** Value shapes that indicate an embedded credential even under an innocent
 * key: explicit auth headers and long unbroken high-entropy-looking blobs. */
const SECRET_VALUE_PATTERNS = [/\bBearer\s+[\w.~+/=-]{16,}/i, /\bBasic\s+[A-Za-z0-9+/=]{16,}/];

export type QaRunJobValidation = { ok: true; job: QaRunJob } | { ok: false; errors: string[] };

function scanForSecrets(value: unknown, path: string, errors: string[]): void {
  if (typeof value === "string") {
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        errors.push(
          `${path}: value looks like a credential — reference a browser profile or cookie store instead`,
        );
        return;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      scanForSecrets(item, `${path}[${i}]`, errors);
    });
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        errors.push(
          `${path}.${key}: secret-bearing field names are refused — reference a browser profile or cookie store instead`,
        );
        continue;
      }
      scanForSecrets(child, `${path}.${key}`, errors);
    }
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validate an untrusted job document. Structural errors and secret-bearing
 * fields are all reported at once so a caller can fix the job in one pass.
 * Validation is deliberately strict: an underspecified job fails here, before
 * any browser or model process starts.
 */
export function validateQaRunJob(value: unknown): QaRunJobValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["job must be a JSON object"] };
  }
  const job = value as Record<string, unknown>;

  if (job.schema_version !== QA_RUN_JOB_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${QA_RUN_JOB_SCHEMA_VERSION}`);
  }
  if (typeof job.target !== "string" || job.target.length === 0) {
    errors.push("target is required (URL, file path, or route)");
  }
  if (job.mode !== "signoff" && job.mode !== "review") {
    errors.push('mode must be "signoff" or "review"');
  }

  const ids = new Set<string>();
  if (job.contexts !== undefined) {
    if (!Array.isArray(job.contexts)) {
      errors.push("contexts must be an array");
    } else {
      job.contexts.forEach((ctx, i) => {
        const c = ctx as Record<string, unknown>;
        if (typeof c?.id !== "string" || c.id.length === 0)
          errors.push(`contexts[${i}].id is required`);
        else if (ids.has(c.id)) errors.push(`contexts[${i}].id duplicates "${c.id}"`);
        else ids.add(c.id);
        if (typeof c?.viewport !== "string" || c.viewport.length === 0) {
          errors.push(`contexts[${i}].viewport is required`);
        }
        if (c?.theme !== "light" && c?.theme !== "dark") {
          errors.push(`contexts[${i}].theme must be "light" or "dark"`);
        }
        if (typeof c?.state !== "string" || c.state.length === 0) {
          errors.push(`contexts[${i}].state is required ("default" for the plain page)`);
        }
      });
    }
  }

  if (job.checks !== undefined) {
    if (!Array.isArray(job.checks)) {
      errors.push("checks must be an array");
    } else {
      const checkIds = new Set<string>();
      job.checks.forEach((check, i) => {
        const c = check as Record<string, unknown>;
        if (typeof c?.id !== "string" || c.id.length === 0)
          errors.push(`checks[${i}].id is required`);
        else if (checkIds.has(c.id)) errors.push(`checks[${i}].id duplicates "${c.id}"`);
        else checkIds.add(c.id);
        if (!isStringArray(c?.args) || (c.args as string[]).length === 0) {
          errors.push(
            `checks[${i}].args must be a non-empty argument array (never a shell string)`,
          );
        }
        if (c?.contexts !== undefined && !isStringArray(c.contexts)) {
          errors.push(`checks[${i}].contexts must be an array of context IDs`);
        }
      });
    }
  }

  if (job.interaction_states !== undefined) {
    if (!Array.isArray(job.interaction_states)) {
      errors.push("interaction_states must be an array");
    } else {
      job.interaction_states.forEach((state, i) => {
        const s = state as Record<string, unknown>;
        if (typeof s?.name !== "string" || s.name.length === 0) {
          errors.push(`interaction_states[${i}].name is required`);
        }
        if (!isStringArray(s?.setup) || (s.setup as string[]).length === 0) {
          errors.push(`interaction_states[${i}].setup must be a non-empty argument array`);
        }
        if (!isStringArray(s?.assertions) || (s.assertions as string[]).length === 0) {
          errors.push(
            `interaction_states[${i}].assertions must name at least one outcome assertion — a click without a proven outcome is not a gate`,
          );
        }
      });
    }
  }

  if (job.policy !== undefined) {
    const p = job.policy as Record<string, unknown>;
    if (p?.command_concurrency !== undefined) {
      const n = p.command_concurrency;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 8) {
        errors.push("policy.command_concurrency must be an integer between 1 and 8");
      }
    }
    if (p?.command_timeout_ms !== undefined) {
      const n = p.command_timeout_ms;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1000) {
        errors.push("policy.command_timeout_ms must be an integer ≥ 1000");
      }
    }
  }

  scanForSecrets(job, "job", errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, job: value as QaRunJob };
}

// ---------------------------------------------------------------------------
// Coverage merge — widen-only
// ---------------------------------------------------------------------------

export function contextIdFor(context: QaContext): string {
  return `${context.viewport}-${context.theme}-${context.state}`;
}

/**
 * Merge planner-manifest coverage with the job's extra contexts. The manifest
 * is the floor: its contexts always run, in manifest order, and a job can only
 * append. The union construction makes narrowing impossible by design; the
 * returned list is what the runner executes and what the result reports.
 */
export function mergeCoverage(manifest: QaManifest, job: QaRunJob): QaRunContext[] {
  const merged: QaRunContext[] = manifest.contexts.map((context) => ({
    id: contextIdFor(context),
    viewport: context.viewport,
    theme: context.theme,
    state: context.state,
  }));
  const seen = new Set(merged.map((context) => context.id));
  for (const context of job.contexts ?? []) {
    const canonical = contextIdFor(context);
    if (seen.has(canonical) || seen.has(context.id)) continue;
    seen.add(canonical);
    seen.add(context.id);
    merged.push(context);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Verdict — fail-closed
// ---------------------------------------------------------------------------

/**
 * Compute the terminal verdict from completed evidence. The rules are the
 * existing page-QA signoff contract, fail-closed:
 *   - any blocker → incomplete (a blocker is a fact the run could not
 *     establish, so a defect cannot be ruled out);
 *   - any failed or unknown command/critique outcome → failed when the check
 *     completed and found a defect, incomplete when the outcome is unknown;
 *   - signoff mode additionally requires the snapshot to have been saved.
 * `passed` is only reachable when every input proves out.
 */
export function computeVerdict(input: {
  mode: QaRunJob["mode"];
  blockers: QaRunBlocker[];
  commands: QaRunCommandOutcome[];
  critique: QaRunCritiqueOutcome[];
  snapshotSaved: boolean;
}): QaRunVerdict {
  const failed =
    input.commands.some((command) => command.outcome === "failed") ||
    input.critique.some((entry) => entry.outcome === "failed");
  if (failed) return "failed";
  const unknown =
    input.commands.some((command) => command.outcome === "unknown") ||
    input.critique.some((entry) => entry.outcome === "unknown");
  if (input.blockers.length > 0 || unknown) return "incomplete";
  if (input.mode === "signoff" && !input.snapshotSaved) return "incomplete";
  return "passed";
}
