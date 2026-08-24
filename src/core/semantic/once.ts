import {
  createSemanticAdapters,
  type SemanticAdapter,
  type SemanticAdapterResult,
} from "./adapters.ts";
import {
  SEMANTIC_EVIDENCE_CONTRACT_VERSION,
  SEMANTIC_PROMPT_CONTRACT_VERSION,
  type SemanticAgentReadModelV2,
  type SemanticConfiguredModel,
  type SemanticEvidenceV1,
  type SemanticHarness,
  type SemanticInvalidReasonCode,
  type SemanticUsageReceiptV1,
} from "./contract.ts";
import { buildSemanticEvidenceV1 } from "./evidence.ts";
import { buildSemanticPrompt, extractSemanticJson } from "./prompt.ts";
import { captureSemanticReviewCandidate } from "./review.ts";
import {
  activeSemanticCallHistory,
  enqueueSemanticPending,
  selectSemanticPending,
  semanticDocumentEligible,
  semanticGenerationCallEligible,
  semanticPendingCallIntervalMs,
  semanticRateCap,
} from "./scheduler.ts";
import {
  invalidateSemanticDerivedState,
  pruneSemanticStorage,
  readSemanticAgentDocument,
  readSemanticCache,
  readSemanticManifest,
  type SemanticCallReceipt,
  type SemanticManifestV2,
  type SemanticReaderResolution,
  semanticCacheKey,
  semanticConfigurationDigest,
  writeSemanticAgentDocument,
  writeSemanticCache,
  writeSemanticManifest,
} from "./storage.ts";
import { unreportedSemanticUsage } from "./usage.ts";
import { classifySemanticValidationIssues, validateSemanticModelReply } from "./validate.ts";

export interface SemanticOnceOutcome {
  generation_id: string;
  source_harness: SemanticHarness;
  configured_model?: SemanticConfiguredModel;
  resolved_model_id?: string;
  model_attestation?: "verified" | "requested-only";
  action: "unchanged" | "cached" | "accepted" | "unavailable" | "invalid" | "deferred";
  model_call: boolean;
  duration_ms?: number;
  input_bytes?: number;
  output_bytes?: number;
  usage?: SemanticUsageReceiptV1;
  invalid_reason_codes?: SemanticInvalidReasonCode[];
}

export interface SemanticOnceReport {
  schema_version: 1;
  ledger_genesis_id?: string;
  evidence_count: number;
  evidence_by_harness: Record<SemanticHarness, number>;
  model_calls: number;
  cache_hits: number;
  outcomes: SemanticOnceOutcome[];
  completed_at: string;
}

export interface RunSemanticOnceInput {
  coordRoot: string;
  evidence?: SemanticEvidenceV1[];
  adapters?: Record<SemanticHarness, SemanticAdapter>;
  now?: () => Date;
  callsPerHour?: number;
  debounceMs?: number;
  minimumGenerationCallIntervalMs?: number;
  shouldStop?: () => boolean;
}

