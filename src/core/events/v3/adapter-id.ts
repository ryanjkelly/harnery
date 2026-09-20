import {
  type Adapter,
  type AdapterFallbackOptions,
  DEFAULT_ADAPTER,
  normalizeAdapterId,
  resolveAdapterId,
} from "../../adapter.ts";

/** Harness identities that may produce or describe Event Ledger V3 evidence. */
export type EventAdapterIdV3 = Adapter | "openclaw";

/** Canonical event-adapter census. Workflow launch adapters remain in core/adapter.ts. */
export const EVENT_ADAPTER_IDS_V3 = [
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "openclaw",
] as const satisfies readonly EventAdapterIdV3[];

type MissingEventAdapterId = Exclude<EventAdapterIdV3, (typeof EVENT_ADAPTER_IDS_V3)[number]>;
const eventAdapterIdsComplete: [MissingEventAdapterId] extends [never] ? true : never = true;
void eventAdapterIdsComplete;

/** Strict event-adapter normalizer: a known id or `null`. */
export function normalizeEventAdapterIdV3(value: unknown): EventAdapterIdV3 | null {
  return normalizeAdapterId(value, EVENT_ADAPTER_IDS_V3);
}

/**
 * Heartbeat `platform` to an event adapter id, substituting `DEFAULT_ADAPTER`
 * and reporting the substitution. Use this wherever a row must be attributed
 * to some adapter; use `normalizeEventAdapterIdV3` when `null` is acceptable.
 */
export function eventAdapterIdV3FromPlatform(
  value: unknown,
  options?: AdapterFallbackOptions,
): EventAdapterIdV3 {
  return resolveAdapterId(value, EVENT_ADAPTER_IDS_V3, DEFAULT_ADAPTER, options);
}
