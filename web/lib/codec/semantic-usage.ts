import type { SemanticUsageReceiptV1 } from "../../../src/core/semantic/contract";
import type {
  SemanticUsageAggregate,
  SemanticUsageTokenTotals,
} from "../../../src/core/semantic/usage";

const TOKEN_LABELS: Record<keyof SemanticUsageTokenTotals, string> = {
  input_tokens: "input",
  cached_input_tokens: "cached read",
  cache_creation_input_tokens: "cache write",
  output_tokens: "output",
  reasoning_tokens: "reasoning",
  total_tokens: "total",
};

export function formatSemanticUsageReceipt(usage: SemanticUsageReceiptV1 | undefined): string {
  if (!usage || usage.source === "unreported") return "unreported usage";
  const prefix = usage.source === "native" ? "reported" : "estimated visible payload";
  const totals = Object.fromEntries(
    Object.entries(usage.tokens).map(([field, token]) => [field, token.value]),
  ) as SemanticUsageTokenTotals;
  const values = formatSemanticTokenTotals(totals);
  return values ? `${prefix} · ${values}` : prefix;
}

export function formatSemanticUsageAggregate(
  label: string,
  aggregate: SemanticUsageAggregate,
): string[] {
  const lines = [`${label}: ${aggregate.call_count} calls`];
  const reported = formatSemanticTokenTotals(aggregate.native_tokens);
  const estimated = formatSemanticTokenTotals(aggregate.estimated_tokens);
  const invalidReasons = Object.entries(aggregate.invalid_reasons)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .map(([reason, count]) => `${reason.replaceAll("_", " ")} ${count.toLocaleString("en-US")}`)
    .join(" · ");
  if (reported) lines.push(`reported: ${reported}`);
  if (estimated) lines.push(`estimated visible payload: ${estimated}`);
  if (invalidReasons) lines.push(`invalid reasons: ${invalidReasons}`);
  if (aggregate.unreported_calls > 0) lines.push(`unreported: ${aggregate.unreported_calls} calls`);
  if (!reported && !estimated && aggregate.unreported_calls === 0) lines.push("usage: none yet");
  return lines;
}

export function formatSemanticTokenTotals(totals: SemanticUsageTokenTotals): string {
  return Object.entries(totals)
    .filter((entry): entry is [keyof SemanticUsageTokenTotals, number] => entry[1] !== undefined)
    .map(([field, value]) => `${TOKEN_LABELS[field]} ${value.toLocaleString("en-US")}`)
    .join(" · ");
}
