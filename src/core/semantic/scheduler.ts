import type { SemanticAgentReadModelV1, SemanticEvidenceV1 } from "./contract.ts";
import type { SemanticCallReceipt, SemanticPendingItem } from "./storage.ts";

export const SEMANTIC_HARD_CALLS_PER_HOUR = 60;
export const SEMANTIC_INVALID_RETRY_COOLDOWN_MS = 5 * 60_000;
export const SEMANTIC_MIN_GENERATION_CALL_INTERVAL_MS = 30_000;

export function semanticPriorityBand(evidence: SemanticEvidenceV1): 1 | 2 {
  if (
    evidence.attention ||
    evidence.lifecycle ||
    evidence.recent.some((item) => item.kind === "terminal")
  ) {
    return 1;
  }
  return 2;
}

export function enqueueSemanticPending(
  pending: readonly SemanticPendingItem[],
  evidence: SemanticEvidenceV1,
  nowIso: string,
): SemanticPendingItem[] {
  const prior = pending.find((item) => item.generation_id === evidence.generation_id);
  const next: SemanticPendingItem = {
    generation_id: evidence.generation_id,
    evidence_digest: evidence.evidence_digest as `sha256:${string}`,
    band: semanticPriorityBand(evidence),
    pending_since:
      prior?.evidence_digest === evidence.evidence_digest ? prior.pending_since : nowIso,
  };
  return [...pending.filter((item) => item.generation_id !== evidence.generation_id), next];
}

export function selectSemanticPending(
  pending: readonly SemanticPendingItem[],
  lastFirstBandGenerationId?: string,
): SemanticPendingItem | undefined {
  const sorted = [...pending].sort(
    (left, right) =>
      left.band - right.band ||
      left.pending_since.localeCompare(right.pending_since) ||
      left.generation_id.localeCompare(right.generation_id),
  );
  const firstBand = sorted.filter((item) => item.band === 1);
  if (firstBand.length > 1 && firstBand[0]?.generation_id === lastFirstBandGenerationId) {
    return firstBand.find((item) => item.generation_id !== lastFirstBandGenerationId);
  }
  return sorted[0];
}

export function activeSemanticCallHistory(
  history: readonly SemanticCallReceipt[],
  nowMs: number,
): SemanticCallReceipt[] {
  return history.filter((call) => {
    const started = Date.parse(call.started_at);
    return Number.isFinite(started) && nowMs - started < 60 * 60_000;
  });
}

export function semanticRateCap(
  history: readonly SemanticCallReceipt[],
  nowMs: number,
  configuredLimit = SEMANTIC_HARD_CALLS_PER_HOUR,
): { available: number; eligible_after?: string } {
  const active = activeSemanticCallHistory(history, nowMs).sort((left, right) =>
    left.started_at.localeCompare(right.started_at),
  );
  const limit = Math.min(SEMANTIC_HARD_CALLS_PER_HOUR, Math.max(1, Math.floor(configuredLimit)));
  if (active.length < limit) return { available: limit - active.length };
  return {
    available: 0,
    eligible_after: new Date(Date.parse(active[0]!.started_at) + 60 * 60_000).toISOString(),
  };
}

export function semanticGenerationCallEligible(
  history: readonly SemanticCallReceipt[],
  generationId: string,
  nowMs: number,
  minimumIntervalMs = SEMANTIC_MIN_GENERATION_CALL_INTERVAL_MS,
): boolean {
  const newest = history
    .filter((call) => call.generation_id === generationId)
    .map((call) => Date.parse(call.started_at))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  return newest === undefined || nowMs - newest >= Math.max(0, minimumIntervalMs);
}

export function semanticDocumentEligible(
  document: SemanticAgentReadModelV1 | undefined,
  evidence: SemanticEvidenceV1,
  nowMs: number,
): boolean {
  if (!document || document.source.evidence_digest !== evidence.evidence_digest) return true;
  if (document.reader_outcome === "accepted") return false;
  if (document.reader_outcome === "deferred") {
    return Date.parse(document.receipt.eligible_after) <= nowMs;
  }
  const generated = Date.parse(document.generated_at);
  return !Number.isFinite(generated) || nowMs - generated >= SEMANTIC_INVALID_RETRY_COOLDOWN_MS;
}
