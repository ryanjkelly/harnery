import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { canonicalJsonV2 } from "./canonical.ts";
import type { EventV2 } from "./contract.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "./generated.ts";
import { validateEventV2 } from "./validate.ts";
import { eventV2Paths } from "./writer.ts";

export type LedgerDiagnosticCodeV2 =
  | "partial_final_frame"
  | "malformed_json"
  | "unsupported_major"
  | "invalid_contract"
  | "unsupported_schema_digest"
  | "noncanonical_frame"
  | "conflicting_event_id"
  | "producer_sequence_gap";

export interface LedgerDiagnosticV2 {
  code: LedgerDiagnosticCodeV2;
  byte_offset: number;
  event_id?: string;
}

export interface PositionedEventV2 {
  event: EventV2;
  position: {
    segment_ordinal: 0;
    byte_offset: number;
  };
}

export interface ReadLedgerV2Result {
  events: PositionedEventV2[];
  diagnostics: LedgerDiagnosticV2[];
  complete: boolean;
  bytes: number;
}

export interface ReadLedgerV2Options {
  acceptedSchemaDigests?: readonly string[];
}

/** Phase-one validating reader for the active V2 segment. */
export function readActiveLedgerV2(
  coordRoot: string,
  options: ReadLedgerV2Options = {},
): ReadLedgerV2Result {
  const active = eventV2Paths(coordRoot).active;
  if (!existsSync(active)) return { events: [], diagnostics: [], complete: true, bytes: 0 };
  const raw = readFileSync(active, "utf8");
  const bytes = Buffer.byteLength(raw, "utf8");
  const diagnostics: LedgerDiagnosticV2[] = [];
  const events: PositionedEventV2[] = [];
  const seenIds = new Map<string, string>();
  const producerSequences = new Map<string, number>();
  const accepted = new Set(options.acceptedSchemaDigests ?? [EVENT_V2_SCHEMA_DIGEST]);
  const frames = raw.split("\n");
  let byteOffset = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index] ?? "";
    const frameBytes = Buffer.byteLength(frame, "utf8");
    const isFinal = index === frames.length - 1;
    if (frame.length === 0) {
      if (!isFinal) byteOffset += 1;
      continue;
    }
    if (isFinal && !raw.endsWith("\n")) {
      diagnostics.push({ code: "partial_final_frame", byte_offset: byteOffset });
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      diagnostics.push({ code: "malformed_json", byte_offset: byteOffset });
      byteOffset += frameBytes + 1;
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const contract = record.contract as Record<string, unknown> | undefined;
    if (record.schema_version === 1 || (contract && contract.major !== 2)) {
      diagnostics.push({ code: "unsupported_major", byte_offset: byteOffset });
      byteOffset += frameBytes + 1;
      continue;
    }
    const validation = validateEventV2(parsed);
    if (!validation.ok || !validation.event) {
      diagnostics.push({ code: "invalid_contract", byte_offset: byteOffset });
      byteOffset += frameBytes + 1;
      continue;
    }
    const event = validation.event;
    if (!accepted.has(event.contract.schema_digest)) {
      diagnostics.push({
        code: "unsupported_schema_digest",
        byte_offset: byteOffset,
        event_id: event.event_id,
      });
      byteOffset += frameBytes + 1;
      continue;
    }
    if (canonicalJsonV2(event) !== frame) {
      diagnostics.push({
        code: "noncanonical_frame",
        byte_offset: byteOffset,
        event_id: event.event_id,
      });
      byteOffset += frameBytes + 1;
      continue;
    }
    const priorBytes = seenIds.get(event.event_id);
    if (priorBytes !== undefined) {
      if (priorBytes !== frame) {
        diagnostics.push({
          code: "conflicting_event_id",
          byte_offset: byteOffset,
          event_id: event.event_id,
        });
      }
      byteOffset += frameBytes + 1;
      continue;
    }
    seenIds.set(event.event_id, frame);
    const sequenceKey = `${event.producer.producer_id}\0${event.producer.boot_id}`;
    const priorSequence = producerSequences.get(sequenceKey);
    if (priorSequence !== undefined && event.producer.sequence !== priorSequence + 1) {
      diagnostics.push({
        code: "producer_sequence_gap",
        byte_offset: byteOffset,
        event_id: event.event_id,
      });
    }
    producerSequences.set(sequenceKey, event.producer.sequence);
    events.push({ event, position: { segment_ordinal: 0, byte_offset: byteOffset } });
    byteOffset += frameBytes + 1;
  }
  return {
    events,
    diagnostics,
    complete: diagnostics.length === 0,
    bytes,
  };
}