export async function runSemanticOnce(input: RunSemanticOnceInput): Promise<SemanticOnceReport> {
  const now = input.now ?? (() => new Date());
  const nowDate = now();
  const nowIso = nowDate.toISOString();
  const evidence = input.evidence ?? buildSemanticEvidenceV1(input.coordRoot, nowDate.getTime());
  const ledgerGenesisId = evidence[0]?.source.ledger_genesis_id;
  const adapters = input.adapters ?? createSemanticAdapters();
  const resolutions = resolveReaders(adapters, now);
  const configurationDigest = semanticConfigurationDigest(resolutions);
  let manifest = safeManifest(input.coordRoot);
  let preservedCallHistory: SemanticCallReceipt[] = [];
  if (
    manifest &&
    (manifest.ledger_genesis_id !== ledgerGenesisId ||
      manifest.configuration_digest !== configurationDigest ||
      manifest.evidence_contract_version !== SEMANTIC_EVIDENCE_CONTRACT_VERSION ||
      manifest.prompt_contract_version !== SEMANTIC_PROMPT_CONTRACT_VERSION)
  ) {
    preservedCallHistory = activeSemanticCallHistory(manifest.call_history, nowDate.getTime());
    invalidateSemanticDerivedState(input.coordRoot);
    manifest = undefined;
  }
  const current: SemanticManifestV2 =
    manifest ??
    ({
      schema_version: 2,
      ledger_genesis_id: ledgerGenesisId ?? "gex_unavailable",
      configuration_digest: configurationDigest,
      evidence_contract_version: SEMANTIC_EVIDENCE_CONTRACT_VERSION,
      prompt_contract_version: SEMANTIC_PROMPT_CONTRACT_VERSION,
      adapter_resolutions: resolutions,
      pending: [],
      call_history: preservedCallHistory,
      updated_at: nowIso,
    } satisfies SemanticManifestV2);
  current.adapter_resolutions = resolutions;
  current.call_history = activeSemanticCallHistory(current.call_history, nowDate.getTime());

  const outcomes: SemanticOnceOutcome[] = [];
  const evidenceByGeneration = new Map(evidence.map((item) => [item.generation_id, item]));
  for (const item of evidence) {
    const existing = safeAgentDocument(input.coordRoot, item.generation_id);
    if (!semanticDocumentEligible(existing, item, nowDate.getTime())) {
      outcomes.push({
        generation_id: item.generation_id,
        source_harness: item.source_harness,
        action: "unchanged",
        model_call: false,
      });
      continue;
    }
    current.pending = enqueueSemanticPending(current.pending, item, nowIso);
  }

  let calls = 0;
  let cacheHits = 0;
  const heldGenerations = new Set<string>();
  while (current.pending.length > 0) {
    if (input.shouldStop?.()) break;
    const eligiblePending = current.pending.filter(
      (pending) =>
        !heldGenerations.has(pending.generation_id) &&
        Date.parse(pending.pending_since) <= nowDate.getTime() - (input.debounceMs ?? 0),
    );
    const pending = selectSemanticPending(
      eligiblePending,
      current.last_first_band_generation_id,
      activeSemanticCallHistory(current.call_history, nowDate.getTime()),
    );
    if (!pending) break;
    const item = evidenceByGeneration.get(pending.generation_id);
    if (!item || item.evidence_digest !== pending.evidence_digest) {
      current.pending = current.pending.filter(
        (candidate) => candidate.generation_id !== pending.generation_id,
      );
      continue;
    }
    const resolution = resolutions[item.source_harness];
    if (!resolution.available || !resolution.resolved_model_id || !resolution.model_attestation) {
      writeSemanticAgentDocument(input.coordRoot, unavailableDocument(item, resolution, nowIso));
      outcomes.push({
        generation_id: item.generation_id,
        source_harness: item.source_harness,
        configured_model: resolution.configured_model,
        ...(resolution.resolved_model_id
          ? { resolved_model_id: resolution.resolved_model_id }
          : {}),
        ...(resolution.model_attestation
          ? { model_attestation: resolution.model_attestation }
          : {}),
        action: "unavailable",
        model_call: false,
      });
      removePending(current, pending.generation_id);
      continue;
    }
    const cacheKey = semanticCacheKey({
      evidence_digest: item.evidence_digest,
      source_harness: item.source_harness,
      configured_model: resolution.configured_model,
      resolved_model_id: resolution.resolved_model_id,
      evidence_contract_version: SEMANTIC_EVIDENCE_CONTRACT_VERSION,
      prompt_contract_version: SEMANTIC_PROMPT_CONTRACT_VERSION,
    });
    const cached = readSemanticCache(input.coordRoot, cacheKey);
    if (
      cached?.reader_outcome === "accepted" &&
      cached.instance_id === item.instance_id &&
      cached.generation_id === item.generation_id &&
      cached.source.evidence_digest === item.evidence_digest
    ) {
      writeSemanticAgentDocument(input.coordRoot, cached);
      captureReviewCandidateSafely(input.coordRoot, item, cached);
      cacheHits += 1;
      outcomes.push({
        generation_id: item.generation_id,
        source_harness: item.source_harness,
        action: "cached",
        model_call: false,
      });
      current.newest_successful_pass = nowIso;
      removePending(current, pending.generation_id);
      continue;
    }
    const cap = semanticRateCap(current.call_history, nowDate.getTime(), input.callsPerHour);
    if (cap.available === 0) {
      const deferred = deferredDocument(item, resolution, cap.eligible_after!, nowIso);
      writeSemanticAgentDocument(input.coordRoot, deferred);
      outcomes.push({
        generation_id: item.generation_id,
        source_harness: item.source_harness,
        configured_model: resolution.configured_model,
        ...(resolution.resolved_model_id
          ? { resolved_model_id: resolution.resolved_model_id }
          : {}),
        ...(resolution.model_attestation
          ? { model_attestation: resolution.model_attestation }
          : {}),
        action: "deferred",
        model_call: false,
      });
      removePending(current, pending.generation_id);
      continue;
    }
    if (
      !semanticGenerationCallEligible(
        current.call_history,
        pending.generation_id,
        nowDate.getTime(),
        input.minimumGenerationCallIntervalMs ?? semanticPendingCallIntervalMs(pending),
      )
    ) {
      heldGenerations.add(pending.generation_id);
      continue;
    }
    const prompt = buildSemanticPrompt(item);
    const callReceipt: SemanticCallReceipt = {
      generation_id: item.generation_id,
      started_at: nowIso,
      source_harness: item.source_harness,
      configured_model: resolution.configured_model,
      resolved_model_id: resolution.resolved_model_id,
      model_attestation: resolution.model_attestation,
      input_bytes: prompt.bytes,
      usage: unreportedSemanticUsage(),
    };
    current.call_history.push(callReceipt);
    // Persist the charged call before invocation. A crash leaves an honest
    // unreported receipt and cannot silently return capacity to the hour.
    writeSemanticManifest(input.coordRoot, current);
    calls += 1;
    const result = await adapters[item.source_harness].invoke(
      prompt.prompt,
      undefined,
      prompt.response_schema,
    );
    const outcome = materializeAdapterResult(item, resolution, result, nowIso);
    callReceipt.outcome = outcome.document.reader_outcome as "accepted" | "invalid" | "unavailable";
    callReceipt.duration_ms = result.duration_ms;
    callReceipt.usage = result.usage;
    if (outcome.invalid_reason_codes) {
      callReceipt.invalid_reason_codes = outcome.invalid_reason_codes;
    }
    if (result.resolved_model_id) callReceipt.resolved_model_id = result.resolved_model_id;
    if (result.model_attestation) callReceipt.model_attestation = result.model_attestation;
    if (result.ok) callReceipt.output_bytes = result.output_bytes;
    writeSemanticAgentDocument(input.coordRoot, outcome.document);
    if (outcome.document.reader_outcome === "accepted") {
      writeSemanticCache(input.coordRoot, cacheKey, outcome.document);
      captureReviewCandidateSafely(input.coordRoot, item, outcome.document);
      current.newest_successful_pass = nowIso;
    }
    outcomes.push({
      generation_id: item.generation_id,
      source_harness: item.source_harness,
      configured_model: resolution.configured_model,
      ...(result.resolved_model_id ? { resolved_model_id: result.resolved_model_id } : {}),
      ...(result.model_attestation ? { model_attestation: result.model_attestation } : {}),
      action: outcome.document.reader_outcome,
      model_call: true,
      duration_ms: result.duration_ms,
      input_bytes: prompt.bytes,
      ...(result.ok ? { output_bytes: result.output_bytes } : {}),
      usage: result.usage,
      ...(outcome.invalid_reason_codes
        ? { invalid_reason_codes: outcome.invalid_reason_codes }
        : {}),
    });
    if (pending.band === 1) current.last_first_band_generation_id = pending.generation_id;
    removePending(current, pending.generation_id);
  }

  current.updated_at = nowIso;
  writeSemanticManifest(input.coordRoot, current);
  pruneSemanticStorage(input.coordRoot, {
    keepGenerations: new Set(evidence.map((item) => item.generation_id)),
    now: nowDate.getTime(),
  });
  return {
    schema_version: 1,
    ...(ledgerGenesisId ? { ledger_genesis_id: ledgerGenesisId } : {}),
    evidence_count: evidence.length,
    evidence_by_harness: countEvidenceByHarness(evidence),
    model_calls: calls,
    cache_hits: cacheHits,
    outcomes,
    completed_at: nowIso,
  };
}

