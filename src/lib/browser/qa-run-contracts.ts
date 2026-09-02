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

import { createHash } from "node:crypto";
import type { QaContext, QaManifest } from "./qa-plan.js";

export const QA_RUN_JOB_SCHEMA_VERSION = 1 as const;
export const QA_RUN_RESULT_SCHEMA_VERSION = 4 as const;

/** How a result's evidence was produced. `runner` means the qa-run matrix
 * executed the checks itself. `manual` means an operator or agent performed
 * the checks by hand and recorded them (qa-record); such a result can report
 * a defect but can never claim a pass, because nothing re-executable proved
 * the absence of one. */
export type QaRunEvidenceSource = "runner" | "manual";

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
  /** Extra browse arguments that render this context (theme forcing beyond
   * `--color-scheme`, state setup, waits). Argument array by contract. */
  args?: string[];
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
  /** Overall runner deadline in milliseconds (default 900000). When the run
   * exceeds it, remaining commands are skipped, a `deadline` blocker is
   * recorded, and the result finalizes as incomplete — releasing the
   * admission slot instead of holding it open-endedly. */
  run_deadline_ms?: number;
  /** Full-page critique bands per context (browse `--check-critique-max-tiles`,
   * default 24). Raise it when a tall page must be reviewed end to end and the
   * per-tile cost is accepted; each critique row's `coverage` records what the
   * run actually saw, which is why this knob can stay out of the job digest. */
  critique_max_tiles?: number;
  /** Vision calls in flight during the judge stage, across every context of
   * the run (1 to 16). Default: the host provider's own concurrency. The
   * capture stage closes every browser before judging starts, so this knob
   * costs model-call parallelism, never browser memory. */
  critique_pool?: number;
  /** Minutes the run's page review pack lives after the judge finishes before
   * the whole pack directory is deleted (default 90; 1 to 43200). The result
   * document keeps every finding inline, so a run stays reportable after its
   * pack is gone. */
  review_pack_retention_minutes?: number;
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
  /** Extra deterministic gates. The runner always executes every planner-
   * required deterministic check; a job can add gates but cannot remove them. */
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

/** Vision-call latency one critique backend reported over the judge pool,
 * in milliseconds over the tile calls it served. The percentiles are the
 * provider's own sample across every context (one pool, one sample). */
export interface QaRunCritiqueLatency {
  count: number;
  p50: number;
  p95: number;
}

/** What share of the page the critique tiles covered, lifted from the browse
 * envelope. `capped` means the tiler dropped bands past its per-context
 * maximum; in signoff mode that is a blocker, in review mode a flag. Across
 * several scope commands the heights take the worst case and the band counts
 * add. */
export interface QaRunCritiqueCoverage {
  page_height_px: number;
  reviewed_height_px: number;
  bands_total: number;
  bands_reviewed: number;
  capped: boolean;
}

export interface QaRunCritiqueOutcome {
  context_id: string;
  provider: string;
  tiles_total: number;
  tiles_reviewed: number;
  tiles_reused: number;
  outcome: "passed" | "failed" | "unknown";
  findings: Array<{ severity: string; summary: string; selector?: string; tile?: string }>;
  /** Tile coverage of the page. Absent when the capture died or reported none. */
  coverage?: QaRunCritiqueCoverage;
}

/** The judge stage as one unit: every context's tiles through one bounded
 * pool of vision calls, with no browser open. `latency_ms` is the backends'
 * own per-call sample over the whole pool, keyed by backend name. */
export interface QaRunCritiquePool {
  concurrency: number;
  tiles_total: number;
  tiles_reviewed: number;
  tiles_reused: number;
  wall_time_ms: number;
  provider: string;
  latency_ms?: Record<string, QaRunCritiqueLatency>;
}

/** Where the run's page review pack lives: the on-disk evidence an agent can
 * review without a browser (tiles, DOM, coverage, `review.md`, and the
 * delegated-review `findings.json`). */
export interface QaRunReviewPack {
  schema: string;
  dir: string;
  review: string;
  findings: string;
  /** When the pack directory is deleted (ISO). Absent when the run never
   * reached the point of knowing (capture failed before any context landed). */
  expires_at?: string;
  /** Bytes on disk at finalize time. */
  size_bytes?: number;
}

