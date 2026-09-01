// `qa-record <target>`: record hand-performed page QA as a standard result
// document. When the matrix runner cannot run — host thrash, a lost bridge, an
// interaction no runner can drive — an agent does the checks by hand. Today
// that produces prose, which no consumer can verify. This command turns those
// hand-performed checks into the SAME artifact qa-run emits, so qa-verify and
// qa-status work on it identically.
//
// One rule is load-bearing and enforced here, not in prose: a manual result
// can report a defect but can never read `passed`. Every record carries a
// `validate` blocker naming the reason the runner was unavailable, and the
// verdict is computed with evidenceSource "manual", which caps at incomplete.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { recordQaSignal } from "../core/agents/qa-signal.ts";
import {
  QA_RUN_RESULT_FILENAME,
  QA_RUN_STATUS_FILENAME,
  writeLatestPointer,
} from "../lib/browser/qa-run.ts";
import {
  computeJobDigest,
  computeVerdict,
  QA_RUN_JOB_SCHEMA_VERSION,
  QA_RUN_RESULT_SCHEMA_VERSION,
  QA_RUN_STATUS_SCHEMA_VERSION,
  type QaRunBlocker,
  type QaRunCommandOutcome,
  type QaRunContext,
  type QaRunHostSample,
  type QaRunJob,
  type QaRunResult,
  type QaRunStatusDocument,
  validateQaRunJob,
} from "../lib/browser/qa-run-contracts.ts";

export const QA_RECORD_EVIDENCE_SCHEMA_VERSION = 1 as const;

/** The evidence document is copied into the run directory beside the result:
 * the run identity's job_digest is taken over it, so without the copy nothing
 * downstream could re-derive the digest. qa-run writes `job.json` for the same
 * reason; the manual name keeps the two from being confused. */
export const QA_RECORD_EVIDENCE_FILENAME = "manual-evidence.json";

/** argv marker for a hand-performed check. The contract types argv as a string
 * array and consumers print it, so an empty array would render as a command
 * that ran with no arguments. A single explicit marker reads as "no process
 * executed" and can never be mistaken for a re-runnable command line. */
export const QA_RECORD_MANUAL_ARGV = ["<manual>"] as const;

export type QaManualOutcome = "passed" | "failed" | "unknown";

/** One check a human or agent performed by hand. */
export interface QaManualCheck {
  /** Context the check was performed in; matches a `contexts[].id` when the
   * document declares contexts. */
  context_id: string;
  /** Stable check identifier. Prefix with `manual:` by convention. */
  check_id: string;
  outcome: QaManualOutcome;
  /** What the recorder observed. Carried into the result's `failures` field. */
  notes?: string[];
  /** Files that back the observation. Every path must exist on disk. */
  artifacts?: { png?: string; html?: string; json?: string };
  /** Time the check took, when the recorder measured it. */
  wall_time_ms?: number;
}

export interface QaManualEvidence {
  schema_version: typeof QA_RECORD_EVIDENCE_SCHEMA_VERSION;
  /** Who performed the checks (agent name or operator identity). */
  recorded_by: string;
  /** Why the runner could not be used. Required: a hand record with no stated
   * reason is an assertion, not evidence. */
  reason: string;
  checks: QaManualCheck[];
  /** Declared contexts. Absent: derived from the checks' context IDs. */
  contexts?: QaRunContext[];
}

export type QaManualEvidenceValidation =
  | { ok: true; evidence: QaManualEvidence }
  | { ok: false; errors: string[] };

const ARTIFACT_KINDS = ["png", "html", "json"] as const;

/** Artifact paths are resolved against the directory holding the evidence
 * document, not the working directory: an evidence file names the captures
 * sitting beside it, and that stays true wherever it is recorded from. */
