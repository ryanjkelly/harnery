import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  SemanticAcceptedReadModelV2,
  SemanticConfiguredModel,
  SemanticEvidenceObservationV1,
  SemanticEvidenceV1,
  SemanticExpressionCue,
  SemanticHarness,
  SemanticMeaningV2,
  SemanticPhase,
  SemanticTag,
} from "./contract.ts";
import {
  SEMANTIC_EXPRESSION_CUES,
  SEMANTIC_HARNESSES,
  SEMANTIC_PHASES,
  SEMANTIC_TAGS,
} from "./contract.ts";
import { buildSemanticEvidenceV1 } from "./evidence.ts";
import { listSemanticAgentDocuments } from "./storage.ts";

export const SEMANTIC_REVIEW_SCHEMA_VERSION = 1 as const;
export const SEMANTIC_REVIEW_OVERALL_VERDICTS = ["correct", "close", "wrong", "unsure"] as const;
export const SEMANTIC_REVIEW_FIELD_VERDICTS = ["correct", "wrong", "unsure"] as const;
export const SEMANTIC_REVIEW_PORTRAIT_VERDICTS = ["helpful", "neutral", "misleading"] as const;
export const SEMANTIC_REVIEW_TRANSITION_VERDICTS = ["real-change", "flicker", "unsure"] as const;
export const SEMANTIC_REVIEW_CONFIDENCE = ["low", "medium", "high"] as const;
export const SEMANTIC_REVIEW_NO_EXPRESSION = "none" as const;

export type SemanticReviewOverallVerdict = (typeof SEMANTIC_REVIEW_OVERALL_VERDICTS)[number];
export type SemanticReviewFieldVerdict = (typeof SEMANTIC_REVIEW_FIELD_VERDICTS)[number];
export type SemanticReviewPortraitVerdict = (typeof SEMANTIC_REVIEW_PORTRAIT_VERDICTS)[number];
export type SemanticReviewTransitionVerdict = (typeof SEMANTIC_REVIEW_TRANSITION_VERDICTS)[number];
export type SemanticReviewConfidence = (typeof SEMANTIC_REVIEW_CONFIDENCE)[number];
export type SemanticReviewExpression = SemanticExpressionCue | typeof SEMANTIC_REVIEW_NO_EXPRESSION;

export interface SemanticReviewObservationV1 {
  kind: string;
  observed_at: string;
  label?: string;
  outcome?: string;
  error_class?: string;
}

export interface SemanticReviewEvidenceSnapshotV1 {
  observed_through_ts: string;
  task?: string;
  lifecycle?: string;
  intent?: string;
  operation?: { category: string; label: string };
  waits: Array<{ kind: string; started_at: string }>;
  recent: SemanticReviewObservationV1[];
  attention?: SemanticReviewObservationV1;
}

export interface SemanticReviewProposalFieldV1<T> {
  value: T;
  confidence: "high" | "medium" | "low";
}

export interface SemanticReviewProposalV1 {
  headline: SemanticReviewProposalFieldV1<string>;
  summary: SemanticReviewProposalFieldV1<string>;
  phase: SemanticReviewProposalFieldV1<SemanticPhase>;
  expression_cue?: SemanticReviewProposalFieldV1<SemanticExpressionCue>;
  purpose?: SemanticReviewProposalFieldV1<string>;
  recent_result?: SemanticReviewProposalFieldV1<string>;
  attention?: SemanticReviewProposalFieldV1<string>;
  next_step?: SemanticReviewProposalFieldV1<string>;
  tags?: SemanticReviewProposalFieldV1<SemanticTag[]>;
}

export interface SemanticReviewCandidateV1 {
  schema_version: typeof SEMANTIC_REVIEW_SCHEMA_VERSION;
  candidate_id: string;
  subject_id: string;
  captured_at: string;
  source: {
    evidence_digest: `sha256:${string}`;
    observed_through_ts: string;
    generated_at: string;
    harness: SemanticHarness;
    configured_model: SemanticConfiguredModel;
    resolved_model_id: string;
    model_attestation: "verified" | "requested-only";
  };
  evidence: SemanticReviewEvidenceSnapshotV1;
  proposal: SemanticReviewProposalV1;
}