export interface QaRunBlocker {
  stage:
    | "validate"
    | "admission"
    | "plan"
    | "gates"
    | "interactions"
    | "capture"
    | "critique"
    | "snapshot"
    | "deadline"
    | "result";
  context_id?: string;
  reason: string;
}

export type QaRunVerdict = "passed" | "failed" | "incomplete";

/** Runner stages in execution order. `last_completed_stage` names the last
 * one that finished without contributing a blocker. */
export const QA_RUN_STAGES = [
  "plan",
  "gates",
  "interactions",
  "capture",
  "critique",
  "snapshot",
] as const;
export type QaRunStage = (typeof QA_RUN_STAGES)[number];

/** Identity of one runner invocation. This block is what makes a result
 * verifiable evidence rather than a loose file: a consumer matches it against
 * the invocation being reported (see assessQaRunEvidence) instead of trusting
 * whatever sits in a reused directory. */
export interface QaRunIdentity {
  /** Minted per invocation (crypto.randomUUID). */
  run_id: string;
  /** ISO-8601 UTC bounds of the invocation. */
  started_at: string;
  completed_at: string;
  /** Git SHA or content identifier of what was tested, when resolvable. */
  tested_revision?: string;
  /** Where tested_revision came from: the job document, a git probe of the
   * working directory, or nowhere (`unknown`, tested_revision absent). */
  revision_source: "job" | "git" | "unknown";
  /** `git status --porcelain` was non-empty when the run started — a revision
   * alone does not prove content. Absent when no git probe ran. */
  worktree_dirty?: boolean;
  /** SHA-256 over the effective validated job (computeJobDigest). */
  job_digest: string;
  /** Absolute run directory the result was written into. A result found
   * elsewhere has been moved or copied and fails evidence assessment. */
  out_dir: string;
}

export const QA_RUN_STATUS_SCHEMA_VERSION = 1 as const;

export type QaRunStatusState = "launching" | "queued" | "running" | "completed";

/** Live status document (`run-status.json`) beside the result in every run
 * directory. Written at start, every stage boundary, and on a heartbeat
 * timer, so a client that lost its terminal (e.g. a Windows-to-WSL bridge
 * disconnect) can mechanically distinguish a running job from a dead one:
 * non-terminal state + dead PID + no result document = dead. The result
 * document stays authoritative once the run completes. */
export interface QaRunStatusDocument {
  schema_version: typeof QA_RUN_STATUS_SCHEMA_VERSION;
  run_id: string;
  /** PID of the process executing the matrix (the detach parent records the
   * child's PID in its initial `launching` write; the child overwrites). */
  pid: number;
  state: QaRunStatusState;
  /** Stage currently executing; null before plan and after completion. */
  stage: QaRunStage | null;
  started_at: string;
  /** Heartbeat. Stage boundaries and a periodic timer both refresh it. */
  updated_at: string;
  /** Present only while state is "queued". */
  queue?: { resource: string; waiting_since: string };
  /** Present only once state is "completed". */
  verdict?: QaRunVerdict;
}

/** Host-pressure sample. Captured at start, at every stage boundary, and at
 * finish, so an incomplete run carries the load context that produced it and
 * names the other heavy jobs it was competing with. */
export interface QaRunHostSample {
  captured_at: string;
  loadavg_1m: number;
  free_mem_bytes: number;
  total_mem_bytes: number;
  cpu_count: number;
  /** Other holders of the admission resource at sample time. Present only
   * when the run queued; an empty array means the run had the host to
   * itself. This is what turns "it was slow" into "it was slow because these
   * three jobs held slots". */
  competing?: Array<{ label: string; pid: number }>;
}