export function resolveArtifactPath(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Reuse the job validator's credential scan rather than duplicating its
 * patterns: the evidence document is nested under a minimal valid job, so
 * every error the validator can return for that probe comes from the secret
 * scan. Paths are rewritten back to the evidence document's own namespace. */
function scanEvidenceForSecrets(document: unknown): string[] {
  const probe = {
    schema_version: QA_RUN_JOB_SCHEMA_VERSION,
    target: "qa-record",
    mode: "review",
    evidence: document,
  };
  const validation = validateQaRunJob(probe);
  if (validation.ok) return [];
  return validation.errors.map((message) => message.replace(/^job\.evidence/, "evidence"));
}

/**
 * Validate an untrusted evidence document. Every structural problem, every
 * missing artifact, and every secret-bearing field is reported at once, before
 * anything is written: a caller fixes the document in one pass, and a
 * half-valid record never reaches disk.
 */
export function validateManualEvidence(
  value: unknown,
  options: { baseDir: string },
): QaManualEvidenceValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["evidence must be a JSON object"] };
  }
  const document = value as Record<string, unknown>;

  if (document.schema_version !== QA_RECORD_EVIDENCE_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${QA_RECORD_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (typeof document.recorded_by !== "string" || document.recorded_by.length === 0) {
    errors.push("recorded_by is required (the agent or operator who performed the checks)");
  }
  if (typeof document.reason !== "string" || document.reason.length === 0) {
    errors.push(
      "reason is required: name why the runner could not be used — a hand record with " +
        "no stated reason is an assertion, not evidence",
    );
  }

  const declaredContextIds = new Set<string>();
  if (document.contexts !== undefined) {
    if (!Array.isArray(document.contexts)) {
      errors.push("contexts must be an array");
    } else {
      document.contexts.forEach((entry, i) => {
        const context = entry as Record<string, unknown>;
        if (typeof context?.id !== "string" || context.id.length === 0) {
          errors.push(`contexts[${i}].id is required`);
        } else if (declaredContextIds.has(context.id)) {
          errors.push(`contexts[${i}].id duplicates "${context.id}"`);
        } else {
          declaredContextIds.add(context.id);
        }
        if (typeof context?.viewport !== "string" || context.viewport.length === 0) {
          errors.push(`contexts[${i}].viewport is required`);
        }
        if (context?.theme !== "light" && context?.theme !== "dark") {
          errors.push(`contexts[${i}].theme must be "light" or "dark"`);
        }
        if (typeof context?.state !== "string" || context.state.length === 0) {
          errors.push(`contexts[${i}].state is required ("default" for the plain page)`);
        }
      });
    }
  }

  if (!Array.isArray(document.checks) || document.checks.length === 0) {
    errors.push(
      "checks must be a non-empty array: a record with no checks proves nothing about the page",
    );
  } else {
    const seen = new Set<string>();
    document.checks.forEach((entry, i) => {
      const check = entry as Record<string, unknown>;
      const contextId = check?.context_id;
      if (typeof contextId !== "string" || contextId.length === 0) {
        errors.push(`checks[${i}].context_id is required`);
      } else if (declaredContextIds.size > 0 && !declaredContextIds.has(contextId)) {
        errors.push(`checks[${i}].context_id "${contextId}" is not a declared context`);
      }
      const checkId = check?.check_id;
      if (typeof checkId !== "string" || checkId.length === 0) {
        errors.push(`checks[${i}].check_id is required`);
      } else if (typeof contextId === "string") {
        const key = `${contextId} ${checkId}`;
        if (seen.has(key)) {
          errors.push(`checks[${i}] duplicates "${checkId}" in context "${contextId}"`);
        }
        seen.add(key);
      }
      if (
        check?.outcome !== "passed" &&
        check?.outcome !== "failed" &&
        check?.outcome !== "unknown"
      ) {
        errors.push(`checks[${i}].outcome must be "passed", "failed", or "unknown"`);
      }
      if (check?.notes !== undefined && !isStringArray(check.notes)) {
        errors.push(`checks[${i}].notes must be an array of strings`);
      }
      if (check?.wall_time_ms !== undefined) {
        const ms = check.wall_time_ms;
        if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
          errors.push(`checks[${i}].wall_time_ms must be a non-negative number of milliseconds`);
        }
      }
      if (check?.artifacts !== undefined) {
        if (
          !check.artifacts ||
          typeof check.artifacts !== "object" ||
          Array.isArray(check.artifacts)
        ) {
          errors.push(`checks[${i}].artifacts must be an object`);
        } else {
          for (const [kind, path] of Object.entries(check.artifacts as Record<string, unknown>)) {
            if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
              errors.push(
                `checks[${i}].artifacts.${kind} is not a recognised artifact kind ` +
                  `(${ARTIFACT_KINDS.join(", ")})`,
              );
              continue;
            }
            if (typeof path !== "string" || path.length === 0) {
              errors.push(`checks[${i}].artifacts.${kind} must be a file path`);
              continue;
            }
            // A named artifact that is not on disk is a validation error, not
            // a warning: an unresolvable path makes the record unverifiable,
            // which is the failure mode this command exists to remove.
            const abs = resolveArtifactPath(options.baseDir, path);
            if (!existsSync(abs)) {
              errors.push(`checks[${i}].artifacts.${kind} does not exist on disk: ${abs}`);
            }
          }
        }
      }
    });
  }

  errors.push(...scanEvidenceForSecrets(document));

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, evidence: value as QaManualEvidence };
}

