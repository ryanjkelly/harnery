import { type EventV3ActiveTailV3, readEventV3ActiveTailV3 } from "../events/v3/reader.ts";
import type { SupervisorCapability, SupervisorSourceReference } from "../supervisor/contract.ts";

export interface CoordinationHealthDiagnostic {
  code: "malformed_json" | "invalid_contract";
  byte_offset: number;
  segment_ordinal: number;
  event_id?: string;
}

export interface CoordinationHealthSnapshot {
  observed_at: string;
  capability: SupervisorCapability;
  recent_events: readonly SupervisorSourceReference[];
  diagnostics: readonly CoordinationHealthDiagnostic[];
  omitted_event_count: number;
}

const MAX_EVENT_REFERENCES = 64;
const MAX_DIAGNOSTICS = 16;
const MAX_TAIL_BYTES = 256 * 1_024;

/** Read bounded V3 references without retaining event payloads or the full ledger reader. */
export function collectCoordinationHealthSnapshot(
  coordRoot: string,
  now = new Date(),
): CoordinationHealthSnapshot {
  const observedAt = now.toISOString();
  let tail: EventV3ActiveTailV3;
  try {
    tail = readEventV3ActiveTailV3(coordRoot, MAX_TAIL_BYTES);
  } catch {
    return unavailable(observedAt, "tail-read-failed", "error");
  }
  if (tail.status === "missing") return unavailable(observedAt, "ledger-missing");
  if (tail.status === "unsafe") return unavailable(observedAt, "ledger-unsafe");
  try {
    const start = tail.start;
    const lines = tail.bytes.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const completeLines = lines.filter((line) => line.length > 0);
    const diagnostics: CoordinationHealthDiagnostic[] = [];
    const references: SupervisorSourceReference[] = [];
    let byteOffset = start;
    for (const line of completeLines) {
      const reference = parseReference(line);
      if (reference) references.push(reference);
      else if (diagnostics.length < MAX_DIAGNOSTICS) {
        diagnostics.push({
          code: line.trimStart().startsWith("{") ? "invalid_contract" : "malformed_json",
          byte_offset: byteOffset,
          segment_ordinal: 1,
        });
      }
      byteOffset += Buffer.byteLength(line) + 1;
    }
    const recent = references.slice(-MAX_EVENT_REFERENCES);
    return available(
      observedAt,
      recent,
      diagnostics,
      Math.max(0, references.length - recent.length) + (start > 0 ? 1 : 0),
    );
  } catch {
    return unavailable(observedAt, "tail-read-failed", "error");
  }
}

function parseReference(line: string): SupervisorSourceReference | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const contract = object(value.contract);
    const time = object(value.time);
    const producer = object(value.producer);
    if (
      contract.major !== 3 ||
      typeof value.event_id !== "string" ||
      typeof value.event_type !== "string" ||
      typeof time.observed_at !== "string" ||
      typeof producer.sequence !== "number" ||
      !Number.isSafeInteger(producer.sequence)
    )
      return undefined;
    return {
      id: `v3:${value.event_id}`,
      source_kind: "coordination.v3",
      source_id: value.event_type,
      record_id: value.event_id,
      sequence: producer.sequence,
      schema_version: 3,
      observed_at: time.observed_at,
      capability: "supported",
    };
  } catch {
    return undefined;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function available(
  observedAt: string,
  recentEvents: readonly SupervisorSourceReference[],
  diagnostics: readonly CoordinationHealthDiagnostic[],
  omittedEventCount: number,
): CoordinationHealthSnapshot {
  const state = diagnostics.length === 0 ? "supported" : "partial";
  return {
    observed_at: observedAt,
    capability: {
      source_kind: "coordination.v3.references",
      state,
      ...(state === "partial" ? { reason_code: diagnostics[0]?.code ?? "tail-invalid" } : {}),
    },
    recent_events: recentEvents.map((reference) => ({ ...reference, capability: state })),
    diagnostics,
    omitted_event_count: omittedEventCount,
  };
}

function unavailable(
  observedAt: string,
  reasonCode: string,
  state: "unsupported" | "error" = "unsupported",
): CoordinationHealthSnapshot {
  return {
    observed_at: observedAt,
    capability: { source_kind: "coordination.v3.references", state, reason_code: reasonCode },
    recent_events: [],
    diagnostics: [],
    omitted_event_count: 0,
  };
}
