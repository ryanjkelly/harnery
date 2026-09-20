/** First-party harness adapters supported by Harnery's canonical V3 ledger. */
export type Adapter = "claude-code" | "cursor" | "codex" | "opencode";

/** Canonical producer classes used by V3 provenance. */
export type EventSource = "agent-hooks" | "agent-coord" | "user" | "system";

/**
 * Runtime census of the workflow adapters. Adding a member to `Adapter`
 * without listing it here is a compile error (see `adaptersComplete`), so a
 * new adapter can never slip past the shared normalizer.
 */
export const ADAPTERS = [
  "claude-code",
  "cursor",
  "codex",
  "opencode",
] as const satisfies readonly Adapter[];

type MissingAdapter = Exclude<Adapter, (typeof ADAPTERS)[number]>;
const adaptersComplete: [MissingAdapter] extends [never] ? true : never = true;
void adaptersComplete;

/** Every adapter falls back to this identity when a platform value carries no usable evidence. */
export const DEFAULT_ADAPTER: Adapter = "claude-code";

/** Why a platform value could not be normalized to a known adapter. */
export type AdapterFallbackReason = "missing" | "unknown";

export interface AdapterFallback {
  /** The raw value that was normalized. */
  value: unknown;
  /** `missing` for null, undefined, or an empty string; `unknown` for anything else. */
  reason: AdapterFallbackReason;
  /** The adapter that was substituted. */
  fallback: string;
  /** Caller-supplied label naming the code path, for the diagnostic line. */
  context?: string;
}

export interface AdapterFallbackOptions {
  /** Names the caller in the diagnostic line, e.g. `"claim-conflict"`. */
  context?: string;
  /**
   * Receives every fallback. The default writes one stderr line per unknown
   * value; a missing value is a pre-heartbeat state rather than a
   * misattribution, so it is passed here but not printed.
   */
  onFallback?: (fallback: AdapterFallback) => void;
}

/**
 * Generic membership normalizer shared by every adapter census. Returns the
 * matching id or `null`; it never substitutes a default.
 */
export function normalizeAdapterId<T extends string>(
  value: unknown,
  census: readonly T[],
): T | null {
  if (typeof value !== "string") return null;
  return (census as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * Normalize with an explicit, reported fallback. Every caller that must end up
 * with *some* adapter routes through here so the substitution is visible.
 */
export function resolveAdapterId<T extends string>(
  value: unknown,
  census: readonly T[],
  fallback: T,
  options: AdapterFallbackOptions = {},
): T {
  const normalized = normalizeAdapterId(value, census);
  if (normalized !== null) return normalized;
  const reason: AdapterFallbackReason =
    value === undefined || value === null || value === "" ? "missing" : "unknown";
  (options.onFallback ?? reportAdapterFallback)({
    value,
    reason,
    fallback,
    context: options.context,
  });
  return fallback;
}

/** Default fallback sink: one stderr line for an unrecognized platform value. */
export function reportAdapterFallback(fallback: AdapterFallback): void {
  if (fallback.reason !== "unknown") return;
  const where = fallback.context ? ` (${fallback.context})` : "";
  process.stderr.write(
    `harnery: unknown adapter platform ${JSON.stringify(fallback.value)}${where}; treating it as ${fallback.fallback}\n`,
  );
}

/** Strict workflow-adapter normalizer: a known id or `null`. */
export function normalizeAdapter(value: unknown): Adapter | null {
  return normalizeAdapterId(value, ADAPTERS);
}

/**
 * Heartbeat `platform` (or any adapter-shaped string) to a workflow adapter,
 * substituting `DEFAULT_ADAPTER` and reporting the substitution.
 */
export function adapterFromPlatform(value: unknown, options?: AdapterFallbackOptions): Adapter {
  return resolveAdapterId(value, ADAPTERS, DEFAULT_ADAPTER, options);
}
