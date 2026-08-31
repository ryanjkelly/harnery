import { type LedgerDiagnosticV3, readLedgerV3 } from "../events/v3/reader.ts";
import type { SupervisorCapability, SupervisorSourceReference } from "../supervisor/contract.ts";

export interface CoordinationHealthSnapshot {
  observed_at: string;
  capability: SupervisorCapability;
  recent_events: readonly SupervisorSourceReference[];
  diagnostics: readonly LedgerDiagnosticV3[];
  omitted_event_count: number;
}

const MAX_EVENT_REFERENCES = 64;
const MAX_DIAGNOSTICS = 16;

/**
 * Read coordination health without copying event payloads into the supervisor cache.
 * The returned event entries are stable V3 references only.
 */
export function collectCoordinationHealthSnapshot(
  coordRoot: string,
  now = new Date(),
): CoordinationHealthSnapshot {
  const observedAt = now.toISOString();
  try {
    const ledger = readLedgerV3(coordRoot, { authority: "active" });
    const positioned = ledger.events.slice(-MAX_EVENT_REFERENCES);
    return {
      observed_at: observedAt,
      capability: {
        source_kind: "coordination.v3",
        state: ledger.complete ? "supported" : "partial",
        ...(!ledger.complete
          ? {
              reason_code: ledger.diagnostics[0]?.code ?? "incomplete-ledger",
              detail: "The active V3 authority did not validate completely.",
            }
          : {}),
      },
      recent_events: positioned.map(({ event }) => ({
        id: `v3:${event.event_id}`,
        source_kind: "coordination.v3",
        source_id: event.event_type,
        record_id: event.event_id,
        sequence: event.producer.sequence,
        schema_version: 3,
        observed_at: event.time.observed_at,
        capability: ledger.complete ? "supported" : "partial",
      })),
      diagnostics: ledger.diagnostics.slice(0, MAX_DIAGNOSTICS),
      omitted_event_count: Math.max(0, ledger.events.length - positioned.length),
    };
  } catch (error) {
    return {
      observed_at: observedAt,
      capability: {
        source_kind: "coordination.v3",
        state: "error",
        reason_code: "ledger-read-failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      recent_events: [],
      diagnostics: [],
      omitted_event_count: 0,
    };
  }
}