/** Contexts the result reports: the document's own declarations when it has
 * them, otherwise one derived per distinct check context ID. Derivation reads
 * the runner's `<viewport>-<theme>-<state>` convention when the ID follows it
 * and records `unknown` rather than guessing when it does not. */
export function deriveContexts(evidence: QaManualEvidence): QaRunContext[] {
  if (evidence.contexts && evidence.contexts.length > 0) return evidence.contexts;
  const contexts: QaRunContext[] = [];
  const seen = new Set<string>();
  for (const check of evidence.checks) {
    if (seen.has(check.context_id)) continue;
    seen.add(check.context_id);
    const parts = check.context_id.split("-");
    const theme = parts[1];
    if (parts.length >= 3 && (theme === "light" || theme === "dark")) {
      contexts.push({
        id: check.context_id,
        viewport: parts[0] as string,
        theme,
        state: parts.slice(2).join("-"),
      });
    } else {
      contexts.push({
        id: check.context_id,
        viewport: "unknown",
        theme: "light",
        state: "default",
      });
    }
  }
  return contexts;
}

function hostSample(): QaRunHostSample {
  return {
    captured_at: new Date().toISOString(),
    loadavg_1m: loadavg()[0] ?? 0,
    free_mem_bytes: freemem(),
    total_mem_bytes: totalmem(),
    cpu_count: cpus().length,
  };
}

/** One git probe for the identity block, matching qa-run. Failure is not an
 * error: work outside any repository legitimately records "unknown". */
export function probeRevision():
  | { tested_revision?: string; worktree_dirty?: boolean }
  | undefined {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { tested_revision: head, worktree_dirty: porcelain.trim().length > 0 };
  } catch {
    return undefined;
  }
}

export interface BuildManualResultInput {
  evidence: QaManualEvidence;
  target: string;
  mode: "signoff" | "review";
  /** Parent directory; the result lands in `<outParent>/run-<run_id>/`. */
  outParent: string;
  /** Pre-minted run ID (tests); default crypto.randomUUID. */
  runId?: string;
  /** Directory the artifact paths resolve against (the evidence file's dir). */
  baseDir: string;
  revisionProbe?: { tested_revision?: string; worktree_dirty?: boolean };
  /** Completion instant (tests); default now. */
  completedAt?: Date;
}

/**
 * Build the QaRunResult for a validated evidence document. Pure apart from the
 * host sample and the clock, so the shape is testable without touching disk.
 */
export function buildManualResult(input: BuildManualResultInput): QaRunResult {
  const runId = input.runId ?? randomUUID();
  const outDir = join(resolve(input.outParent), `run-${runId}`);

  const commands: QaRunCommandOutcome[] = input.evidence.checks.map((check) => {
    const artifacts: QaRunCommandOutcome["artifacts"] = {};
    for (const kind of ARTIFACT_KINDS) {
      const path = check.artifacts?.[kind];
      if (path !== undefined) artifacts[kind] = resolveArtifactPath(input.baseDir, path);
    }
    return {
      context_id: check.context_id,
      check_id: check.check_id,
      argv: [...QA_RECORD_MANUAL_ARGV],
      exit_code: null,
      outcome: check.outcome,
      // `failures` is the contract's only free-text field per command, so the
      // recorder's notes land there whatever the outcome. Dropping the notes
      // of a passing check would discard the observation that backs it.
      failures: check.notes ?? [],
      artifacts,
      wall_time_ms: check.wall_time_ms ?? 0,
    };
  });

  const total = commands.reduce((sum, command) => sum + command.wall_time_ms, 0);
  const completedAt = input.completedAt ?? new Date();
  // The identity interval covers the hand-performed work rather than the few
  // milliseconds this command took: a reader comparing started_at against a
  // freshness floor should see when the checking happened, not when it was
  // typed up. Stage buckets stay zero — no runner stage executed.
  const startedAt = new Date(completedAt.getTime() - total);

  const revision: Pick<
    QaRunResult["run"],
    "tested_revision" | "revision_source" | "worktree_dirty"
  > =
    input.revisionProbe?.tested_revision !== undefined
      ? {
          tested_revision: input.revisionProbe.tested_revision,
          revision_source: "git",
          ...(input.revisionProbe.worktree_dirty !== undefined
            ? { worktree_dirty: input.revisionProbe.worktree_dirty }
            : {}),
        }
      : { revision_source: "unknown" };

  // The digest is taken over the same canonical hashing qa-run uses, with the
  // evidence document standing in for the job: the record's identity is the
  // document it was built from.
  const jobDigest = computeJobDigest({
    schema_version: QA_RUN_JOB_SCHEMA_VERSION,
    target: input.target,
    mode: input.mode,
    evidence: input.evidence,
  } as unknown as QaRunJob);

  const blockers: QaRunBlocker[] = [
    {
      stage: "validate",
      reason:
        `evidence was recorded by hand (${input.evidence.reason}); no re-executable ` +
        "proof exists, so this result cannot read passed",
    },
  ];

  const start = hostSample();
  return {
    schema_version: QA_RUN_RESULT_SCHEMA_VERSION,
    evidence_source: "manual",
    run: {
      run_id: runId,
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      ...revision,
      job_digest: jobDigest,
      out_dir: outDir,
    },
    host: { start, finish: hostSample() },
    last_completed_stage: null,
    target: input.target,
    ...(revision.tested_revision !== undefined
      ? { tested_revision: revision.tested_revision }
      : {}),
    mode: input.mode,
    qa_plan: null,
    contexts: deriveContexts(input.evidence),
    commands,
    critique: [],
    snapshot: { saved: false },
    wall_time_ms: {
      plan: 0,
      gates: 0,
      interactions: 0,
      critique: 0,
      snapshot: 0,
      total,
    },
    blockers,
    verdict: computeVerdict({
      mode: input.mode,
      blockers,
      commands,
      critique: [],
      snapshotSaved: false,
      evidenceSource: "manual",
    }),
  };
}

