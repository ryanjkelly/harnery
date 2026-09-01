// `qa-verify <path>`: assess whether a qa-run result document is fresh
// evidence for the invocation the caller has in mind. The assessment itself
// is the pure assessQaRunEvidence contract; this command owns path
// resolution (result file, run directory, or run parent via latest.json),
// expectation collection from flags, and exit-code mapping.
//
// Toolkit tier: this module must not import src/core (layering check).

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { QA_RUN_LATEST_FILENAME, QA_RUN_RESULT_FILENAME } from "../lib/browser/qa-run.ts";
import {
  assessQaRunEvidence,
  computeJobDigest,
  type QaEvidenceAssessment,
  type QaEvidenceExpectations,
  validateQaRunJob,
} from "../lib/browser/qa-run-contracts.ts";

export interface QaVerifyOptions {
  /** Exact run ID the evidence must carry (`--run-id`). */
  runId?: string;
  /** Revision the evidence must have tested (`--revision`). */
  revision?: string;
  /** Job file to reconstruct and digest-match (`--job`). */
  job?: string;
  /** Maximum age of completed_at, in minutes (`--max-age`). */
  maxAge?: string;
  /** Emit the assessment as JSON (`--json`). */
  json?: boolean;
}

export interface QaVerifyDeps {
  /** Evaluation instant for --max-age (ISO-8601). Default: current time. */
  now?: string;
}