export interface QaRunResult {
  schema_version: typeof QA_RUN_RESULT_SCHEMA_VERSION;
  /** Runner-executed or hand-recorded. A manual result never reads passed. */
  evidence_source: QaRunEvidenceSource;
  run: QaRunIdentity;
  host: {
    start: QaRunHostSample;
    finish: QaRunHostSample;
    /** Sample taken as each stage began, so a stall is attributable to the
     * stage that was running and the load at that moment. */
    stages?: Partial<Record<QaRunStage, QaRunHostSample>>;
  };
  /** Null when the run never completed a stage cleanly (e.g. plan failed). */
  last_completed_stage: QaRunStage | null;
  target: string;
  tested_revision?: string;
  mode: "signoff" | "review";
  /** The authoritative planner manifest, null when planning itself failed. */
  qa_plan: QaManifest | null;
  /** Merged coverage in manifest order (manifest contexts first). */
  contexts: QaRunContext[];
  commands: QaRunCommandOutcome[];
  critique: QaRunCritiqueOutcome[];
  /** Present once the judge stage ran (even when it skipped for lack of a
   * provider); absent when the run stopped before it. */
  critique_pool?: QaRunCritiquePool;
  /** Present once the capture stage wrote at least one context. */
  review_pack?: QaRunReviewPack;
  snapshot: { saved: boolean; path?: string };
  wall_time_ms: {
    plan: number;
    gates: number;
    interactions: number;
    /** Browser time: rendering every context into the review pack. */
    capture: number;
    /** Judge time: vision calls over the pack, no browser open. */
    critique: number;
    snapshot: number;
    /** Runner stages only — admission queue wait is deliberately excluded
     * (see `queue`) so total stays pure runner time. */
    total: number;
    /** Milliseconds spent waiting for a machine-wide admission slot before
     * any browser work. Absent when the run did not queue. */
    queue?: number;
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
        if (c?.args !== undefined && !isStringArray(c.args)) {
          errors.push(`contexts[${i}].args must be an argument array (never a shell string)`);
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
    if (p?.run_deadline_ms !== undefined) {
      const n = p.run_deadline_ms;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 10_000) {
        errors.push("policy.run_deadline_ms must be an integer ≥ 10000");
      }
    }
    if (p?.critique_max_tiles !== undefined) {
      const n = p.critique_max_tiles;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 200) {
        errors.push("policy.critique_max_tiles must be an integer between 1 and 200");
      }
    }
    if (p?.critique_pool !== undefined) {
      const n = p.critique_pool;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 16) {
        errors.push("policy.critique_pool must be an integer between 1 and 16");
      }
    }
    if (p?.review_pack_retention_minutes !== undefined) {
      const n = p.review_pack_retention_minutes;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 43_200) {
        errors.push("policy.review_pack_retention_minutes must be an integer between 1 and 43200");
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
// ---------------------------------------------------------------------------
// Run identity: job digest + evidence assessment
// ---------------------------------------------------------------------------

/** Recursively key-sort plain objects so the digest is stable under key
 * order. Arrays keep their order — it is semantically meaningful (contexts,
 * argv arrays). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = canonicalize(record[key]);
    return sorted;
  }
  return value;
}

/** SHA-256 hex digest over the effective validated job (after the CLI merges
 * its authoritative `target` and `mode`). `policy` is excluded: concurrency,
 * timeout, and metered-critique knobs change how the run executes, not what
 * it proves, and CLI flags mutate them after the job file is read — including
 * them would make the same job file verify differently across invocations. */
export function computeJobDigest(job: QaRunJob): string {
  const { policy: _policy, ...identityBearing } = job;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(identityBearing)))
    .digest("hex");
}

export interface QaEvidenceExpectations {
  /** Exact run ID the caller expects (from the invocation it just made). */
  run_id?: string;
  /** Revision the evidence must have tested. A result whose revision_source
   * is `unknown` cannot satisfy a revision expectation — fail-closed. */
  tested_revision?: string;
  /** Digest of the effective job the evidence must have run. */
  job_digest?: string;
  /** ISO-8601 floor: a run started before this instant is stale. */
  not_started_before?: string;
  /** Maximum age of completed_at in milliseconds, evaluated against `now`. */
  max_age_ms?: number;
  /** Evaluation instant for max_age_ms (ISO-8601; default: current time). */
  now?: string;
  /** Directory the result file was read from. Compared against the recorded
   * run.out_dir: a moved or copied result is not evidence for its new home. */
  found_in_dir?: string;
}

export interface QaEvidenceAssessment {
  fresh: boolean;
  /** Empty when fresh; each entry names one independent staleness reason. */
  reasons: string[];
  run?: QaRunIdentity;
  verdict?: QaRunVerdict;
}

