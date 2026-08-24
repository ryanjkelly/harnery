import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { harneryDir } from "@/lib/coord-reader";

import type { CodecExpression } from "./contracts";
import {
  EXTENDED_EXPRESSIONS,
  packsDir,
  REQUIRED_EXPRESSIONS,
  resolvePackAsset,
  validatePackDir,
} from "./packs";

export const CODEC_COMPREHENSION_SCHEMA_VERSION = 1 as const;
export const CODEC_COMPREHENSION_CHOICES = ["a", "same", "b"] as const;
export const CODEC_COMPREHENSION_CONFIDENCE = ["low", "medium", "high"] as const;

export type CodecComprehensionChoice = (typeof CODEC_COMPREHENSION_CHOICES)[number];
export type CodecComprehensionConfidence = (typeof CODEC_COMPREHENSION_CONFIDENCE)[number];
export type CodecComprehensionSide = "a" | "b";

export interface CodecComprehensionTrial {
  trial_id: string;
  target_expression: CodecExpression;
  comparison_expression: CodecExpression;
  pack_id: string;
  pack_version: string;
  semantic_side: CodecComprehensionSide;
}

export interface CodecComprehensionCohort {
  schema_version: typeof CODEC_COMPREHENSION_SCHEMA_VERSION;
  study_id: string;
  created_at: string;
  source: {
    kind: "semantic-readings";
    accepted_readings: number;
    privacy: "controlled-tokens-only";
  };
  trials: CodecComprehensionTrial[];
}

export interface CodecComprehensionPublicTrial {
  trial_id: string;
  target_expression: CodecExpression;
  image_a_url: string;
  image_b_url: string;
}

export interface CodecComprehensionPublicStudy {
  schema_version: typeof CODEC_COMPREHENSION_SCHEMA_VERSION;
  study_id: string;
  created_at: string;
  accepted_readings: number;
  trials: CodecComprehensionPublicTrial[];
}

export interface CodecComprehensionResponse {
  trial_id: string;
  choice: CodecComprehensionChoice;
  confidence: CodecComprehensionConfidence;
  response_ms: number;
}

export interface CodecComprehensionSubmission {
  schema_version: typeof CODEC_COMPREHENSION_SCHEMA_VERSION;
  study_id: string;
  total_duration_ms: number;
  responses: CodecComprehensionResponse[];
}

export interface CodecComprehensionSummary {
  trial_count: number;
  semantic_preferred: number;
  comparison_preferred: number;
  same: number;
  semantic_share_excluding_ties: number | null;
  by_expression: Partial<
    Record<
      CodecExpression,
      { trials: number; semantic_preferred: number; comparison_preferred: number; same: number }
    >
  >;
}

export interface CodecComprehensionReceipt {
  schema_version: typeof CODEC_COMPREHENSION_SCHEMA_VERSION;
  receipt_id: string;
  study_id: string;
  completed_at: string;
  total_duration_ms: number;
  responses: CodecComprehensionResponse[];
  summary: CodecComprehensionSummary;
}

const STUDY_ID = /^study_[a-f0-9]{16}$/;
const TRIAL_ID = /^trial_[a-f0-9]{16}$/;
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_COHORT_BYTES = 128_000;
const MAX_TRIALS = 24;
const MAX_RESPONSE_MS = 10 * 60_000;
const MAX_TOTAL_DURATION_MS = 2 * 60 * 60_000;
const EXPRESSIONS = new Set<CodecExpression>([...REQUIRED_EXPRESSIONS, ...EXTENDED_EXPRESSIONS]);

export function codecComprehensionDir(runtimeRoot = harneryDir()): string {
  return path.join(runtimeRoot, "semantic", "evaluations");
}

export function codecComprehensionCohortPath(runtimeRoot = harneryDir()): string {
  return path.join(codecComprehensionDir(runtimeRoot), "codec-comprehension-cohort.json");
}

