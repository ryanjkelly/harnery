import type { LatencyMetricV3 } from "./latency.ts";
import type { ReadLedgerV3Result } from "./reader.ts";

export const EVENT_V3_ECONOMICS_PROJECTION_VERSION = "event-v3-economics-v1" as const;

export interface TokenTotalsV3 {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export type TokenTotalsMetricV3 =
  | { state: "observed"; value: TokenTotalsV3 }
  | { state: "unknown"; known: TokenTotalsV3; reasons: string[] };

export type CostMetricV3 =
  | { state: "observed"; usd: number; pricing_key: string }
  | { state: "unknown"; known_usd: number; reasons: string[] };

export interface ModelPricingV3 {
  input_usd_per_million: number;
  output_usd_per_million: number;
  cache_read_usd_per_million?: number;
  cache_write_usd_per_million?: number;
}

export interface EconomicsProjectionOptionsV3 {
  pricing?: Record<string, ModelPricingV3>;
}

export interface TurnEconomicsV3 {
  generation_id: string;
  turn_id: string;
  terminal_event_id: string;
  model_key: string | null;
  usage_method: string | null;
  tokens: TokenTotalsMetricV3;
  inference_ms: LatencyMetricV3;
  harness_ms: LatencyMetricV3;
  cost: CostMetricV3;
}

export interface GenerationEconomicsV3 {
  generation_id: string;
  turn_count: number;
  tokens: TokenTotalsMetricV3;
  inference_ms: LatencyMetricV3;
  harness_ms: LatencyMetricV3;
  cost: CostMetricV3;
}

export interface EconomicsProjectionV3 {
  projection_version: typeof EVENT_V3_ECONOMICS_PROJECTION_VERSION;
  turns: TurnEconomicsV3[];
  generations: GenerationEconomicsV3[];
}

export type DelegationRollupDiagnosticCodeV3 = "delegation_cycle" | "generation_economics_missing";

export interface DelegationRollupV3 {
  root_generation_id: string;
  generation_ids: string[];
  tokens: TokenTotalsMetricV3;
  inference_ms: LatencyMetricV3;
  harness_ms: LatencyMetricV3;
  cost: CostMetricV3;
  diagnostics: Array<{
    code: DelegationRollupDiagnosticCodeV3;
    generation_id: string;
  }>;
}

interface EventShape {
  event_id: string;
  event_type: string;
  scope: { generation_id?: string; turn_id?: string };
  payload: Record<string, unknown>;
}

export function projectEconomicsV3(
  read: ReadLedgerV3Result,
  options: EconomicsProjectionOptionsV3 = {},
): EconomicsProjectionV3 {
  if (!read.complete) throw new Error("economics projection requires a complete V3 ledger read");
  const models = new Map<string, string | null>();
  const turns: TurnEconomicsV3[] = [];
  for (const positioned of read.events) {
    const event = positioned.event as unknown as EventShape;
    const generationId = event.scope.generation_id;
    if (
      generationId &&
      (event.event_type === "session.started" || event.event_type === "session.attestation_changed")
    ) {
      models.set(generationId, modelKey(event.payload.runtime_attestation));
    }
    if (event.event_type !== "turn.completed") continue;
    const tokens = tokensFromObservation(event.payload.usage);
    const model = generationId ? (models.get(generationId) ?? null) : null;
    turns.push({
      generation_id: generationId ?? "",
      turn_id: event.scope.turn_id ?? "",
      terminal_event_id: event.event_id,
      model_key: model,
      usage_method: usageMethod(event.payload.usage),
      tokens,
      inference_ms: timingFromObservation(
        event.payload.inference,
        "api_time_ms",
        "inference_unknown",
      ),
      harness_ms: timingFromObservation(event.payload.harness, "hook_time_ms", "harness_unknown"),
      cost: costForTurn(tokens, model, options.pricing),
    });
  }
  const grouped = new Map<string, TurnEconomicsV3[]>();
  for (const turn of turns) {
    const generationTurns = grouped.get(turn.generation_id) ?? [];
    generationTurns.push(turn);
    grouped.set(turn.generation_id, generationTurns);
  }
  const generations = [...grouped.entries()].map(([generationId, generationTurns]) => ({
    generation_id: generationId,
    turn_count: generationTurns.length,
    tokens: sumTokenMetrics(generationTurns.map(({ tokens }) => tokens)),
    inference_ms: sumTimingMetrics(generationTurns.map(({ inference_ms }) => inference_ms)),
    harness_ms: sumTimingMetrics(generationTurns.map(({ harness_ms }) => harness_ms)),
    cost: sumCostMetrics(generationTurns.map(({ cost }) => cost)),
  }));
  generations.sort((left, right) => left.generation_id.localeCompare(right.generation_id));
  return { projection_version: EVENT_V3_ECONOMICS_PROJECTION_VERSION, turns, generations };
}

export function projectDelegationRollupV3(
  read: ReadLedgerV3Result,
  economics: EconomicsProjectionV3,
  rootGenerationId: string,
): DelegationRollupV3 {
  if (!read.complete) throw new Error("delegation rollup requires a complete V3 ledger read");
  const children = new Map<string, Set<string>>();
  for (const positioned of read.events) {
    const event = positioned.event as unknown as EventShape;
    if (event.event_type !== "agent.completed") continue;
    const parent = event.scope.generation_id;
    const child = string(event.payload.child_generation_id);
    if (!parent || !child) continue;
    const set = children.get(parent) ?? new Set<string>();
    set.add(child);
    children.set(parent, set);
  }

  const generationIds: string[] = [];
  const diagnostics: DelegationRollupV3["diagnostics"] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (generationId: string): void => {
    if (active.has(generationId)) {
      diagnostics.push({ code: "delegation_cycle", generation_id: generationId });
      return;
    }
    if (visited.has(generationId)) return;
    visited.add(generationId);
    active.add(generationId);
    generationIds.push(generationId);
    for (const child of [...(children.get(generationId) ?? [])].sort()) visit(child);
    active.delete(generationId);
  };
  visit(rootGenerationId);

  const byGeneration = new Map(
    economics.generations.map((generation) => [generation.generation_id, generation]),
  );
  const included = generationIds.flatMap((generationId) => {
    const generation = byGeneration.get(generationId);
    if (generation) return [generation];
    diagnostics.push({ code: "generation_economics_missing", generation_id: generationId });
    return [];
  });
  const missing = diagnostics
    .filter(({ code }) => code === "generation_economics_missing")
    .map(({ generation_id }) => `generation_economics_missing:${generation_id}`);
  return {
    root_generation_id: rootGenerationId,
    generation_ids: generationIds,
    tokens: sumTokenMetrics([
      ...included.map(({ tokens }) => tokens),
      ...missing.map((reason) => ({
        state: "unknown" as const,
        known: zeroTokens(),
        reasons: [reason],
      })),
    ]),
    inference_ms: sumTimingMetrics([
      ...included.map(({ inference_ms }) => inference_ms),
      ...missing.map((reason) => ({ state: "unknown" as const, known_ms: 0, reasons: [reason] })),
    ]),
    harness_ms: sumTimingMetrics([
      ...included.map(({ harness_ms }) => harness_ms),
      ...missing.map((reason) => ({ state: "unknown" as const, known_ms: 0, reasons: [reason] })),
    ]),
    cost: sumCostMetrics([
      ...included.map(({ cost }) => cost),
      ...missing.map((reason) => ({ state: "unknown" as const, known_usd: 0, reasons: [reason] })),
    ]),
    diagnostics,
  };
}

function modelKey(runtimeAttestation: unknown): string | null {
  const model = record(record(runtimeAttestation).model);
  if (model.state !== "observed") return null;
  const value = record(model.value);
  const provider = string(value.provider);
  const id = string(value.id);
  return provider && id ? `${provider}/${id}` : null;
}

function tokensFromObservation(value: unknown): TokenTotalsMetricV3 {
  const observation = record(value);
  if (observation.state !== "observed") {
    return { state: "unknown", known: zeroTokens(), reasons: [observationReason(value)] };
  }
  const usage = record(observation.value);
  if (!nonnegative(usage.input_tokens) || !nonnegative(usage.output_tokens)) {
    return { state: "unknown", known: zeroTokens(), reasons: ["usage_invalid"] };
  }
  return {
    state: "observed",
    value: {
      input_tokens: usage.input_tokens as number,
      output_tokens: usage.output_tokens as number,
      cache_read_tokens: nonnegative(usage.cache_read_tokens)
        ? (usage.cache_read_tokens as number)
        : 0,
      cache_write_tokens: nonnegative(usage.cache_write_tokens)
        ? (usage.cache_write_tokens as number)
        : 0,
    },
  };
}

function usageMethod(value: unknown): string | null {
  const observation = record(value);
  return observation.state === "observed" ? string(record(observation.value).method) || null : null;
}

function timingFromObservation(value: unknown, field: string, fallback: string): LatencyMetricV3 {
  const observation = record(value);
  const fieldValue = record(observation.value)[field];
  return observation.state === "observed" && nonnegative(fieldValue)
    ? { state: "observed", value_ms: fieldValue as number }
    : { state: "unknown", known_ms: 0, reasons: [observationReason(value) || fallback] };
}

function costForTurn(
  tokens: TokenTotalsMetricV3,
  model: string | null,
  pricing: Record<string, ModelPricingV3> | undefined,
): CostMetricV3 {
  const reasons: string[] = tokens.state === "unknown" ? ["usage_unknown"] : [];
  const tokenValue = tokens.state === "observed" ? tokens.value : tokens.known;
  if (!model)
    return { state: "unknown", known_usd: 0, reasons: [...reasons, "model_unknown"].sort() };
  const rates = pricing?.[model];
  if (!rates) {
    return {
      state: "unknown",
      known_usd: 0,
      reasons: [...reasons, `pricing_unavailable:${model}`].sort(),
    };
  }
  if (tokenValue.cache_read_tokens > 0 && rates.cache_read_usd_per_million === undefined) {
    reasons.push("cache_read_pricing_unavailable");
  }
  if (tokenValue.cache_write_tokens > 0 && rates.cache_write_usd_per_million === undefined) {
    reasons.push("cache_write_pricing_unavailable");
  }
  const usd =
    (tokenValue.input_tokens * rates.input_usd_per_million +
      tokenValue.output_tokens * rates.output_usd_per_million +
      tokenValue.cache_read_tokens * (rates.cache_read_usd_per_million ?? 0) +
      tokenValue.cache_write_tokens * (rates.cache_write_usd_per_million ?? 0)) /
    1_000_000;
  return reasons.length > 0
    ? { state: "unknown", known_usd: roundUsd(usd), reasons }
    : { state: "observed", usd: roundUsd(usd), pricing_key: model };
}

function sumTokenMetrics(metrics: TokenTotalsMetricV3[]): TokenTotalsMetricV3 {
  const total = zeroTokens();
  const reasons: string[] = [];
  for (const metric of metrics) {
    addTokens(total, metric.state === "observed" ? metric.value : metric.known);
    if (metric.state === "unknown") reasons.push(...metric.reasons);
  }
  return reasons.length === 0
    ? { state: "observed", value: total }
    : { state: "unknown", known: total, reasons: unique(reasons) };
}

function sumTimingMetrics(metrics: LatencyMetricV3[]): LatencyMetricV3 {
  let known = 0;
  const reasons: string[] = [];
  for (const metric of metrics) {
    known += metric.state === "observed" ? metric.value_ms : metric.known_ms;
    if (metric.state === "unknown") reasons.push(...metric.reasons);
  }
  return reasons.length === 0
    ? { state: "observed", value_ms: known }
    : { state: "unknown", known_ms: known, reasons: unique(reasons) };
}

function sumCostMetrics(metrics: CostMetricV3[]): CostMetricV3 {
  let known = 0;
  const reasons: string[] = [];
  const keys = new Set<string>();
  for (const metric of metrics) {
    known += metric.state === "observed" ? metric.usd : metric.known_usd;
    if (metric.state === "observed") keys.add(metric.pricing_key);
    else reasons.push(...metric.reasons);
  }
  return reasons.length === 0
    ? { state: "observed", usd: roundUsd(known), pricing_key: [...keys].sort().join("+") }
    : { state: "unknown", known_usd: roundUsd(known), reasons: unique(reasons) };
}

function zeroTokens(): TokenTotalsV3 {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
}

function addTokens(target: TokenTotalsV3, value: TokenTotalsV3): void {
  target.input_tokens += value.input_tokens;
  target.output_tokens += value.output_tokens;
  target.cache_read_tokens += value.cache_read_tokens;
  target.cache_write_tokens += value.cache_write_tokens;
}

function nonnegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function observationReason(value: unknown): string {
  const observation = record(value);
  const state = string(observation.state) || "unknown";
  const reason = string(observation.reason);
  return reason ? `${state}:${reason}` : state;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