export interface SemanticReviewStudyCandidateV1 {
  candidate: SemanticReviewCandidateV1;
  previous?: SemanticReviewCandidateV1;
  transition_required: boolean;
}

export interface SemanticReviewStudyV1 {
  schema_version: typeof SEMANTIC_REVIEW_SCHEMA_VERSION;
  study_id: string;
  prepared_at: string;
  total_candidate_count: number;
  reviewed_candidate_count: number;
  pending_candidate_count: number;
  candidates: SemanticReviewStudyCandidateV1[];
}

export interface SemanticReviewResponseV1 {
  candidate_id: string;
  overall: SemanticReviewOverallVerdict;
  phase: SemanticReviewFieldVerdict;
  expected_phase?: SemanticPhase;
  expression: SemanticReviewFieldVerdict;
  expected_expression?: SemanticReviewExpression;
  portrait_usefulness: SemanticReviewPortraitVerdict;
  transition?: SemanticReviewTransitionVerdict;
  confidence: SemanticReviewConfidence;
  response_ms: number;
}

export interface SemanticReviewSubmissionV1 {
  schema_version: typeof SEMANTIC_REVIEW_SCHEMA_VERSION;
  study_id: string;
  total_duration_ms: number;
  responses: SemanticReviewResponseV1[];
}

export interface SemanticReviewReceiptRowV1 extends SemanticReviewResponseV1 {
  subject_id: string;
  candidate_generated_at: string;
  source_harness: SemanticHarness;
  configured_model: SemanticConfiguredModel;
  resolved_model_id: string;
  model_attestation: "verified" | "requested-only";
  proposed_phase: SemanticPhase;
  proposed_expression: SemanticReviewExpression;
}

export interface SemanticReviewReceiptV1 {
  schema_version: typeof SEMANTIC_REVIEW_SCHEMA_VERSION;
  receipt_id: string;
  study_id: string;
  completed_at: string;
  total_duration_ms: number;
  responses: SemanticReviewReceiptRowV1[];
  summary: {
    reviewed: number;
    overall: Record<SemanticReviewOverallVerdict, number>;
    phase: Record<SemanticReviewFieldVerdict, number>;
    expression: Record<SemanticReviewFieldVerdict, number>;
    portrait_usefulness: Record<SemanticReviewPortraitVerdict, number>;
    transitions: Record<SemanticReviewTransitionVerdict, number>;
  };
}

const MAX_JSON_BYTES = 512 * 1024;
const MAX_CANDIDATES = 100;
const MAX_CANDIDATE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_RECEIPTS = 1_000;
const MAX_RECEIPT_AGE_MS = 365 * 24 * 60 * 60 * 1_000;
const DEFAULT_STUDY_SIZE = 12;
const MAX_STUDY_SIZE = 24;
const MAX_RESPONSE_MS = 10 * 60_000;
const MAX_TOTAL_DURATION_MS = 2 * 60 * 60_000;
const CANDIDATE_ID = /^candidate_[a-f0-9]{16}$/;
const SUBJECT_ID = /^subject_[a-f0-9]{16}$/;
const STUDY_ID = /^study_[a-f0-9]{16}$/;
const RECEIPT_ID = /^review_[a-f0-9]{16}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const configuredModels = new Set<SemanticConfiguredModel>([
  "haiku-4.5",
  "gpt-5.6-luna",
  "composer-2.5",
]);
const phases = new Set<SemanticPhase>(SEMANTIC_PHASES);
const expressions = new Set<SemanticExpressionCue>(SEMANTIC_EXPRESSION_CUES);
const tags = new Set<SemanticTag>(SEMANTIC_TAGS);

export function semanticReviewPaths(coordRootRaw: string) {
  const root = join(resolve(coordRootRaw), ".harnery", "semantic", "evaluations", "meaning");
  return {
    root,
    candidates: join(root, "candidates"),
    receipts: join(root, "receipts"),
  };
}