export function readCodecComprehensionCohort(
  runtimeRoot = harneryDir(),
): CodecComprehensionCohort | undefined {
  const target = codecComprehensionCohortPath(runtimeRoot);
  let text: string;
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > MAX_COHORT_BYTES) return undefined;
    text = fs.readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseCodecComprehensionCohort(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function parseCodecComprehensionCohort(value: unknown): CodecComprehensionCohort {
  if (!isRecord(value) || value.schema_version !== CODEC_COMPREHENSION_SCHEMA_VERSION) {
    throw new Error("unsupported comprehension cohort");
  }
  if (!isStudyId(value.study_id) || !isTimestamp(value.created_at)) {
    throw new Error("invalid comprehension cohort identity");
  }
  if (!isRecord(value.source)) throw new Error("invalid comprehension cohort source");
  if (
    value.source.kind !== "semantic-readings" ||
    value.source.privacy !== "controlled-tokens-only" ||
    !isBoundedInteger(value.source.accepted_readings, 1, 10_000)
  ) {
    throw new Error("invalid comprehension cohort source");
  }
  if (!Array.isArray(value.trials) || value.trials.length < 1 || value.trials.length > MAX_TRIALS) {
    throw new Error("invalid comprehension trial count");
  }
  const trials = value.trials.map(parseTrial);
  if (new Set(trials.map((trial) => trial.trial_id)).size !== trials.length) {
    throw new Error("duplicate comprehension trial");
  }
  return {
    schema_version: CODEC_COMPREHENSION_SCHEMA_VERSION,
    study_id: value.study_id,
    created_at: value.created_at,
    source: {
      kind: "semantic-readings",
      accepted_readings: value.source.accepted_readings,
      privacy: "controlled-tokens-only",
    },
    trials,
  };
}

export function publicCodecComprehensionStudy(
  cohort: CodecComprehensionCohort,
): CodecComprehensionPublicStudy {
  return {
    schema_version: CODEC_COMPREHENSION_SCHEMA_VERSION,
    study_id: cohort.study_id,
    created_at: cohort.created_at,
    accepted_readings: cohort.source.accepted_readings,
    trials: cohort.trials.map((trial) => ({
      trial_id: trial.trial_id,
      target_expression: trial.target_expression,
      image_a_url: `/api/codec-evaluation/image/${cohort.study_id}/${trial.trial_id}/a`,
      image_b_url: `/api/codec-evaluation/image/${cohort.study_id}/${trial.trial_id}/b`,
    })),
  };
}

export function resolveCodecComprehensionAsset(
  studyId: string,
  trialId: string,
  side: string,
  runtimeRoot = harneryDir(),
): { filePath: string; contentType: string } | null {
  if (!isStudyId(studyId) || !TRIAL_ID.test(trialId) || (side !== "a" && side !== "b")) {
    return null;
  }
  const cohort = readCodecComprehensionCohort(runtimeRoot);
  if (!cohort || cohort.study_id !== studyId) return null;
  const trial = cohort.trials.find((candidate) => candidate.trial_id === trialId);
  if (!trial) return null;
  const pack = validatePackDir(path.join(packsDir(runtimeRoot), trial.pack_id));
  if (!pack.ok || pack.pack.pack_version !== trial.pack_version) return null;
  const expression = expressionForSide(trial, side);
  return resolvePackAsset(trial.pack_id, expression, runtimeRoot);
}

export function storeCodecComprehensionResult(
  value: unknown,
  runtimeRoot = harneryDir(),
  now = new Date(),
): CodecComprehensionReceipt {
  const cohort = readCodecComprehensionCohort(runtimeRoot);
  if (!cohort) throw new Error("comprehension cohort unavailable");
  const submission = parseSubmission(value, cohort);
  const completedAt = now.toISOString();
  const receiptId = `receipt_${createHash("sha256")
    .update(`${cohort.study_id}:${completedAt}:${randomUUID()}`)
    .digest("hex")
    .slice(0, 16)}`;
  const receipt: CodecComprehensionReceipt = {
    schema_version: CODEC_COMPREHENSION_SCHEMA_VERSION,
    receipt_id: receiptId,
    study_id: cohort.study_id,
    completed_at: completedAt,
    total_duration_ms: submission.total_duration_ms,
    responses: submission.responses,
    summary: summarizeSubmission(cohort, submission.responses),
  };
  const resultsDir = path.join(codecComprehensionDir(runtimeRoot), "results");
  fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  const target = path.join(resultsDir, `${receiptId}.json`);
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
  return receipt;
}

function parseTrial(value: unknown): CodecComprehensionTrial {
  if (!isRecord(value)) throw new Error("invalid comprehension trial");
  if (
    typeof value.trial_id !== "string" ||
    !TRIAL_ID.test(value.trial_id) ||
    !isExpression(value.target_expression) ||
    !isExpression(value.comparison_expression) ||
    value.target_expression === value.comparison_expression ||
    typeof value.pack_id !== "string" ||
    !PACK_ID.test(value.pack_id) ||
    typeof value.pack_version !== "string" ||
    value.pack_version.length < 1 ||
    value.pack_version.length > 32 ||
    (value.semantic_side !== "a" && value.semantic_side !== "b")
  ) {
    throw new Error("invalid comprehension trial");
  }
  return {
    trial_id: value.trial_id,
    target_expression: value.target_expression,
    comparison_expression: value.comparison_expression,
    pack_id: value.pack_id,
    pack_version: value.pack_version,
    semantic_side: value.semantic_side,
  };
}

function parseSubmission(
  value: unknown,
  cohort: CodecComprehensionCohort,
): CodecComprehensionSubmission {
  if (!isRecord(value) || value.schema_version !== CODEC_COMPREHENSION_SCHEMA_VERSION) {
    throw new Error("unsupported comprehension submission");
  }
  if (value.study_id !== cohort.study_id) throw new Error("comprehension study changed");
  if (!isBoundedInteger(value.total_duration_ms, 0, MAX_TOTAL_DURATION_MS)) {
    throw new Error("invalid comprehension duration");
  }
  if (!Array.isArray(value.responses) || value.responses.length !== cohort.trials.length) {
    throw new Error("incomplete comprehension submission");
  }
  const expected = new Set(cohort.trials.map((trial) => trial.trial_id));
  const seen = new Set<string>();
  const responses = value.responses.map((response) => {
    if (!isRecord(response) || typeof response.trial_id !== "string") {
      throw new Error("invalid comprehension response");
    }
    if (!expected.has(response.trial_id) || seen.has(response.trial_id)) {
      throw new Error("unexpected comprehension response");
    }
    if (
      !CODEC_COMPREHENSION_CHOICES.includes(response.choice as CodecComprehensionChoice) ||
      !CODEC_COMPREHENSION_CONFIDENCE.includes(
        response.confidence as CodecComprehensionConfidence,
      ) ||
      !isBoundedInteger(response.response_ms, 0, MAX_RESPONSE_MS)
    ) {
      throw new Error("invalid comprehension response");
    }
    seen.add(response.trial_id);
    return {
      trial_id: response.trial_id,
      choice: response.choice as CodecComprehensionChoice,
      confidence: response.confidence as CodecComprehensionConfidence,
      response_ms: response.response_ms,
    };
  });
  return {
    schema_version: CODEC_COMPREHENSION_SCHEMA_VERSION,
    study_id: cohort.study_id,
    total_duration_ms: value.total_duration_ms,
    responses,
  };
}

function summarizeSubmission(
  cohort: CodecComprehensionCohort,
  responses: CodecComprehensionResponse[],
): CodecComprehensionSummary {
  const byTrial = new Map(cohort.trials.map((trial) => [trial.trial_id, trial]));
  let semanticPreferred = 0;
  let comparisonPreferred = 0;
  let same = 0;
  const byExpression: CodecComprehensionSummary["by_expression"] = {};
  for (const response of responses) {
    const trial = byTrial.get(response.trial_id);
    if (!trial) continue;
    let row = byExpression[trial.target_expression];
    if (!row) {
      row = {
        trials: 0,
        semantic_preferred: 0,
        comparison_preferred: 0,
        same: 0,
      };
      byExpression[trial.target_expression] = row;
    }
    row.trials += 1;
    if (response.choice === "same") {
      same += 1;
      row.same += 1;
    } else if (response.choice === trial.semantic_side) {
      semanticPreferred += 1;
      row.semantic_preferred += 1;
    } else {
      comparisonPreferred += 1;
      row.comparison_preferred += 1;
    }
  }
  const directional = semanticPreferred + comparisonPreferred;
  return {
    trial_count: responses.length,
    semantic_preferred: semanticPreferred,
    comparison_preferred: comparisonPreferred,
    same,
    semantic_share_excluding_ties:
      directional === 0 ? null : Math.round((semanticPreferred / directional) * 10_000) / 10_000,
    by_expression: byExpression,
  };
}

function expressionForSide(
  trial: CodecComprehensionTrial,
  side: CodecComprehensionSide,
): CodecExpression {
  return trial.semantic_side === side ? trial.target_expression : trial.comparison_expression;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStudyId(value: unknown): value is string {
  return typeof value === "string" && STUDY_ID.test(value);
}

function isExpression(value: unknown): value is CodecExpression {
  return typeof value === "string" && EXPRESSIONS.has(value as CodecExpression);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}
