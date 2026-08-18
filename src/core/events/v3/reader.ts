import { canonicalJsonV2 } from "../v2/canonical.ts";
import type { EventV3 } from "./contract.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { validateEventV3 } from "./validate.ts";

export type LedgerDiagnosticCodeV3 =
  | "malformed_json"
  | "unsupported_major"
  | "invalid_contract"
  | "unsupported_schema_digest"
  | "unexpected_schema_digest"
  | "noncanonical_frame"
  | "conflicting_event_id"
  | "causal_parent_missing"
  | "wall_clock_regression_unmarked"
  | "monotonic_clock_regression"
  | "producer_sequence_gap"
  | "unresolved_attestation"
  | "missing_genesis"
  | "multiple_genesis"
  | "genesis_not_first"
  | "genesis_digest_mismatch"
  | "missing_activation"
  | "activation_genesis_mismatch"
  | "advance_prior_mismatch"
  | "advance_reader_incompatible"
  | "advance_digest_unsupported"
  | "advance_boundary_invalid"
  | "advance_boundary_missed"
  | "cursor_genesis_mismatch"
  | "cursor_position_missing";

export interface LedgerDiagnosticV3 {
  code: LedgerDiagnosticCodeV3;
  byte_offset: number;
  segment_ordinal: number;
  event_id?: string;
}

export interface LedgerFrameV3 {
  raw: string;
  position: {
    segment_ordinal: number;
    byte_offset: number;
  };
}

export interface PositionedEventV3 {
  event: EventV3;
  position: LedgerFrameV3["position"];
}

export interface SchemaAdvanceV3 {
  event_id: string;
  prior_schema_digest: string;
  next_schema_digest: string;
  effective_position: LedgerFrameV3["position"];
}

export interface ReadLedgerV3Options {
  authority?: "candidate" | "active";
  reader_build?: string;
  accepted_schema_digests?: readonly string[];
}

export interface ReadLedgerV3Result {
  events: PositionedEventV3[];
  diagnostics: LedgerDiagnosticV3[];
  complete: boolean;
  genesis_id?: string;
  active_schema_digest?: string;
  advances: SchemaAdvanceV3[];
}

export interface LedgerCursorV3 {
  genesis_id: string;
  segment_ordinal: number;
  byte_offset: number;
  event_id: string;
}

export interface ReadLedgerV3SinceResult extends ReadLedgerV3Result {
  cursor?: LedgerCursorV3;
  reset_required: boolean;
}

interface PendingAdvance {
  event_id: string;
  next_schema_digest: string;
  position: LedgerFrameV3["position"];
}

interface EventShape {
  contract: { schema_digest: string };
  event_id: string;
  event_type: string;
  time: {
    observed_at: string;
    clock_id: string;
    monotonic_ns?: string;
    skew: string;
  };
  producer: { producer_id: string; boot_id: string; sequence: number };
  links: { caused_by: string[] };
  attestation_id?: string;
  payload: Record<string, unknown>;
}

/**
 * Validate an already-discovered V3 event stream in exact physical order.
 * Filesystem/catalog discovery feeds this boundary; every downstream reader
 * and projection consumes its positioned, authority-checked result.
 */