export interface QaRecordWritePaths {
  runDir: string;
  resultPath: string;
  evidencePath: string;
  statusPath: string;
  latestPath: string;
}

/**
 * Write the run directory exactly the way the runner does: the result, the
 * source document, a terminal status document, and the parent's latest.json
 * pointer written temp-then-rename so a reader never sees a torn write.
 */
export function writeManualRun(
  result: QaRunResult,
  evidence: QaManualEvidence,
): QaRecordWritePaths {
  const runDir = result.run.out_dir;
  const outParent = dirname(runDir);
  mkdirSync(runDir, { recursive: true });

  const evidencePath = join(runDir, QA_RECORD_EVIDENCE_FILENAME);
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  const resultPath = join(runDir, QA_RUN_RESULT_FILENAME);
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  const status: QaRunStatusDocument = {
    schema_version: QA_RUN_STATUS_SCHEMA_VERSION,
    run_id: result.run.run_id,
    pid: process.pid,
    state: "completed",
    stage: null,
    started_at: result.run.started_at,
    updated_at: result.run.completed_at,
    verdict: result.verdict,
  };
  const statusPath = join(runDir, QA_RUN_STATUS_FILENAME);
  const statusTmp = join(runDir, `.${QA_RUN_STATUS_FILENAME}.tmp`);
  writeFileSync(statusTmp, `${JSON.stringify(status, null, 2)}\n`);
  renameSync(statusTmp, statusPath);

  const latestPath = writeLatestPointer(outParent, {
    run_id: result.run.run_id,
    dir: basename(runDir),
    completed_at: result.run.completed_at,
    verdict: result.verdict,
  });

  return { runDir, resultPath, evidencePath, statusPath, latestPath };
}

export interface QaRecordOutcome {
  /** 1 usage or validation error · 2 verdict failed · 4 verdict incomplete.
   * Never 0: a hand-recorded result cannot report a pass. */
  exit: 1 | 2 | 4;
  result?: QaRunResult;
  paths?: QaRecordWritePaths;
  error?: string;
  /** Individual validation errors, all of them, when the document was bad. */
  evidenceErrors?: string[];
}

export interface QaRecordInput {
  target: string;
  evidencePath: string;
  mode?: string;
  outDir?: string;
  runId?: string;
  completedAt?: Date;
  /** Injectable for tests; default: the real git probe. */
  revisionProbe?: () => { tested_revision?: string; worktree_dirty?: boolean } | undefined;
}

/**
 * Pure core of qa-record: read the evidence document, validate it completely,
 * build the result, and write the run directory. The commander action is a
 * thin wrapper over this so the whole path tests without a CLI harness.
 */