function captureReviewCandidateSafely(
  coordRoot: string,
  evidence: SemanticEvidenceV1,
  document: SemanticAgentReadModelV2,
): void {
  if (document.reader_outcome !== "accepted") return;
  try {
    captureSemanticReviewCandidate(coordRoot, evidence, document);
  } catch {
    // Evaluation capture is observational. A local storage problem must not
    // turn an otherwise valid semantic reading into a failed reader pass.
  }
}

function countEvidenceByHarness(
  evidence: readonly SemanticEvidenceV1[],
): Record<SemanticHarness, number> {
  const counts: Record<SemanticHarness, number> = { "claude-code": 0, codex: 0, cursor: 0 };
  for (const item of evidence) counts[item.source_harness] += 1;
  return counts;
}

function resolveReaders(
  adapters: Record<SemanticHarness, SemanticAdapter>,
  now: () => Date,
): Record<SemanticHarness, SemanticReaderResolution> {
  return {
    "claude-code": adapters["claude-code"].discover(now),
    codex: adapters.codex.discover(now),
    cursor: adapters.cursor.discover(now),
  };
}

function materializeAdapterResult(
  evidence: SemanticEvidenceV1,
  resolution: SemanticReaderResolution,
  result: SemanticAdapterResult,
  generatedAt: string,
): { document: SemanticAgentReadModelV2; invalid_reason_codes?: SemanticInvalidReasonCode[] } {
  if (!result.ok) {
    return {
      document: unavailableDocument(
        evidence,
        {
          ...resolution,
          available: false,
          reason_code: result.reason_code,
          resolved_model_id: result.resolved_model_id,
          model_attestation: result.model_attestation,
        },
        generatedAt,
        result.usage,
      ),
    };
  }
  const verdict = validateSemanticModelReply(extractSemanticJson(result.text), evidence);
  if (!verdict.ok) {
    const invalidReasonCodes = classifySemanticValidationIssues(verdict.issues);
    return {
      document: {
        ...documentBase(evidence, generatedAt),
        reader_outcome: "invalid",
        reader: {
          harness: evidence.source_harness,
          configured_model: resolution.configured_model,
          resolved_model_id: result.resolved_model_id,
          model_attestation: result.model_attestation,
          prompt_contract_version: SEMANTIC_PROMPT_CONTRACT_VERSION,
        },
        receipt: {
          reason_code: "invalid_output",
          validation_issue_codes: invalidReasonCodes,
          usage: result.usage,
        },
      },
      invalid_reason_codes: invalidReasonCodes,
    };
  }
  return {
    document: {
      ...documentBase(evidence, generatedAt),
      reader_outcome: "accepted",
      reader: {
        harness: evidence.source_harness,
        configured_model: resolution.configured_model,
        resolved_model_id: result.resolved_model_id,
        model_attestation: result.model_attestation,
        prompt_contract_version: SEMANTIC_PROMPT_CONTRACT_VERSION,
      },
      receipt: { usage: result.usage },
      meaning: verdict.value.meaning,
    },
  };
}