export function captureSemanticReviewCandidate(
  coordRootRaw: string,
  evidence: SemanticEvidenceV1,
  document: SemanticAcceptedReadModelV2,
): SemanticReviewCandidateV1 {
  if (
    document.reader_outcome !== "accepted" ||
    document.source.evidence_digest !== evidence.evidence_digest ||
    document.generation_id !== evidence.generation_id ||
    document.instance_id !== evidence.instance_id
  ) {
    throw new Error("semantic review candidate does not match accepted evidence");
  }
  const subjectId = opaqueId("subject", {
    ledger_genesis_id: evidence.source.ledger_genesis_id,
    instance_id: evidence.instance_id,
  });
  const candidateId = opaqueId("candidate", {
    subject_id: subjectId,
    evidence_digest: evidence.evidence_digest,
    generated_at: document.generated_at,
    reader: document.reader,
    proposal: proposalSnapshot(document.meaning),
  });
  const candidate: SemanticReviewCandidateV1 = {
    schema_version: SEMANTIC_REVIEW_SCHEMA_VERSION,
    candidate_id: candidateId,
    subject_id: subjectId,
    captured_at: document.generated_at,
    source: {
      evidence_digest: evidence.evidence_digest as `sha256:${string}`,
      observed_through_ts: evidence.source.observed_through_ts,
      generated_at: document.generated_at,
      harness: document.reader.harness,
      configured_model: document.reader.configured_model,
      resolved_model_id: document.reader.resolved_model_id,
      model_attestation: document.reader.model_attestation,
    },
    evidence: evidenceSnapshot(evidence),
    proposal: proposalSnapshot(document.meaning),
  };
  const target = join(semanticReviewPaths(coordRootRaw).candidates, `${candidateId}.json`);
  if (!existsSync(target)) writePrivateJsonAtomic(target, candidate);
  pruneSemanticReviewStorage(coordRootRaw);
  return candidate;
}

export function backfillSemanticReviewCandidates(
  coordRootRaw: string,
  now = Date.now(),
): SemanticReviewCandidateV1[] {
  const evidenceByGeneration = new Map(
    buildSemanticEvidenceV1(coordRootRaw, now).map((item) => [item.generation_id, item]),
  );
  const captured: SemanticReviewCandidateV1[] = [];
  for (const document of listSemanticAgentDocuments(coordRootRaw)) {
    if (document.reader_outcome !== "accepted") continue;
    const evidence = evidenceByGeneration.get(document.generation_id);
    if (!evidence || evidence.evidence_digest !== document.source.evidence_digest) continue;
    captured.push(captureSemanticReviewCandidate(coordRootRaw, evidence, document));
  }
  return captured;
}

export function listSemanticReviewCandidates(coordRootRaw: string): SemanticReviewCandidateV1[] {
  const dir = semanticReviewPaths(coordRootRaw).candidates;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^candidate_[a-f0-9]{16}\.json$/.test(name))
    .flatMap((name) => {
      try {
        const value = readBoundedJson<unknown>(join(dir, name), "semantic review candidate");
        return isSemanticReviewCandidate(value) ? [value] : [];
      } catch {
        return [];
      }
    })
    .sort(compareCandidates);
}

