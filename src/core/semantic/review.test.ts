import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SemanticAcceptedReadModelV2,
  SemanticEvidenceV1,
  SemanticExpressionCue,
  SemanticPhase,
} from "./contract.ts";
import {
  captureSemanticReviewCandidate,
  listSemanticReviewCandidates,
  prepareSemanticReviewStudy,
  type SemanticReviewResponseV1,
  semanticReviewPaths,
  storeSemanticReviewSubmission,
} from "./review.ts";

const EVENT_ONE = "evt_01922e33-7abc-7def-8abc-0123456789ab";
const EVENT_TWO = "evt_01922e33-7abd-7def-8abc-0123456789ab";
const GENERATION = "gen_01922e33-7abc-7def-8abc-0123456789ab";
const NOW = "2026-08-24T17:00:00.000Z";

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "harnery-semantic-review-"));
}

function evidence(digest = "a", observedAt = NOW): SemanticEvidenceV1 {
  return {
    schema_version: 1,
    evidence_contract_version: 1,
    instance_id: "inst_private-fixture",
    generation_id: GENERATION,
    source_harness: "codex",
    source: {
      ledger_genesis_id: "gex_private-fixture",
      observed_through_event_id: EVENT_TWO,
      observed_through_ts: observedAt,
    },
    task: { value: "Implement the private review fixture", event_id: EVENT_ONE },
    lifecycle: { state: "active", event_id: EVENT_ONE },
    intent: { kind: "test", event_id: EVENT_TWO },
    operation: { category: "test", label: "Testing", event_id: EVENT_TWO },
    waits: [],
    recent: [
      {
        kind: "progress",
        event_id: EVENT_TWO,
        observed_at: observedAt,
        label: "Review fixture advanced",
        outcome: "succeeded",
      },
    ],
    evidence_event_ids: [EVENT_ONE, EVENT_TWO],
    evidence_digest: `sha256:${digest.repeat(64)}`,
  };
}

function accepted(
  source: SemanticEvidenceV1,
  phase: SemanticPhase = "verifying",
  cue: SemanticExpressionCue | undefined = "verifying",
  generatedAt = NOW,
): SemanticAcceptedReadModelV2 {
  const field = <T>(value: T, confidence: "high" | "medium" | "low" = "high") => ({
    value,
    basis: "model-synthesis" as const,
    confidence,
    evidence_event_ids: [EVENT_TWO],
  });
  return {
    schema_version: 2,
    instance_id: source.instance_id,
    generation_id: source.generation_id,
    source: {
      ledger_genesis_id: source.source.ledger_genesis_id,
      evidence_digest: source.evidence_digest,
      observed_through_event_id: source.source.observed_through_event_id,
      observed_through_ts: source.source.observed_through_ts,
    },
    generated_at: generatedAt,
    reader_outcome: "accepted",
    reader: {
      harness: "codex",
      configured_model: "gpt-5.6-luna",
      resolved_model_id: "gpt-5.6-luna",
      model_attestation: "requested-only",
      prompt_contract_version: 4,
    },
    meaning: {
      headline: field("Verifying the review lab"),
      summary: field("The agent is checking a bounded semantic review candidate."),
      phase: field(phase),
      ...(cue ? { expression_cue: field(cue, "medium") } : {}),
    },
  };
}

describe("semantic inference review", () => {
  test("captures bounded local evidence without retaining ledger identities", () => {
    const root = fixtureRoot();
    try {
      const source = evidence();
      const first = captureSemanticReviewCandidate(root, source, accepted(source));
      const second = captureSemanticReviewCandidate(root, source, accepted(source));
      expect(second.candidate_id).toBe(first.candidate_id);
      expect(first).toMatchObject({
        source: { harness: "codex", configured_model: "gpt-5.6-luna" },
        evidence: { task: "Implement the private review fixture" },
        proposal: { phase: { value: "verifying" }, expression_cue: { value: "verifying" } },
      });
      const target = join(semanticReviewPaths(root).candidates, `${first.candidate_id}.json`);
      const body = readFileSync(target, "utf8");
      expect(body).not.toContain(source.instance_id);
      expect(body).not.toContain(source.generation_id);
      expect(body).not.toContain(EVENT_ONE);
      expect(body).not.toContain(EVENT_TWO);
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(listSemanticReviewCandidates(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("freezes transition context and stores only controlled review receipts", () => {
    const root = fixtureRoot();
    try {
      const earlierEvidence = evidence("a", "2026-08-24T16:55:00.000Z");
      const latestEvidence = evidence("b", NOW);
      captureSemanticReviewCandidate(
        root,
        earlierEvidence,
        accepted(earlierEvidence, "planning", "planning", "2026-08-24T16:55:01.000Z"),
      );
      captureSemanticReviewCandidate(
        root,
        latestEvidence,
        accepted(latestEvidence, "implementing", "building", "2026-08-24T17:00:01.000Z"),
      );
      const study = prepareSemanticReviewStudy(root, {
        backfill: false,
        now: new Date("2026-08-24T17:01:00.000Z"),
      });
      expect(study.candidates).toHaveLength(2);
      expect(study.candidates[0]).toMatchObject({
        transition_required: true,
        candidate: { proposal: { phase: { value: "implementing" } } },
        previous: { proposal: { phase: { value: "planning" } } },
      });

      const responses: SemanticReviewResponseV1[] = study.candidates.map((item) => ({
        candidate_id: item.candidate.candidate_id,
        overall: "correct",
        phase: "correct",
        expression: "correct",
        portrait_usefulness: "helpful",
        ...(item.transition_required ? { transition: "real-change" as const } : {}),
        confidence: "high",
        response_ms: 1_000,
      }));
      const receipt = storeSemanticReviewSubmission(
        root,
        {
          schema_version: 1,
          study_id: study.study_id,
          total_duration_ms: 2_000,
          responses,
        },
        new Date("2026-08-24T17:02:00.000Z"),
      );
      expect(receipt).toMatchObject({
        summary: {
          reviewed: 2,
          overall: { correct: 2 },
          portrait_usefulness: { helpful: 2 },
          transitions: { "real-change": 1 },
        },
        responses: [
          {
            source_harness: "codex",
            configured_model: "gpt-5.6-luna",
            proposed_phase: "implementing",
            proposed_expression: "building",
          },
          {
            source_harness: "codex",
            configured_model: "gpt-5.6-luna",
            proposed_phase: "planning",
            proposed_expression: "planning",
          },
        ],
      });
      const receiptBody = readFileSync(
        join(semanticReviewPaths(root).receipts, `${receipt.receipt_id}.json`),
        "utf8",
      );
      expect(receiptBody).not.toContain("Implement the private review fixture");
      expect(receiptBody).not.toContain("bounded semantic review candidate");
      expect(prepareSemanticReviewStudy(root, { backfill: false }).pending_candidate_count).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires controlled corrections for wrong phase and expression verdicts", () => {
    const root = fixtureRoot();
    try {
      const source = evidence();
      const candidate = captureSemanticReviewCandidate(root, source, accepted(source));
      const study = prepareSemanticReviewStudy(root, { backfill: false });
      expect(() =>
        storeSemanticReviewSubmission(root, {
          schema_version: 1,
          study_id: study.study_id,
          total_duration_ms: 500,
          responses: [
            {
              candidate_id: candidate.candidate_id,
              overall: "wrong",
              phase: "wrong",
              expression: "wrong",
              portrait_usefulness: "misleading",
              confidence: "high",
              response_ms: 500,
            },
          ],
        }),
      ).toThrow("wrong phase verdict requires an expected phase");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