/**
 * Assess whether a result document is fresh evidence for the invocation the
 * caller has in mind. Fail-closed: a document without a verifiable identity
 * block (schema v1 or foreign JSON) is stale by definition, and every
 * expectation mismatch is reported, not just the first.
 */
export function assessQaRunEvidence(
  document: unknown,
  expectations: QaEvidenceExpectations = {},
): QaEvidenceAssessment {
  const reasons: string[] = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { fresh: false, reasons: ["document is not a result object"] };
  }
  const result = document as Partial<QaRunResult> & Record<string, unknown>;
  if (result.schema_version !== QA_RUN_RESULT_SCHEMA_VERSION) {
    return {
      fresh: false,
      reasons: [
        `schema_version is ${JSON.stringify(result.schema_version)}, not ` +
          `${QA_RUN_RESULT_SCHEMA_VERSION} — pre-identity results carry nothing to verify`,
      ],
    };
  }
  const run = result.run;
  if (
    !run ||
    typeof run.run_id !== "string" ||
    typeof run.started_at !== "string" ||
    typeof run.completed_at !== "string" ||
    typeof run.job_digest !== "string"
  ) {
    return { fresh: false, reasons: ["result carries no complete run-identity block"] };
  }
  if (expectations.run_id !== undefined && run.run_id !== expectations.run_id) {
    reasons.push(`run_id ${run.run_id} is not the expected ${expectations.run_id}`);
  }
  if (expectations.job_digest !== undefined && run.job_digest !== expectations.job_digest) {
    reasons.push("job_digest does not match the expected job definition");
  }
  if (expectations.tested_revision !== undefined) {
    if (run.revision_source === "unknown" || run.tested_revision === undefined) {
      reasons.push(
        `a revision expectation was given but the run recorded revision_source "unknown"`,
      );
    } else if (run.tested_revision !== expectations.tested_revision) {
      reasons.push(
        `tested_revision ${run.tested_revision} is not the expected ${expectations.tested_revision}`,
      );
    }
  }
  if (expectations.not_started_before !== undefined) {
    if (Date.parse(run.started_at) < Date.parse(expectations.not_started_before)) {
      reasons.push(
        `run started ${run.started_at}, before the freshness floor ${expectations.not_started_before}`,
      );
    }
  }
  if (expectations.max_age_ms !== undefined) {
    const now = expectations.now !== undefined ? Date.parse(expectations.now) : Date.now();
    const age = now - Date.parse(run.completed_at);
    if (Number.isNaN(age) || age > expectations.max_age_ms) {
      reasons.push(
        `run completed ${run.completed_at}, older than the ${expectations.max_age_ms}ms maximum age`,
      );
    }
  }
  if (expectations.found_in_dir !== undefined && run.out_dir !== expectations.found_in_dir) {
    reasons.push(
      `result was found in ${expectations.found_in_dir} but records out_dir ${run.out_dir} — ` +
        "a moved or copied result is not evidence for its new location",
    );
  }
  return {
    fresh: reasons.length === 0,
    reasons,
    run: run as QaRunIdentity,
    ...(result.verdict !== undefined ? { verdict: result.verdict } : {}),
  };
}

export function computeVerdict(input: {
  mode: QaRunJob["mode"];
  blockers: QaRunBlocker[];
  commands: QaRunCommandOutcome[];
  critique: QaRunCritiqueOutcome[];
  snapshotSaved: boolean;
  /** Defaults to `runner`. `manual` caps the verdict at incomplete. */
  evidenceSource?: QaRunEvidenceSource;
}): QaRunVerdict {
  const failed =
    input.commands.some((command) => command.outcome === "failed") ||
    input.critique.some((entry) => entry.outcome === "failed");
  if (failed) return "failed";
  // Hand-recorded evidence can prove a defect but never its absence: nothing
  // re-executable ran, so a manual result stops at incomplete by contract.
  if (input.evidenceSource === "manual") return "incomplete";
  const unknown =
    input.commands.some((command) => command.outcome === "unknown") ||
    input.critique.some((entry) => entry.outcome === "unknown");
  if (input.blockers.length > 0 || unknown) return "incomplete";
  if (input.mode === "signoff" && !input.snapshotSaved) return "incomplete";
  return "passed";
}