export function listSemanticReviewReceipts(coordRootRaw: string): SemanticReviewReceiptV1[] {
  const dir = semanticReviewPaths(coordRootRaw).receipts;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^review_[a-f0-9]{16}\.json$/.test(name))
    .flatMap((name) => {
      try {
        const value = readBoundedJson<unknown>(join(dir, name), "semantic review receipt");
        return isSemanticReviewReceipt(value) ? [value] : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.completed_at.localeCompare(left.completed_at));
}

export function prepareSemanticReviewStudy(
  coordRootRaw: string,
  options: { limit?: number; now?: Date; backfill?: boolean } = {},
): SemanticReviewStudyV1 {
  const now = options.now ?? new Date();
  if (options.backfill !== false) backfillSemanticReviewCandidates(coordRootRaw, now.getTime());
  pruneSemanticReviewStorage(coordRootRaw, now.getTime());
  const all = listSemanticReviewCandidates(coordRootRaw);
  const reviewed = reviewedCandidateIds(listSemanticReviewReceipts(coordRootRaw));
  const pending = all.filter((candidate) => !reviewed.has(candidate.candidate_id));
  const limit = Math.min(MAX_STUDY_SIZE, Math.max(1, options.limit ?? DEFAULT_STUDY_SIZE));
  const ranked = pending
    .map((candidate) => {
      const previous = previousCandidate(candidate, all);
      return {
        candidate,
        ...(previous ? { previous } : {}),
        transition_required: semanticTransitionChanged(candidate, previous),
      } satisfies SemanticReviewStudyCandidateV1;
    })
    .sort((left, right) => {
      if (left.transition_required !== right.transition_required) {
        return left.transition_required ? -1 : 1;
      }
      const leftCue = left.candidate.proposal.expression_cue ? 1 : 0;
      const rightCue = right.candidate.proposal.expression_cue ? 1 : 0;
      return rightCue - leftCue || compareCandidates(left.candidate, right.candidate);
    })
    .slice(0, limit);
  return {
    schema_version: SEMANTIC_REVIEW_SCHEMA_VERSION,
    study_id: studyId(ranked.map((item) => item.candidate.candidate_id)),
    prepared_at: now.toISOString(),
    total_candidate_count: all.length,
    reviewed_candidate_count: reviewed.size,
    pending_candidate_count: pending.length,
    candidates: ranked,
  };
}

export function storeSemanticReviewSubmission(
  coordRootRaw: string,
  value: unknown,
  now = new Date(),
): SemanticReviewReceiptV1 {
  const all = listSemanticReviewCandidates(coordRootRaw);
  const byId = new Map(all.map((candidate) => [candidate.candidate_id, candidate]));
  const alreadyReviewed = reviewedCandidateIds(listSemanticReviewReceipts(coordRootRaw));
  const submission = parseSubmission(value, byId, all, alreadyReviewed);
  const completedAt = now.toISOString();
  const rows = submission.responses.map((response): SemanticReviewReceiptRowV1 => {
    const candidate = byId.get(response.candidate_id)!;
    return {
      ...response,
      subject_id: candidate.subject_id,
      candidate_generated_at: candidate.source.generated_at,
      source_harness: candidate.source.harness,
      configured_model: candidate.source.configured_model,
      resolved_model_id: candidate.source.resolved_model_id,
      model_attestation: candidate.source.model_attestation,
      proposed_phase: candidate.proposal.phase.value,
      proposed_expression:
        candidate.proposal.expression_cue?.value ?? SEMANTIC_REVIEW_NO_EXPRESSION,
    };
  });
  const receiptId = `review_${createHash("sha256")
    .update(`${submission.study_id}:${completedAt}:${randomUUID()}`)
    .digest("hex")
    .slice(0, 16)}`;
  const receipt: SemanticReviewReceiptV1 = {
    schema_version: SEMANTIC_REVIEW_SCHEMA_VERSION,
    receipt_id: receiptId,
    study_id: submission.study_id,
    completed_at: completedAt,
    total_duration_ms: submission.total_duration_ms,
    responses: rows,
    summary: summarize(rows),
  };
  writePrivateJsonAtomic(
    join(semanticReviewPaths(coordRootRaw).receipts, `${receiptId}.json`),
    receipt,
  );
  pruneSemanticReviewStorage(coordRootRaw, now.getTime());
  return receipt;
}

export function pruneSemanticReviewStorage(coordRootRaw: string, now = Date.now()): void {
  const paths = semanticReviewPaths(coordRootRaw);
  pruneFiles(paths.candidates, MAX_CANDIDATES, MAX_CANDIDATE_AGE_MS, now);
  pruneFiles(paths.receipts, MAX_RECEIPTS, MAX_RECEIPT_AGE_MS, now);
}

function evidenceSnapshot(evidence: SemanticEvidenceV1): SemanticReviewEvidenceSnapshotV1 {
  return {
    observed_through_ts: evidence.source.observed_through_ts,
    ...(evidence.task ? { task: evidence.task.value } : {}),
    ...(evidence.lifecycle ? { lifecycle: evidence.lifecycle.state } : {}),
    ...(evidence.intent ? { intent: evidence.intent.kind } : {}),
    ...(evidence.operation
      ? { operation: { category: evidence.operation.category, label: evidence.operation.label } }
      : {}),
    waits: evidence.waits.map((wait) => ({ kind: wait.kind, started_at: wait.started_at })),
    recent: evidence.recent.map(observationSnapshot),
    ...(evidence.attention ? { attention: observationSnapshot(evidence.attention) } : {}),
  };
}

function observationSnapshot(
  observation: SemanticEvidenceObservationV1,
): SemanticReviewObservationV1 {
  return {
    kind: observation.kind,
    observed_at: observation.observed_at,
    ...(observation.label ? { label: observation.label } : {}),
    ...(observation.outcome ? { outcome: observation.outcome } : {}),
    ...(observation.error_class ? { error_class: observation.error_class } : {}),
  };
}

function proposalSnapshot(meaning: SemanticMeaningV2): SemanticReviewProposalV1 {
  return {
    headline: reviewField(meaning.headline),
    summary: reviewField(meaning.summary),
    phase: reviewField(meaning.phase),
    ...(meaning.expression_cue ? { expression_cue: reviewField(meaning.expression_cue) } : {}),
    ...(meaning.purpose ? { purpose: reviewField(meaning.purpose) } : {}),
    ...(meaning.recent_result ? { recent_result: reviewField(meaning.recent_result) } : {}),
    ...(meaning.attention ? { attention: reviewField(meaning.attention) } : {}),
    ...(meaning.next_step ? { next_step: reviewField(meaning.next_step) } : {}),
    ...(meaning.tags ? { tags: reviewField(meaning.tags) } : {}),
  };
}

function reviewField<T>(field: { value: T; confidence: "high" | "medium" | "low" }) {
  return { value: field.value, confidence: field.confidence };
}

function previousCandidate(
  candidate: SemanticReviewCandidateV1,
  all: readonly SemanticReviewCandidateV1[],
): SemanticReviewCandidateV1 | undefined {
  return all
    .filter(
      (other) =>
        other.subject_id === candidate.subject_id &&
        other.candidate_id !== candidate.candidate_id &&
        other.source.generated_at < candidate.source.generated_at,
    )
    .sort(compareCandidates)[0];
}

function semanticTransitionChanged(
  candidate: SemanticReviewCandidateV1,
  previous: SemanticReviewCandidateV1 | undefined,
): boolean {
  if (!previous) return false;
  return (
    candidate.proposal.phase.value !== previous.proposal.phase.value ||
    (candidate.proposal.expression_cue?.value ?? SEMANTIC_REVIEW_NO_EXPRESSION) !==
      (previous.proposal.expression_cue?.value ?? SEMANTIC_REVIEW_NO_EXPRESSION)
  );
}

function parseSubmission(
  value: unknown,
  byId: ReadonlyMap<string, SemanticReviewCandidateV1>,
  all: readonly SemanticReviewCandidateV1[],
  alreadyReviewed: ReadonlySet<string>,
): SemanticReviewSubmissionV1 {
  if (!isRecord(value) || value.schema_version !== SEMANTIC_REVIEW_SCHEMA_VERSION) {
    throw new Error("unsupported semantic review submission");
  }
  if (!isString(value.study_id) || !STUDY_ID.test(value.study_id)) {
    throw new Error("invalid semantic review study");
  }
  if (!isBoundedInteger(value.total_duration_ms, 0, MAX_TOTAL_DURATION_MS)) {
    throw new Error("invalid semantic review duration");
  }
  if (
    !Array.isArray(value.responses) ||
    value.responses.length < 1 ||
    value.responses.length > MAX_STUDY_SIZE
  ) {
    throw new Error("invalid semantic review response count");
  }
  const seen = new Set<string>();
  const responses = value.responses.map((raw): SemanticReviewResponseV1 => {
    if (!isRecord(raw) || !isString(raw.candidate_id) || !CANDIDATE_ID.test(raw.candidate_id)) {
      throw new Error("invalid semantic review response");
    }
    const candidate = byId.get(raw.candidate_id);
    if (!candidate || seen.has(raw.candidate_id))
      throw new Error("unexpected semantic review candidate");
    if (alreadyReviewed.has(raw.candidate_id))
      throw new Error("semantic review candidate already reviewed");
    if (!includes(SEMANTIC_REVIEW_OVERALL_VERDICTS, raw.overall)) {
      throw new Error("invalid semantic review overall verdict");
    }
    if (!includes(SEMANTIC_REVIEW_FIELD_VERDICTS, raw.phase)) {
      throw new Error("invalid semantic review phase verdict");
    }
    const expectedPhase = raw.expected_phase;
    if (raw.phase === "wrong") {
      if (!isString(expectedPhase) || !phases.has(expectedPhase as SemanticPhase)) {
        throw new Error("wrong phase verdict requires an expected phase");
      }
    } else if (expectedPhase !== undefined) {
      throw new Error("expected phase is allowed only for a wrong verdict");
    }
    if (!includes(SEMANTIC_REVIEW_FIELD_VERDICTS, raw.expression)) {
      throw new Error("invalid semantic review expression verdict");
    }
    const expectedExpression = raw.expected_expression;
    if (raw.expression === "wrong") {
      if (
        !isString(expectedExpression) ||
        (expectedExpression !== SEMANTIC_REVIEW_NO_EXPRESSION &&
          !expressions.has(expectedExpression as SemanticExpressionCue))
      ) {
        throw new Error("wrong expression verdict requires an expected expression");
      }
    } else if (expectedExpression !== undefined) {
      throw new Error("expected expression is allowed only for a wrong verdict");
    }
    if (!includes(SEMANTIC_REVIEW_PORTRAIT_VERDICTS, raw.portrait_usefulness)) {
      throw new Error("invalid semantic review portrait verdict");
    }
    const transitionRequired = semanticTransitionChanged(
      candidate,
      previousCandidate(candidate, all),
    );
    if (transitionRequired) {
      if (!includes(SEMANTIC_REVIEW_TRANSITION_VERDICTS, raw.transition)) {
        throw new Error("changed semantic reading requires a transition verdict");
      }
    } else if (raw.transition !== undefined) {
      throw new Error("transition verdict is not valid for this candidate");
    }
    if (!includes(SEMANTIC_REVIEW_CONFIDENCE, raw.confidence)) {
      throw new Error("invalid semantic review confidence");
    }
    if (!isBoundedInteger(raw.response_ms, 0, MAX_RESPONSE_MS)) {
      throw new Error("invalid semantic review response duration");
    }
    seen.add(raw.candidate_id);
    return {
      candidate_id: raw.candidate_id,
      overall: raw.overall,
      phase: raw.phase,
      ...(raw.phase === "wrong" ? { expected_phase: expectedPhase as SemanticPhase } : {}),
      expression: raw.expression,
      ...(raw.expression === "wrong"
        ? { expected_expression: expectedExpression as SemanticReviewExpression }
        : {}),
      portrait_usefulness: raw.portrait_usefulness,
      ...(transitionRequired
        ? { transition: raw.transition as SemanticReviewTransitionVerdict }
        : {}),
      confidence: raw.confidence,
      response_ms: raw.response_ms,
    };
  });
  if (value.study_id !== studyId(responses.map((response) => response.candidate_id))) {
    throw new Error("semantic review study changed");
  }
  return {
    schema_version: SEMANTIC_REVIEW_SCHEMA_VERSION,
    study_id: value.study_id,
    total_duration_ms: value.total_duration_ms,
    responses,
  };
}

function summarize(
  rows: readonly SemanticReviewReceiptRowV1[],
): SemanticReviewReceiptV1["summary"] {
  const summary: SemanticReviewReceiptV1["summary"] = {
    reviewed: rows.length,
    overall: { correct: 0, close: 0, wrong: 0, unsure: 0 },
    phase: { correct: 0, wrong: 0, unsure: 0 },
    expression: { correct: 0, wrong: 0, unsure: 0 },
    portrait_usefulness: { helpful: 0, neutral: 0, misleading: 0 },
    transitions: { "real-change": 0, flicker: 0, unsure: 0 },
  };
  for (const row of rows) {
    summary.overall[row.overall] += 1;
    summary.phase[row.phase] += 1;
    summary.expression[row.expression] += 1;
    summary.portrait_usefulness[row.portrait_usefulness] += 1;
    if (row.transition) summary.transitions[row.transition] += 1;
  }
  return summary;
}

function studyId(candidateIds: readonly string[]): string {
  return opaqueId("study", { candidate_ids: candidateIds });
}

function opaqueId(prefix: "candidate" | "subject" | "study", value: unknown): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
}