export function readLedgerFramesV3(
  frames: readonly LedgerFrameV3[],
  options: ReadLedgerV3Options = {},
): ReadLedgerV3Result {
  const diagnostics: LedgerDiagnosticV3[] = [];
  const events: PositionedEventV3[] = [];
  const advances: SchemaAdvanceV3[] = [];
  const accepted = new Set(options.accepted_schema_digests ?? [EVENT_V3_SCHEMA_DIGEST]);
  const readerBuild = options.reader_build ?? "build_harnery-v3";
  const seenIds = new Map<string, string>();
  const producerSequences = new Map<string, number>();
  const attestations = new Set<string>();
  const clocks = new Map<string, { observed_at_ms: number; monotonic_ns?: bigint }>();
  let genesisId: string | undefined;
  let activeSchemaDigest: string | undefined;
  let pending: PendingAdvance | undefined;

  for (const frame of frames) {
    if (pending) {
      const comparison = comparePosition(frame.position, pending.position);
      if (comparison === 0) {
        activeSchemaDigest = pending.next_schema_digest;
        pending = undefined;
      } else if (comparison > 0) {
        diagnostics.push(diagnostic("advance_boundary_missed", frame, pending.event_id));
        pending = undefined;
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.raw);
    } catch {
      diagnostics.push(diagnostic("malformed_json", frame));
      continue;
    }
    const loose = parsed as Record<string, unknown>;
    const looseContract = record(loose.contract);
    if (looseContract.major !== 3) {
      diagnostics.push(diagnostic("unsupported_major", frame));
      continue;
    }
    const validation = validateEventV3(parsed);
    if (!validation.ok || !validation.event) {
      diagnostics.push(diagnostic("invalid_contract", frame));
      continue;
    }
    const event = validation.event;
    const shape = event as unknown as EventShape;
    if (canonicalJsonV2(event) !== frame.raw) {
      diagnostics.push(diagnostic("noncanonical_frame", frame, shape.event_id));
      continue;
    }
    const priorFrame = seenIds.get(shape.event_id);
    if (priorFrame !== undefined) {
      if (priorFrame !== frame.raw) {
        diagnostics.push(diagnostic("conflicting_event_id", frame, shape.event_id));
      }
      continue;
    }
    seenIds.set(shape.event_id, frame.raw);

    if (shape.event_type === "ledger.genesis") {
      if (genesisId !== undefined) {
        diagnostics.push(diagnostic("multiple_genesis", frame, shape.event_id));
        continue;
      }
      if (events.length !== 0)
        diagnostics.push(diagnostic("genesis_not_first", frame, shape.event_id));
      const payload = shape.payload;
      genesisId = string(payload.genesis_id);
      activeSchemaDigest = string(payload.generated_schema_digest);
      if (activeSchemaDigest !== shape.contract.schema_digest) {
        diagnostics.push(diagnostic("genesis_digest_mismatch", frame, shape.event_id));
      }
    } else if (genesisId === undefined) {
      diagnostics.push(diagnostic("missing_genesis", frame, shape.event_id));
    }

    if (!accepted.has(shape.contract.schema_digest)) {
      diagnostics.push(diagnostic("unsupported_schema_digest", frame, shape.event_id));
    }
    if (activeSchemaDigest !== undefined && shape.contract.schema_digest !== activeSchemaDigest) {
      diagnostics.push(diagnostic("unexpected_schema_digest", frame, shape.event_id));
    }

    for (const parentId of shape.links.caused_by) {
      if (!seenIds.has(parentId)) {
        diagnostics.push(diagnostic("causal_parent_missing", frame, shape.event_id));
        break;
      }
    }
    validateClock(shape, frame, clocks, diagnostics);
    validateAttestation(shape, frame, attestations, diagnostics);
    validateProducerSequence(shape, frame, producerSequences, diagnostics);

    if (shape.event_type === "ledger.schema_advanced") {
      const payload = shape.payload;
      const nextDigest = string(payload.next_schema_digest);
      const priorDigest = string(payload.prior_schema_digest);
      const effectivePosition = {
        segment_ordinal: number(payload.effective_segment_ordinal),
        byte_offset: number(payload.effective_byte_offset),
      };
      if (priorDigest !== activeSchemaDigest) {
        diagnostics.push(diagnostic("advance_prior_mismatch", frame, shape.event_id));
      }
      if (!accepted.has(nextDigest)) {
        diagnostics.push(diagnostic("advance_digest_unsupported", frame, shape.event_id));
      }
      const compatibleBuilds = stringArray(payload.compatible_reader_builds);
      if (!compatibleBuilds.includes(readerBuild)) {
        diagnostics.push(diagnostic("advance_reader_incompatible", frame, shape.event_id));
      }
      if (comparePosition(effectivePosition, frame.position) <= 0 || pending) {
        diagnostics.push(diagnostic("advance_boundary_invalid", frame, shape.event_id));
      } else {
        pending = {
          event_id: shape.event_id,
          next_schema_digest: nextDigest,
          position: effectivePosition,
        };
        advances.push({
          event_id: shape.event_id,
          prior_schema_digest: priorDigest,
          next_schema_digest: nextDigest,
          effective_position: effectivePosition,
        });
      }
    }

    events.push({ event, position: frame.position });
  }

  if (genesisId === undefined && !diagnostics.some(({ code }) => code === "missing_genesis")) {
    diagnostics.push({
      code: "missing_genesis",
      segment_ordinal: frames[0]?.position.segment_ordinal ?? 0,
      byte_offset: frames[0]?.position.byte_offset ?? 0,
    });
  }
  if (options.authority === "active" && genesisId !== undefined) {
    const activations = events.filter(
      ({ event }) => (event as unknown as EventShape).event_type === "ledger.activated",
    );
    if (activations.length === 0) {
      diagnostics.push({ code: "missing_activation", segment_ordinal: 0, byte_offset: 0 });
    } else {
      const activation = activations.at(-1)!;
      const payload = (activation.event as unknown as EventShape).payload;
      if (payload.genesis_id !== genesisId) {
        diagnostics.push(
          diagnostic(
            "activation_genesis_mismatch",
            {
              raw: "",
              position: activation.position,
            },
            (activation.event as unknown as EventShape).event_id,
          ),
        );
      }
    }
  }

  return {
    events,
    diagnostics,
    complete: diagnostics.length === 0,
    genesis_id: genesisId,
    active_schema_digest: activeSchemaDigest,
    advances,
  };
}

