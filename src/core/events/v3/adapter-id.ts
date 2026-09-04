import type { Adapter } from "../../adapter.ts";

/** Harness identities that may produce or describe Event Ledger V3 evidence. */
export type EventAdapterIdV3 = Adapter | "openclaw";

/** Canonical event-adapter census. Workflow launch adapters remain in core/adapter.ts. */
export const EVENT_ADAPTER_IDS_V3 = [
  "claude-code",
  "codex",
  "cursor",
  "openclaw",
] as const satisfies readonly EventAdapterIdV3[];