function reviewedCandidateIds(receipts: readonly SemanticReviewReceiptV1[]): Set<string> {
  return new Set(receipts.flatMap((receipt) => receipt.responses.map((row) => row.candidate_id)));
}

function compareCandidates(
  left: SemanticReviewCandidateV1,
  right: SemanticReviewCandidateV1,
): number {
  return (
    right.source.generated_at.localeCompare(left.source.generated_at) ||
    right.candidate_id.localeCompare(left.candidate_id)
  );
}

function pruneFiles(dir: string, maxFiles: number, maxAgeMs: number, now: number): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  for (const [index, entry] of entries.entries()) {
    if (index >= maxFiles || now - entry.mtime > maxAgeMs)
      rmSync(join(dir, entry.name), { force: true });
  }
}

function readBoundedJson<T>(path: string, label: string): T {
  const size = statSync(path).size;
  if (size <= 0 || size > MAX_JSON_BYTES) throw new Error(`${label} has invalid size ${size}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writePrivateJsonAtomic(path: string, value: unknown): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_JSON_BYTES)
    throw new Error("semantic review file is too large");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function isSemanticReviewCandidate(value: unknown): value is SemanticReviewCandidateV1 {
  if (!isRecord(value) || value.schema_version !== SEMANTIC_REVIEW_SCHEMA_VERSION) return false;
  if (
    !isString(value.candidate_id) ||
    !CANDIDATE_ID.test(value.candidate_id) ||
    !isString(value.subject_id) ||
    !SUBJECT_ID.test(value.subject_id) ||
    !isTimestamp(value.captured_at) ||
    !isRecord(value.source) ||
    !isString(value.source.evidence_digest) ||
    !DIGEST.test(value.source.evidence_digest) ||
    !isTimestamp(value.source.observed_through_ts) ||
    !isTimestamp(value.source.generated_at) ||
    !includes(SEMANTIC_HARNESSES, value.source.harness) ||
    !configuredModels.has(value.source.configured_model as SemanticConfiguredModel) ||
    !isBoundedString(value.source.resolved_model_id, 1, 160) ||
    (value.source.model_attestation !== "verified" &&
      value.source.model_attestation !== "requested-only") ||
    !isReviewEvidence(value.evidence) ||
    !isReviewProposal(value.proposal)
  ) {
    return false;
  }
  return true;
}

function isReviewEvidence(value: unknown): value is SemanticReviewEvidenceSnapshotV1 {
  if (!isRecord(value) || !isTimestamp(value.observed_through_ts)) return false;
  if (value.task !== undefined && !isBoundedString(value.task, 1, 200)) return false;
  if (value.lifecycle !== undefined && !isBoundedString(value.lifecycle, 1, 128)) return false;
  if (value.intent !== undefined && !isBoundedString(value.intent, 1, 128)) return false;
  if (value.operation !== undefined) {
    if (
      !isRecord(value.operation) ||
      !isBoundedString(value.operation.category, 1, 128) ||
      !isBoundedString(value.operation.label, 1, 80)
    )
      return false;
  }
  if (!Array.isArray(value.waits) || value.waits.length > 8) return false;
  if (
    !value.waits.every(
      (wait) =>
        isRecord(wait) && isBoundedString(wait.kind, 1, 128) && isTimestamp(wait.started_at),
    )
  )
    return false;
  if (
    !Array.isArray(value.recent) ||
    value.recent.length > 8 ||
    !value.recent.every(isReviewObservation)
  )
    return false;
  return value.attention === undefined || isReviewObservation(value.attention);
}

function isReviewObservation(value: unknown): value is SemanticReviewObservationV1 {
  return Boolean(
    isRecord(value) &&
      isBoundedString(value.kind, 1, 128) &&
      isTimestamp(value.observed_at) &&
      (value.label === undefined || isBoundedString(value.label, 1, 120)) &&
      (value.outcome === undefined || isBoundedString(value.outcome, 1, 128)) &&
      (value.error_class === undefined || isBoundedString(value.error_class, 1, 128)),
  );
}

function isReviewProposal(value: unknown): value is SemanticReviewProposalV1 {
  if (!isRecord(value)) return false;
  if (!isProposalField(value.headline, (item) => isBoundedString(item, 1, 60))) return false;
  if (!isProposalField(value.summary, (item) => isBoundedString(item, 1, 240))) return false;
  if (
    !isProposalField(
      value.phase,
      (item): item is SemanticPhase => isString(item) && phases.has(item as SemanticPhase),
    )
  )
    return false;
  if (
    value.expression_cue !== undefined &&
    !isProposalField(
      value.expression_cue,
      (item): item is SemanticExpressionCue =>
        isString(item) && expressions.has(item as SemanticExpressionCue),
    )
  )
    return false;
  for (const key of ["purpose", "recent_result", "attention", "next_step"] as const) {
    if (
      value[key] !== undefined &&
      !isProposalField(value[key], (item): item is string => isBoundedString(item, 1, 180))
    )
      return false;
  }
  if (
    value.tags !== undefined &&
    !isProposalField(
      value.tags,
      (item): item is SemanticTag[] =>
        Array.isArray(item) &&
        item.length <= 8 &&
        item.every((tag) => isString(tag) && tags.has(tag as SemanticTag)),
    )
  )
    return false;
  return true;
}

function isProposalField<T>(
  value: unknown,
  valueCheck: (value: unknown) => value is T,
): value is SemanticReviewProposalFieldV1<T> {
  return Boolean(
    isRecord(value) &&
      valueCheck(value.value) &&
      (value.confidence === "high" || value.confidence === "medium" || value.confidence === "low"),
  );
}

function isSemanticReviewReceipt(value: unknown): value is SemanticReviewReceiptV1 {
  if (
    !isRecord(value) ||
    value.schema_version !== SEMANTIC_REVIEW_SCHEMA_VERSION ||
    !isString(value.receipt_id) ||
    !RECEIPT_ID.test(value.receipt_id) ||
    !isString(value.study_id) ||
    !STUDY_ID.test(value.study_id) ||
    !isTimestamp(value.completed_at) ||
    !isBoundedInteger(value.total_duration_ms, 0, MAX_TOTAL_DURATION_MS) ||
    !Array.isArray(value.responses) ||
    value.responses.length < 1 ||
    value.responses.length > MAX_STUDY_SIZE ||
    !isRecord(value.summary)
  )
    return false;
  return value.responses.every(
    (row) => isRecord(row) && isString(row.candidate_id) && CANDIDATE_ID.test(row.candidate_id),
  );
}

function includes<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return isString(value) && (values as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return isString(value) && value.length >= min && value.length <= max;
}

function isTimestamp(value: unknown): value is string {
  return isString(value) && Number.isFinite(Date.parse(value));
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}
