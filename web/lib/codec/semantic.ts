/**
 * Server-only read path for the optional semantic read model.
 *
 * The browser receives only the validated, presentation-bounded channel added
 * to a Codec panel. This module cannot launch a reader or mutate V3 authority.
 */

import { coordRoot } from "@/lib/coord-reader";
import type {
  SemanticAgentReadModelV2,
  SemanticField,
  SemanticPhase,
} from "../../../src/core/semantic/contract";
import { listSemanticAgentDocuments } from "../../../src/core/semantic/storage";

import type {
  CodecExpression,
  CodecPanelScene,
  CodecScene,
  CodecSourceEvidence,
  Confidence,
} from "./contracts";
import {
  type CodecSemanticChannel,
  type CodecSemanticPresented,
  type CodecSemanticState,
  setCodecSemantic,
} from "./semantic-contract";

export const CODEC_SEMANTIC_LIVE_WINDOW_MS = 5 * 60_000;
export const CODEC_SEMANTIC_TERMINAL_WINDOW_MS = 30 * 60_000;

/** Read validated derived documents. Missing or malformed storage means off. */
export function readCodecSemanticDocuments(root = coordRoot()): SemanticAgentReadModelV2[] {
  try {
    return listSemanticAgentDocuments(root);
  } catch {
    return [];
  }
}

/** Merge meaning only into presentation channels that deterministic evidence did not fill. */
export function applySemanticReadModel(
  scene: CodecScene,
  sourceEvents: readonly CodecSourceEvidence[],
  root = coordRoot(),
  now = new Date(scene.generated_at),
  canonicalInstanceByPanel: ReadonlyMap<string, string> = new Map(),
): number {
  const documents = readCodecSemanticDocuments(root);
  if (documents.length === 0) return 0;
  const generationByInstance = latestGenerationByInstance(sourceEvents);
  const byGeneration = new Map(documents.map((document) => [document.generation_id, document]));
  let merged = 0;

  for (const panel of scene.panels) {
    if (panel.machine) continue;
    const semanticInstanceId = canonicalInstanceByPanel.get(panel.instance_id) ?? panel.instance_id;
    const generationId = generationByInstance.get(semanticInstanceId);
    if (!generationId) continue;
    const document = byGeneration.get(generationId);
    if (!document || document.instance_id !== semanticInstanceId) continue;
    const semantic = presentSemantic(document, panel, now);
    setCodecSemantic(panel, semantic);
    merged += 1;
    if (semantic.state !== "current" || !semantic.headline) continue;

    if (!panel.focus_bubble || panel.focus_bubble.value.basis === "inferred") {
      panel.focus_bubble = {
        value: { text: semantic.headline.value, basis: "inferred" },
        provenance: "inferred",
        confidence: semantic.headline.confidence,
        observed_at: semantic.headline.observed_at,
        evidence_event_ids: semantic.headline.evidence_event_ids,
        expires_at: semantic.expires_at,
      };
    }
    const expression = semantic.expression_cue?.value ?? expressionForPhase(semantic.phase?.value);
    const expressionSource = semantic.expression_cue ?? semantic.phase;
    if (expression && expression !== "neutral" && panel.expression.value === "neutral") {
      panel.expression = {
        value: expression,
        provenance: "inferred",
        confidence: expressionSource?.confidence ?? "low",
        observed_at: expressionSource?.observed_at ?? document.generated_at,
        evidence_event_ids: expressionSource?.evidence_event_ids,
        expires_at: semantic.expires_at,
      };
    }
  }
  return merged;
}

export { codecSemantic } from "./semantic-contract";

function presentSemantic(
  document: SemanticAgentReadModelV2,
  panel: CodecPanelScene,
  now: Date,
): CodecSemanticChannel {
  const ttl =
    panel.ledger_state?.value === "terminal"
      ? CODEC_SEMANTIC_TERMINAL_WINDOW_MS
      : CODEC_SEMANTIC_LIVE_WINDOW_MS;
  const expiresAt = new Date(Date.parse(document.source.observed_through_ts) + ttl).toISOString();
  const stale = now.getTime() > Date.parse(expiresAt);
  const usage = semanticDocumentUsage(document);
  const common = {
    state: stale ? ("stale" as const) : semanticState(document.reader_outcome),
    reader_outcome: document.reader_outcome,
    reader: {
      harness: document.reader.harness,
      configured_model: document.reader.configured_model,
      ...("resolved_model_id" in document.reader && document.reader.resolved_model_id
        ? { resolved_model_id: document.reader.resolved_model_id }
        : {}),
      ...("model_attestation" in document.reader && document.reader.model_attestation
        ? { model_attestation: document.reader.model_attestation }
        : {}),
    },
    evidence_digest: document.source.evidence_digest,
    observed_through_event_id: document.source.observed_through_event_id,
    observed_through_ts: document.source.observed_through_ts,
    generated_at: document.generated_at,
    expires_at: expiresAt,
    ...(usage ? { usage } : {}),
  };
  if (stale) return common;
  if (document.reader_outcome !== "accepted") {
    return {
      ...common,
      receipt: {
        reason_code: document.receipt.reason_code,
        ...(document.reader_outcome === "deferred"
          ? { eligible_after: document.receipt.eligible_after }
          : {}),
      },
    };
  }
  const meaning = document.meaning;
  return {
    ...common,
    headline: presentField(meaning.headline, document),
    summary: presentField(meaning.summary, document),
    phase: presentField(meaning.phase, document),
    ...(meaning.expression_cue
      ? { expression_cue: presentField(meaning.expression_cue, document) }
      : {}),
    ...(meaning.purpose ? { purpose: presentField(meaning.purpose, document) } : {}),
    ...(meaning.recent_result
      ? { recent_result: presentField(meaning.recent_result, document) }
      : {}),
    ...(meaning.attention ? { attention: presentField(meaning.attention, document) } : {}),
    ...(meaning.next_step ? { next_step: presentField(meaning.next_step, document) } : {}),
    ...(meaning.tags ? { tags: presentField(meaning.tags, document) } : {}),
  };
}

function semanticDocumentUsage(document: SemanticAgentReadModelV2) {
  if (!("receipt" in document) || !document.receipt || !("usage" in document.receipt)) {
    return undefined;
  }
  return document.receipt.usage;
}

function presentField<T>(
  field: SemanticField<T>,
  document: SemanticAgentReadModelV2,
): CodecSemanticPresented<T> {
  return {
    value: field.value,
    basis: field.basis === "prediction" ? "prediction" : "model-synthesis",
    provenance: "inferred",
    confidence: field.confidence as Confidence,
    observed_at: document.generated_at,
    evidence_event_ids: field.evidence_event_ids,
  };
}

function semanticState(outcome: SemanticAgentReadModelV2["reader_outcome"]): CodecSemanticState {
  return outcome === "accepted" ? "current" : outcome;
}

function latestGenerationByInstance(events: readonly CodecSourceEvidence[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const event of events) {
    if (event.generation_id) result.set(event.instance_id, event.generation_id);
  }
  return result;
}

function expressionForPhase(phase: SemanticPhase | undefined): CodecExpression | undefined {
  if (!phase) return undefined;
  return {
    orienting: "curious",
    researching: "investigating",
    planning: "planning",
    implementing: "building",
    verifying: "verifying",
    coordinating: "coordinating",
    waiting: "waiting",
    recovering: "recovering",
    "wrapping-up": "wrapping-up",
    unknown: "neutral",
  }[phase] as CodecExpression;
}