export interface QaVerifyOutcome {
  /** 0 evidence fresh · 3 stale or unverifiable · 1 usage/unreadable/invalid job. */
  exit: 0 | 1 | 3;
  /** Present whenever the document was resolved and assessed. */
  assessment?: QaEvidenceAssessment;
  /** Absolute path of the result document that was (or would be) assessed. */
  resultPath?: string;
  /** Human-readable failure for exit-1 outcomes. */
  error?: string;
  /** Individual job-validation errors when --job failed validation. */
  jobErrors?: string[];
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type JsonRead = { ok: true; value: unknown } | { ok: false; error: string };

function readJsonFile(path: string): JsonRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: unknown) {
    return { ok: false, error: `cannot read ${path}: ${describeError(err)}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err: unknown) {
    return { ok: false, error: `${path} is not valid JSON: ${describeError(err)}` };
  }
}

type PathResolution = { ok: true; path: string } | { ok: false; error: string };

/** Resolve `<path>` to a result document: a file is the document itself; a
 * directory is a run PARENT when it carries latest.json (follow the pointer's
 * `result` path, relative to the directory) or a run directory when it
 * carries the result file directly. */
function resolveResultPath(inputPath: string): PathResolution {
  const abs = resolve(inputPath);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(abs);
  } catch (err: unknown) {
    return { ok: false, error: `cannot access ${abs}: ${describeError(err)}` };
  }
  if (stats.isFile()) return { ok: true, path: abs };
  if (!stats.isDirectory()) {
    return { ok: false, error: `${abs} is neither a file nor a directory` };
  }
  const pointerPath = join(abs, QA_RUN_LATEST_FILENAME);
  if (existsSync(pointerPath)) {
    const pointer = readJsonFile(pointerPath);
    if (!pointer.ok) return pointer;
    const record =
      pointer.value && typeof pointer.value === "object" && !Array.isArray(pointer.value)
        ? (pointer.value as Record<string, unknown>)
        : {};
    const rel = record.result;
    if (typeof rel !== "string" || rel.length === 0) {
      return { ok: false, error: `${pointerPath} carries no "result" path to follow` };
    }
    return { ok: true, path: resolve(abs, rel) };
  }
  const direct = join(abs, QA_RUN_RESULT_FILENAME);
  if (existsSync(direct)) return { ok: true, path: direct };
  return {
    ok: false,
    error:
      `${abs} is a directory but contains neither ${QA_RUN_LATEST_FILENAME} ` +
      `(expected for a run parent directory) nor ${QA_RUN_RESULT_FILENAME} ` +
      "(expected for a run directory)",
  };
}

/**
 * Pure core of qa-verify: resolve `<path>` to a result document, collect the
 * expectations the flags express, and assess. The commander action is a thin
 * wrapper over this so the resolution and expectation paths test without a
 * CLI harness.
 */
export function resolveAndAssess(
  inputPath: string,
  opts: QaVerifyOptions = {},
  deps: QaVerifyDeps = {},
): QaVerifyOutcome {
  const resolved = resolveResultPath(inputPath);
  if (!resolved.ok) return { exit: 1, error: resolved.error };
  const resultPath = resolved.path;

  const documentRead = readJsonFile(resultPath);
  if (!documentRead.ok) return { exit: 1, error: documentRead.error, resultPath };
  const document = documentRead.value;

  // The directory the document was actually read from. assessQaRunEvidence
  // compares it against the recorded run.out_dir, so a moved or copied
  // result never verifies in its new home.
  const expectations: QaEvidenceExpectations = { found_in_dir: dirname(resultPath) };
  if (opts.runId !== undefined) expectations.run_id = opts.runId;
  if (opts.revision !== undefined) expectations.tested_revision = opts.revision;
  if (opts.maxAge !== undefined) {
    const minutes = Number(opts.maxAge);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { exit: 1, error: "--max-age must be a positive number of minutes", resultPath };
    }
    expectations.max_age_ms = Math.round(minutes * 60_000);
    if (deps.now !== undefined) expectations.now = deps.now;
  }

  if (opts.job !== undefined) {
    const jobRead = readJsonFile(opts.job);
    if (!jobRead.ok) return { exit: 1, error: jobRead.error, resultPath };
    let jobDocument = jobRead.value;
    if (jobDocument && typeof jobDocument === "object" && !Array.isArray(jobDocument)) {
      // Reconstruct the EFFECTIVE job the way qa-run does: the invocation's
      // target and mode are authoritative over the job file's, and the
      // result document is the record of that invocation.
      const resultRecord =
        document && typeof document === "object" && !Array.isArray(document)
          ? (document as Record<string, unknown>)
          : {};
      jobDocument = {
        ...(jobDocument as Record<string, unknown>),
        target: resultRecord.target,
        mode: resultRecord.mode,
      };
    }
    const validation = validateQaRunJob(jobDocument);
    if (!validation.ok) {
      return {
        exit: 1,
        error: `--job file ${opts.job} does not reconstruct a valid job for this result`,
        jobErrors: validation.errors,
        resultPath,
      };
    }
    expectations.job_digest = computeJobDigest(validation.job);
  }

  const assessment = assessQaRunEvidence(document, expectations);
  return { exit: assessment.fresh ? 0 : 3, assessment, resultPath };
}

export function registerQaVerifyCommand(program: Command, emit: EmitContext): void {
  program
    .command("qa-verify <path>")
    .description(
      "Verify that a qa-run result is fresh evidence for a specific invocation: " +
        "match its run identity (run_id, job digest, tested revision, age, and " +
        "recorded output directory) against what the caller expects. Fail-closed: " +
        "a document without a verifiable identity block is stale by definition.",
    )
    .option("--run-id <id>", "Exact run ID the evidence must carry.")
    .option(
      "--revision <sha>",
      "Revision the evidence must have tested. A result whose revision source is " +
        "unknown cannot satisfy this expectation.",
    )
    .option(
      "--job <file>",
      "Job document (JSON) to digest-match. Reconstructed the way qa-run builds the " +
        "effective job: the result's target and mode overlay the file's before " +
        "validation and digesting.",
    )
    .option("--max-age <minutes>", "Maximum age of the run's completed_at, in minutes.")
    .option("--json", "Print the assessment (plus result_path) as JSON.")
    .addHelpText(
      "after",
      "\n<path> may be a result file, a run directory (containing " +
        `${QA_RUN_RESULT_FILENAME}), or a run parent directory (its ` +
        `${QA_RUN_LATEST_FILENAME} pointer is followed).` +
        "\n\nExit codes: 0 evidence fresh · 1 usage, unreadable input, or invalid job · " +
        "3 evidence stale or unverifiable.",
    )
    .action((path: string, opts: QaVerifyOptions) => {
      const outcome = resolveAndAssess(path, opts);
      if (outcome.exit === 1 || !outcome.assessment) {
        for (const message of outcome.jobErrors ?? []) emit.log(`job: ${message}`, "error");
        emit.error({
          code: "qa_verify_error",
          message: outcome.error ?? "qa-verify could not assess the result",
        });
        process.exitCode = 1;
        return;
      }
      const assessment = outcome.assessment;
      if (opts.json) emit.data({ ...assessment, result_path: outcome.resultPath });
      const runId = assessment.run?.run_id ?? "(no identity)";
      const verdict = assessment.verdict ?? "(no verdict)";
      emit.log(
        `run ${runId}: verdict ${verdict} — evidence ${assessment.fresh ? "fresh" : "stale"} ` +
          `(${outcome.resultPath})`,
        assessment.fresh ? "info" : "warn",
      );
      for (const reason of assessment.reasons) emit.log(`stale: ${reason}`, "warn");
      if (!assessment.fresh) process.exitCode = 3;
    });
}
