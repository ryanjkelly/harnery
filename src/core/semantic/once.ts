import {
  createSemanticAdapters,
  type SemanticAdapter,
  type SemanticAdapterResult,
} from "./adapters.ts";
import {
  SEMANTIC_EVIDENCE_CONTRACT_VERSION,
  SEMANTIC_PROMPT_CONTRACT_VERSION,
  type SemanticAgentReadModelV1,
  type SemanticEvidenceV1,
  type SemanticHarness,
} from "./contract.ts";
import { buildSemanticEvidenceV1 } from "./evidence.ts";
import { buildSemanticPrompt, extractSemanticJson } from "./prompt.ts";
import {
  activeSemanticCallHistory,
  enqueueSemanticPending,
  selectSemanticPending,
  semanticDocumentEligible,
  semanticGenerationCallEligible,
  semanticRateCap,
} from "./scheduler.ts";
import {
  invalidateSemanticDerivedState,
  pruneSemanticStorage,
  readSemanticAgentDocument,
  readSemanticCache,
  readSemanticManifest,
  type SemanticManifestV1,
  type SemanticReaderResolution,
  semanticCacheKey,
  semanticConfigurationDigest,
  writeSemanticAgentDocument,
  writeSemanticCache,
  writeSemanticManifest,
} from "./storage.ts";
import { validateSemanticModelReply } from "./validate.ts";

export interface SemanticOnceOutcome {
  generation_id: string;
  source_harness: SemanticHarness;
  action: "unchanged" | "cached" | "accepted" | "unavailable" | "invalid" | "deferred";
  model_call: boolean;
  duration_ms?: number;
  input_bytes?: number;
  output_bytes?: number;
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
  if (
    manifest &&
    (manifest.ledger_genesis_id !== ledgerGenesisId ||
      manifest.configuration_digest !== configurationDigest ||
      manifest.evidence_contract_version !== SEMANTIC_EVIDENCE_CONTRACT_VERSION ||
      manifest.prompt_contract_version !== SEMANTIC_PROMPT_CONTRACT_VERSION)
  ) {
    invalidateSemanticDerivedState(input.coordRoot);
    manifest = undefined;
  }
  const current: SemanticManifestV1 =
    manifest ??
    ({
      schema_version: 1,
      ledger_genesis_id: ledgerGenesisId ?? "gex_unavailable",
      configuration_digest: configurationDigest,
      evidence_contract_version: SEMANTIC_EVIDENCE_CONTRACT_VERSION,
      prompt_contract_version: SEMANTIC_PROMPT_CONTRACT_VERSION,
      adapter_resolutions: resolutions,
      pending: [],
      call_history: [],
      updated_at: nowIso,
    } satisfies SemanticManifestV1);
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
    const pending = selectSemanticPending(eligiblePending, current.last_first_band_generation_id);
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
        input.minimumGenerationCallIntervalMs,
      )
    ) {
      heldGenerations.add(pending.generation_id);
      continue;
    }
    const prompt = buildSemanticPrompt(item);
    current.call_history.push({ generation_id: item.generation_id, started_at: nowIso });
    calls += 1;
    const result = await adapters[item.source_harness].invoke(prompt.prompt);
    const outcome = materializeAdapterResult(item, resolution, result, nowIso);
    writeSemanticAgentDocument(input.coordRoot, outcome.document);
    if (outcome.document.reader_outcome === "accepted") {
      writeSemanticCache(input.coordRoot, cacheKey, outcome.document);
      current.newest_successful_pass = nowIso;
    }
    outcomes.push({
      generation_id: item.generation_id,
      source_harness: item.source_harness,
      action: outcome.document.reader_outcome,
      model_call: true,
      duration_ms: result.duration_ms,
      input_bytes: prompt.bytes,
      ...(result.ok ? { output_bytes: result.output_bytes } : {}),
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
): { document: SemanticAgentReadModelV1 } {
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
      ),
    };
  }
  const verdict = validateSemanticModelReply(extractSemanticJson(result.text), evidence);
  if (!verdict.ok) {
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
        receipt: { reason_code: "invalid_output" },
      },
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
      meaning: verdict.value.meaning,
    },
  };
}

function unavailableDocument(
  evidence: SemanticEvidenceV1,
  resolution: SemanticReaderResolution,
  generatedAt: string,
): SemanticAgentReadModelV1 {
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
    receipt: { reason_code: resolution.reason_code ?? "model_unavailable" },
  } as SemanticAgentReadModelV1;
}

function deferredDocument(
  evidence: SemanticEvidenceV1,
  resolution: SemanticReaderResolution,
  eligibleAfter: string,
  generatedAt: string,
): SemanticAgentReadModelV1 {
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
  } as SemanticAgentReadModelV1;
}

function documentBase(evidence: SemanticEvidenceV1, generatedAt: string) {
  return {
    schema_version: 1 as const,
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

function safeManifest(coordRoot: string): SemanticManifestV1 | undefined {
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
): SemanticAgentReadModelV1 | undefined {
  try {
    return readSemanticAgentDocument(coordRoot, generationId);
  } catch {
    return undefined;
  }
}

function removePending(manifest: SemanticManifestV1, generationId: string): void {
  manifest.pending = manifest.pending.filter((item) => item.generation_id !== generationId);
}
