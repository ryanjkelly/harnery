import { countTokens } from "gpt-tokenizer/model/gpt-4o";
import {
  SEMANTIC_USAGE_SCHEMA_VERSION,
  SEMANTIC_VISIBLE_USAGE_ESTIMATOR_ID,
  SEMANTIC_VISIBLE_USAGE_ESTIMATOR_VERSION,
  type SemanticConfiguredModel,
  type SemanticHarness,
  type SemanticUsageReceiptV1,
  type SemanticUsageToken,
} from "./contract.ts";

export const SEMANTIC_USAGE_TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "total_tokens",
] as const;

export type SemanticUsageTokenField = (typeof SEMANTIC_USAGE_TOKEN_FIELDS)[number];
export type SemanticUsageTokenTotals = Partial<Record<SemanticUsageTokenField, number>>;
export type SemanticUsageOutcome = "accepted" | "invalid" | "unavailable" | "deferred";

export interface SemanticUsageEvent {
  source_harness?: SemanticHarness;
  configured_model?: SemanticConfiguredModel;
  resolved_model_id?: string;
  model_attestation?: "verified" | "requested-only";
  action?: string;
  model_call: boolean;
  usage?: SemanticUsageReceiptV1;
}

export interface SemanticUsageBreakdown {
  harness?: SemanticHarness;
  configured_model?: SemanticConfiguredModel;
  resolved_model_id?: string;
  model_attestation?: "verified" | "requested-only";
  call_count: number;
  outcomes: Record<SemanticUsageOutcome, number>;
  native_tokens: SemanticUsageTokenTotals;
  estimated_tokens: SemanticUsageTokenTotals;
  unreported_calls: number;
}

export interface SemanticUsageAggregate {
  call_count: number;
  outcomes: Record<SemanticUsageOutcome, number>;
  native_tokens: SemanticUsageTokenTotals;
  estimated_tokens: SemanticUsageTokenTotals;
  unreported_calls: number;
  breakdowns: SemanticUsageBreakdown[];
}

export function nativeSemanticUsage(
  values: Partial<Record<SemanticUsageTokenField, unknown>>,
): SemanticUsageReceiptV1 | undefined {
  const tokens: Partial<Record<SemanticUsageTokenField, SemanticUsageToken>> = {};
  for (const field of SEMANTIC_USAGE_TOKEN_FIELDS) {
    const value = nonNegativeInteger(values[field]);
    if (value !== undefined) tokens[field] = { value, provenance: "native" };
  }
  if (Object.keys(tokens).length === 0) return undefined;
  return {
    schema_version: SEMANTIC_USAGE_SCHEMA_VERSION,
    source: "native",
    scope: "harness-call",
    tokens,
  } as SemanticUsageReceiptV1;
}

export function estimateVisibleSemanticUsage(
  prompt: string,
  response: string,
): SemanticUsageReceiptV1 {
  const input = countTokens(prompt);
  const output = countTokens(response);
  return {
    schema_version: SEMANTIC_USAGE_SCHEMA_VERSION,
    source: "estimated",
    scope: "visible-payload",
    estimator: {
      id: SEMANTIC_VISIBLE_USAGE_ESTIMATOR_ID,
      version: SEMANTIC_VISIBLE_USAGE_ESTIMATOR_VERSION,
    },
    tokens: {
      input_tokens: { value: input, provenance: "estimated" },
      output_tokens: { value: output, provenance: "estimated" },
      total_tokens: { value: input + output, provenance: "estimated" },
    },
  };
}

export function unreportedSemanticUsage(): SemanticUsageReceiptV1 {
  return {
    schema_version: SEMANTIC_USAGE_SCHEMA_VERSION,
    source: "unreported",
    scope: "unreported",
  };
}