export function recordManualQa(input: QaRecordInput): QaRecordOutcome {
  const mode = input.mode ?? "review";
  if (mode !== "signoff" && mode !== "review") {
    return { exit: 1, error: '--mode must be "signoff" or "review"' };
  }
  const evidenceAbs = resolve(input.evidencePath);
  let raw: string;
  try {
    raw = readFileSync(evidenceAbs, "utf8");
  } catch (err: unknown) {
    return {
      exit: 1,
      error: `cannot read --evidence file ${evidenceAbs}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    return {
      exit: 1,
      error: `--evidence file ${evidenceAbs} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const baseDir = dirname(evidenceAbs);
  const validation = validateManualEvidence(parsed, { baseDir });
  if (!validation.ok) {
    return {
      exit: 1,
      error: `evidence validation failed with ${validation.errors.length} error${validation.errors.length === 1 ? "" : "s"}`,
      evidenceErrors: validation.errors,
    };
  }

  const probe = (input.revisionProbe ?? probeRevision)();
  const result = buildManualResult({
    evidence: validation.evidence,
    target: input.target,
    mode,
    outParent: input.outDir ?? ".qa-run",
    baseDir,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(probe ? { revisionProbe: probe } : {}),
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
  });
  const paths = writeManualRun(result, validation.evidence);
  return { exit: result.verdict === "failed" ? 2 : 4, result, paths };
}

interface QaRecordOpts {
  evidence?: string;
  mode: string;
  outDir?: string;
  json?: boolean;
}

export function registerQaRecordCommand(program: Command, emit: EmitContext): void {
  program
    .command("qa-record <target>")
    .description(
      "Record hand-performed page QA as a standard result document. Writes the " +
        "same page-qa-result.json shape, run identity, and timing block the matrix " +
        "runner writes, marked evidence_source manual, so qa-verify and qa-status " +
        "treat it like any other result. A manual record can report a defect but " +
        "never a pass.",
    )
    .option(
      "--evidence <file>",
      "Evidence document (JSON) describing the checks that were performed by hand, " +
        "who performed them, and why the runner could not be used. Required.",
    )
    .option(
      "--mode <mode>",
      "signoff or review. A manual record never saves a QA snapshot either way.",
      "review",
    )
    .option(
      "--out-dir <dir>",
      "PARENT output directory (default: .qa-run under the current directory). The " +
        "record lands in its own run-<run_id>/ beneath it and updates the parent's " +
        "latest.json pointer, exactly like a runner invocation.",
    )
    .option("--json", "Print the full result JSON to stdout.")
    .addHelpText(
      "after",
      "\nReach for this only when the matrix runner cannot run: host thrash, a lost " +
        "bridge, or an interaction no runner can drive. Artifact paths in the evidence " +
        "document must exist on disk, and secret-bearing fields are refused." +
        "\n\nExit codes: 1 usage or evidence-validation error · 2 verdict failed · " +
        "4 verdict incomplete. Never 0 — hand-recorded evidence can prove a defect " +
        "but never its absence, so the verdict caps at incomplete.",
    )
    .action((target: string, opts: QaRecordOpts) => {
      if (!opts.evidence) {
        emit.error({
          code: "qa_record_missing_evidence",
          message: "--evidence <file> is required: the record IS the evidence document",
        });
        process.exitCode = 1;
        return;
      }
      const outcome = recordManualQa({
        target,
        evidencePath: opts.evidence,
        mode: opts.mode,
        ...(opts.outDir !== undefined ? { outDir: opts.outDir } : {}),
      });
      if (outcome.exit === 1 || !outcome.result || !outcome.paths) {
        for (const message of outcome.evidenceErrors ?? [])
          emit.log(`evidence: ${message}`, "error");
        emit.error({
          code: "qa_record_invalid_evidence",
          message: outcome.error ?? "qa-record could not write the result",
        });
        process.exitCode = 1;
        return;
      }
      const { result, paths } = outcome;
      // Same status surface as a runner result: an operator should see that
      // the latest evidence was hand-recorded, not silently see nothing.
      recordQaSignal(result);
      if (opts.json) emit.data(result);
      for (const blocker of result.blockers) {
        emit.log(`blocker [${blocker.stage}]: ${blocker.reason}`, "warn");
      }
      emit.log(
        `verdict: ${result.verdict} — manual record ${result.run.run_id}, ` +
          `${result.contexts.length} context${result.contexts.length === 1 ? "" : "s"}, ` +
          `${result.commands.length} check${result.commands.length === 1 ? "" : "s"}; ` +
          `result: ${paths.resultPath}`,
        "warn",
      );
      process.exitCode = outcome.exit;
    });
}