function unavailableDocument(
  evidence: SemanticEvidenceV1,
  resolution: SemanticReaderResolution,
  generatedAt: string,
  usage?: SemanticUsageReceiptV1,
): SemanticAgentReadModelV2 {
  return {
    ...documentBase(evidence, generatedAt),
    reader_outcome: "unavailable",
    reader: {
      harness: evidence.source_harness,
      configured_model: resolution.configured_model,
      ...(resolution.resolved_model_id && resolution.model_attestation
        ? {
            resolved_model_id: resolution.resolved_model_id,
            model_attestation: resolution.model_attestation,
          }
        : {}),
      prompt_contract_version: SEMANTIC_PROMPT_CONTRACT_VERSION,
    },
    receipt: {
      reason_code: resolution.reason_code ?? "model_unavailable",
      ...(usage ? { usage } : {}),
    },
  } as SemanticAgentReadModelV2;
}

function deferredDocument(
  evidence: SemanticEvidenceV1,
  resolution: SemanticReaderResolution,
  eligibleAfter: string,
  generatedAt: string,
): SemanticAgentReadModelV2 {
  return {
    ...documentBase(evidence, generatedAt),
    reader_outcome: "deferred",
    reader: {
      harness: evidence.source_harness,
      configured_model: resolution.configured_model,
      ...(resolution.resolved_model_id && resolution.model_attestation
        ? {
            resolved_model_id: resolution.resolved_model_id,
            model_attestation: resolution.model_attestation,
          }
        : {}),
      prompt_contract_version: SEMANTIC_PROMPT_CONTRACT_VERSION,
    },
    receipt: { reason_code: "rate_cap", eligible_after: eligibleAfter },
  } as SemanticAgentReadModelV2;
}

function documentBase(evidence: SemanticEvidenceV1, generatedAt: string) {
  return {
    schema_version: 2 as const,
    instance_id: evidence.instance_id,
    generation_id: evidence.generation_id,
    source: {
      ledger_genesis_id: evidence.source.ledger_genesis_id,
      evidence_digest: evidence.evidence_digest,
      observed_through_event_id: evidence.source.observed_through_event_id,
      observed_through_ts: evidence.source.observed_through_ts,
    },
    generated_at: generatedAt,
  };
}

function safeManifest(coordRoot: string): SemanticManifestV2 | undefined {
  try {
    return readSemanticManifest(coordRoot);
  } catch {
    invalidateSemanticDerivedState(coordRoot);
    return undefined;
  }
}

function safeAgentDocument(
  coordRoot: string,
  generationId: string,
): SemanticAgentReadModelV2 | undefined {
  try {
    return readSemanticAgentDocument(coordRoot, generationId);
  } catch {
    return undefined;
  }
}

function removePending(manifest: SemanticManifestV2, generationId: string): void {
  manifest.pending = manifest.pending.filter((item) => item.generation_id !== generationId);
}