export function aggregateSemanticUsage(
  events: readonly SemanticUsageEvent[],
): SemanticUsageAggregate {
  const aggregate = emptySemanticUsageAggregate();
  const rows = new Map<string, SemanticUsageBreakdown>();
  for (const event of events) {
    const outcome = semanticUsageOutcome(event.action);
    if (outcome) aggregate.outcomes[outcome] += 1;
    if (event.model_call) {
      aggregate.call_count += 1;
      addReceipt(aggregate, event.usage);
    }
    if (!outcome && !event.model_call) continue;
    const key = [
      event.source_harness ?? "unattributed",
      event.configured_model ?? "unattributed",
      event.resolved_model_id ?? "unresolved",
      event.model_attestation ?? "unattested",
    ].join("\u0000");
    const row = rows.get(key) ?? {
      ...(event.source_harness ? { harness: event.source_harness } : {}),
      ...(event.configured_model ? { configured_model: event.configured_model } : {}),
      ...(event.resolved_model_id ? { resolved_model_id: event.resolved_model_id } : {}),
      ...(event.model_attestation ? { model_attestation: event.model_attestation } : {}),
      call_count: 0,
      outcomes: emptyOutcomes(),
      native_tokens: {},
      estimated_tokens: {},
      unreported_calls: 0,
    };
    if (outcome) row.outcomes[outcome] += 1;
    if (event.model_call) {
      row.call_count += 1;
      addReceipt(row, event.usage);
    }
    rows.set(key, row);
  }
  aggregate.breakdowns = [...rows.values()].sort((left, right) =>
    `${left.harness ?? ""}/${left.configured_model ?? ""}/${left.resolved_model_id ?? ""}`.localeCompare(
      `${right.harness ?? ""}/${right.configured_model ?? ""}/${right.resolved_model_id ?? ""}`,
    ),
  );
  return aggregate;
}

export function mergeSemanticUsageAggregates(
  left: SemanticUsageAggregate,
  right: SemanticUsageAggregate,
): SemanticUsageAggregate {
  const merged = emptySemanticUsageAggregate();
  merged.call_count = left.call_count + right.call_count;
  merged.unreported_calls = left.unreported_calls + right.unreported_calls;
  for (const outcome of Object.keys(merged.outcomes) as SemanticUsageOutcome[]) {
    merged.outcomes[outcome] = left.outcomes[outcome] + right.outcomes[outcome];
  }
  addTotals(merged.native_tokens, left.native_tokens);
  addTotals(merged.native_tokens, right.native_tokens);
  addTotals(merged.estimated_tokens, left.estimated_tokens);
  addTotals(merged.estimated_tokens, right.estimated_tokens);
  const rows = new Map<string, SemanticUsageBreakdown>();
  for (const row of [...left.breakdowns, ...right.breakdowns]) {
    const key = [
      row.harness ?? "unattributed",
      row.configured_model ?? "unattributed",
      row.resolved_model_id ?? "unresolved",
      row.model_attestation ?? "unattested",
    ].join("\u0000");
    const prior = rows.get(key);
    if (!prior) {
      rows.set(key, structuredClone(row));
      continue;
    }
    prior.call_count += row.call_count;
    prior.unreported_calls += row.unreported_calls;
    for (const outcome of Object.keys(prior.outcomes) as SemanticUsageOutcome[]) {
      prior.outcomes[outcome] += row.outcomes[outcome];
    }
    addTotals(prior.native_tokens, row.native_tokens);
    addTotals(prior.estimated_tokens, row.estimated_tokens);
  }
  merged.breakdowns = [...rows.values()];
  return merged;
}

export function emptySemanticUsageAggregate(): SemanticUsageAggregate {
  return {
    call_count: 0,
    outcomes: emptyOutcomes(),
    native_tokens: {},
    estimated_tokens: {},
    unreported_calls: 0,
    breakdowns: [],
  };
}

function addReceipt(
  target: Pick<SemanticUsageAggregate, "native_tokens" | "estimated_tokens" | "unreported_calls">,
  usage: SemanticUsageReceiptV1 | undefined,
): void {
  if (!usage || usage.source === "unreported") {
    target.unreported_calls += 1;
    return;
  }
  for (const field of SEMANTIC_USAGE_TOKEN_FIELDS) {
    const token = usage.tokens[field as keyof typeof usage.tokens] as
      | SemanticUsageToken
      | undefined;
    if (!token) continue;
    const totals = token.provenance === "native" ? target.native_tokens : target.estimated_tokens;
    totals[field] = (totals[field] ?? 0) + token.value;
  }
}

function addTotals(target: SemanticUsageTokenTotals, source: SemanticUsageTokenTotals): void {
  for (const field of SEMANTIC_USAGE_TOKEN_FIELDS) {
    if (source[field] !== undefined) target[field] = (target[field] ?? 0) + source[field]!;
  }
}

function emptyOutcomes(): Record<SemanticUsageOutcome, number> {
  return { accepted: 0, invalid: 0, unavailable: 0, deferred: 0 };
}

function semanticUsageOutcome(value: string | undefined): SemanticUsageOutcome | undefined {
  return value === "accepted" ||
    value === "invalid" ||
    value === "unavailable" ||
    value === "deferred"
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