export function readLedgerFramesV3Since(
  frames: readonly LedgerFrameV3[],
  cursor?: LedgerCursorV3,
  options: ReadLedgerV3Options = {},
): ReadLedgerV3SinceResult {
  const read = readLedgerFramesV3(frames, options);
  if (!read.genesis_id || !read.complete) {
    return { ...read, events: [], cursor, reset_required: Boolean(cursor) };
  }
  if (cursor?.genesis_id !== undefined && cursor.genesis_id !== read.genesis_id) {
    return withCursorDiagnostic(read, "cursor_genesis_mismatch", cursor);
  }
  let startIndex = 0;
  if (cursor) {
    const index = read.events.findIndex(
      ({ event, position }) =>
        (event as unknown as EventShape).event_id === cursor.event_id &&
        position.segment_ordinal === cursor.segment_ordinal &&
        position.byte_offset === cursor.byte_offset,
    );
    if (index < 0) return withCursorDiagnostic(read, "cursor_position_missing", cursor);
    startIndex = index + 1;
  }
  const last = read.events.at(-1);
  return {
    ...read,
    events: read.events.slice(startIndex),
    cursor: last
      ? {
          genesis_id: read.genesis_id,
          segment_ordinal: last.position.segment_ordinal,
          byte_offset: last.position.byte_offset,
          event_id: (last.event as unknown as EventShape).event_id,
        }
      : cursor,
    reset_required: false,
  };
}

function validateAttestation(
  event: EventShape,
  frame: LedgerFrameV3,
  attestations: Set<string>,
  diagnostics: LedgerDiagnosticV3[],
): void {
  if (event.event_type === "session.started") {
    if (event.attestation_id) attestations.add(event.attestation_id);
    return;
  }
  if (event.event_type === "session.attestation_changed") {
    const prior = string(event.payload.prior_attestation_id);
    if (!attestations.has(prior)) {
      diagnostics.push(diagnostic("unresolved_attestation", frame, event.event_id));
    }
    if (event.attestation_id) attestations.add(event.attestation_id);
    return;
  }
  if (event.attestation_id && !attestations.has(event.attestation_id)) {
    diagnostics.push(diagnostic("unresolved_attestation", frame, event.event_id));
  }
}

function validateClock(
  event: EventShape,
  frame: LedgerFrameV3,
  clocks: Map<string, { observed_at_ms: number; monotonic_ns?: bigint }>,
  diagnostics: LedgerDiagnosticV3[],
): void {
  const prior = clocks.get(event.time.clock_id);
  const observedAtMs = Date.parse(event.time.observed_at);
  if (prior && observedAtMs < prior.observed_at_ms && event.time.skew !== "regressed") {
    diagnostics.push(diagnostic("wall_clock_regression_unmarked", frame, event.event_id));
  }
  const monotonicNs = event.time.monotonic_ns ? BigInt(event.time.monotonic_ns) : undefined;
  if (
    prior?.monotonic_ns !== undefined &&
    monotonicNs !== undefined &&
    monotonicNs < prior.monotonic_ns
  ) {
    diagnostics.push(diagnostic("monotonic_clock_regression", frame, event.event_id));
  }
  clocks.set(event.time.clock_id, {
    observed_at_ms: observedAtMs,
    ...(monotonicNs !== undefined ? { monotonic_ns: monotonicNs } : {}),
  });
}

function validateProducerSequence(
  event: EventShape,
  frame: LedgerFrameV3,
  sequences: Map<string, number>,
  diagnostics: LedgerDiagnosticV3[],
): void {
  const key = `${event.producer.producer_id}\0${event.producer.boot_id}`;
  const prior = sequences.get(key);
  if (
    (prior === undefined && event.producer.sequence !== 1) ||
    (prior !== undefined && event.producer.sequence !== prior + 1)
  ) {
    diagnostics.push(diagnostic("producer_sequence_gap", frame, event.event_id));
  }
  sequences.set(key, event.producer.sequence);
}

function withCursorDiagnostic(
  read: ReadLedgerV3Result,
  code: "cursor_genesis_mismatch" | "cursor_position_missing",
  cursor: LedgerCursorV3,
): ReadLedgerV3SinceResult {
  return {
    ...read,
    events: [],
    diagnostics: [
      ...read.diagnostics,
      {
        code,
        segment_ordinal: cursor.segment_ordinal,
        byte_offset: cursor.byte_offset,
        event_id: cursor.event_id,
      },
    ],
    complete: false,
    reset_required: true,
  };
}

function diagnostic(
  code: LedgerDiagnosticCodeV3,
  frame: LedgerFrameV3,
  eventId?: string,
): LedgerDiagnosticV3 {
  return {
    code,
    segment_ordinal: frame.position.segment_ordinal,
    byte_offset: frame.position.byte_offset,
    ...(eventId ? { event_id: eventId } : {}),
  };
}

function comparePosition(
  left: LedgerFrameV3["position"],
  right: LedgerFrameV3["position"],
): number {
  return left.segment_ordinal - right.segment_ordinal || left.byte_offset - right.byte_offset;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  return typeof value === "number" ? value : -1;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
