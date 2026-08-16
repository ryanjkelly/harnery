import { Buffer } from "node:buffer";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalJsonV2, sha256V2 } from "./canonical.ts";
import { type EventV2Catalog, readEventV2Catalog, readEventV2SegmentManifest } from "./catalog.ts";
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
  | "producer_sequence_gap"
  | "catalog_invalid"
  | "missing_segment"
  | "segment_digest_mismatch"
  | "manifest_digest_mismatch"
  | "manifest_segment_mismatch"
  | "active_replaced"
  | "causal_parent_missing"
  | "wall_clock_regression_unmarked"
  | "monotonic_clock_regression"
  | "unresolved_attestation"
  | "missing_genesis"
  | "multiple_genesis"
  | "cursor_genesis_mismatch"
  | "cursor_position_missing";

export interface LedgerDiagnosticV2 {
  code: LedgerDiagnosticCodeV2;
  byte_offset: number;
  segment_ordinal?: number;
  event_id?: string;
}

export interface PositionedEventV2 {
  event: EventV2;
  position: {
    segment_ordinal: number;
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

export interface LedgerCursorV2 {
  genesis_id: string;
  segment_ordinal: number;
  byte_offset: number;
  event_id: string;
}

export interface ReadLedgerV2SinceResult extends ReadLedgerV2Result {
  cursor?: LedgerCursorV2;
  reset_required: boolean;
}

interface ReaderState {
  diagnostics: LedgerDiagnosticV2[];
  events: PositionedEventV2[];
  seenIds: Map<string, string>;
  producerSequences: Map<string, number>;
  clocks: Map<string, { observed_at_ms: number; monotonic_ns?: bigint }>;
  attestations: Set<string>;
  accepted: Set<string>;
  bytes: number;
}

/** Validating reader for the active V2 tail only. */
export function readActiveLedgerV2(
  coordRoot: string,
  options: ReadLedgerV2Options = {},
): ReadLedgerV2Result {
  const active = eventV2Paths(coordRoot).active;
  if (!existsSync(active)) return { events: [], diagnostics: [], complete: true, bytes: 0 };
  const state = createState(options);
  readFrames(readFileSync(active), 0, state, true);
  return result(state);
}

/** Read every cataloged sealed segment plus the catalog-bound active tail. */
export function readLedgerV2(
  coordRoot: string,
  options: ReadLedgerV2Options = {},
): ReadLedgerV2Result {
  const state = createState(options);
  const paths = eventV2Paths(coordRoot);
  let catalog: EventV2Catalog;
  try {
    catalog = readEventV2Catalog(coordRoot);
  } catch {
    state.diagnostics.push({ code: "catalog_invalid", byte_offset: 0 });
    return result(state);
  }

  for (const entry of catalog.segments) {
    const segmentPath = join(paths.segments, entry.segment_file);
    const manifestPath = join(paths.segments, entry.manifest_file);
    if (!existsSync(segmentPath) || !existsSync(manifestPath)) {
      state.diagnostics.push({
        code: "missing_segment",
        byte_offset: 0,
        segment_ordinal: entry.ordinal,
      });
      continue;
    }
    const segmentBytes = readFileSync(segmentPath);
    const manifestBytes = readFileSync(manifestPath);
    if (sha256V2(segmentBytes) !== entry.segment_digest || segmentBytes.length !== entry.bytes) {
      state.diagnostics.push({
        code: "segment_digest_mismatch",
        byte_offset: 0,
        segment_ordinal: entry.ordinal,
      });
      continue;
    }
    if (sha256V2(manifestBytes) !== entry.manifest_digest) {
      state.diagnostics.push({
        code: "manifest_digest_mismatch",
        byte_offset: 0,
        segment_ordinal: entry.ordinal,
      });
      continue;
    }
    try {
      const manifest = readEventV2SegmentManifest(manifestPath);
      if (
        manifest.ordinal !== entry.ordinal ||
        manifest.segment_file !== entry.segment_file ||
        manifest.segment_digest !== entry.segment_digest ||
        manifest.bytes !== entry.bytes ||
        manifest.row_count !== entry.row_count ||
        `${canonicalJsonV2(manifest)}\n` !== manifestBytes.toString("utf8")
      ) {
        throw new Error("manifest mismatch");
      }
    } catch {
      state.diagnostics.push({
        code: "manifest_segment_mismatch",
        byte_offset: 0,
        segment_ordinal: entry.ordinal,
      });
      continue;
    }
    readFrames(segmentBytes, entry.ordinal, state, false);
  }

  if (!existsSync(paths.active)) {
    state.diagnostics.push({
      code: "active_replaced",
      byte_offset: 0,
      segment_ordinal: catalog.active.ordinal,
    });
    return result(state);
  }
  const activeStat = statSync(paths.active);
  const activeBigIntStat = statSync(paths.active, { bigint: true });
  if (
    String(activeStat.dev) !== catalog.active.device ||
    String(activeStat.ino) !== catalog.active.inode ||
    String(activeBigIntStat.birthtimeNs) !== catalog.active.birthtime_ns
  ) {
    state.diagnostics.push({
      code: "active_replaced",
      byte_offset: 0,
      segment_ordinal: catalog.active.ordinal,
    });
    return result(state);
  }
  readFrames(readFileSync(paths.active), catalog.active.ordinal, state, true);
  return result(state);
}

/**
 * Resume from an exact physical event position. The implementation validates
 * the complete catalog first, so a cursor never hides corruption or a gap in
 * history before its own position. Rotation preserves segment ordinals and
 * therefore does not invalidate a cursor that was minted from the active tail.
 */
export function readLedgerV2Since(
  coordRoot: string,
  cursor?: LedgerCursorV2,
  options: ReadLedgerV2Options = {},
): ReadLedgerV2SinceResult {
  const read = readLedgerV2(coordRoot, options);
  const genesisEvents = read.events.filter(
    (positioned) => positioned.event.event_type === "ledger.genesis",
  );
  const diagnostics = [...read.diagnostics];
  if (genesisEvents.length === 0) {
    diagnostics.push({ code: "missing_genesis", byte_offset: 0 });
    return {
      ...read,
      events: [],
      diagnostics,
      complete: false,
      reset_required: cursor !== undefined,
    };
  }
  if (genesisEvents.length !== 1) {
    diagnostics.push({
      code: "multiple_genesis",
      byte_offset: genesisEvents[1]?.position.byte_offset ?? 0,
      segment_ordinal: genesisEvents[1]?.position.segment_ordinal,
      event_id: genesisEvents[1]?.event.event_id,
    });
    return {
      ...read,
      events: [],
      diagnostics,
      complete: false,
      reset_required: true,
    };
  }

  const genesis = genesisEvents[0]!;
  const genesisEvent = genesis.event as Extract<EventV2, { event_type: "ledger.genesis" }>;
  const genesisId = genesisEvent.payload.genesis_id;
  let startIndex = 0;
  if (cursor) {
    if (cursor.genesis_id !== genesisId) {
      diagnostics.push({
        code: "cursor_genesis_mismatch",
        byte_offset: cursor.byte_offset,
        segment_ordinal: cursor.segment_ordinal,
        event_id: cursor.event_id,
      });
      return {
        ...read,
        events: [],
        diagnostics,
        complete: false,
        reset_required: true,
      };
    }
    const cursorIndex = read.events.findIndex(
      (positioned) =>
        positioned.event.event_id === cursor.event_id &&
        positioned.position.segment_ordinal === cursor.segment_ordinal &&
        positioned.position.byte_offset === cursor.byte_offset,
    );
    if (cursorIndex < 0) {
      diagnostics.push({
        code: "cursor_position_missing",
        byte_offset: cursor.byte_offset,
        segment_ordinal: cursor.segment_ordinal,
        event_id: cursor.event_id,
      });
      return {
        ...read,
        events: [],
        diagnostics,
        complete: false,
        reset_required: true,
      };
    }
    startIndex = cursorIndex + 1;
  }

  if (!read.complete) {
    return {
      ...read,
      events: [],
      diagnostics,
      complete: false,
      cursor,
      reset_required: false,
    };
  }

  const events = read.events.slice(startIndex);
  const last = read.events.at(-1);
  return {
    ...read,
    events,
    diagnostics,
    complete: read.complete && diagnostics.length === 0,
    cursor: last
      ? {
          genesis_id: genesisId,
          segment_ordinal: last.position.segment_ordinal,
          byte_offset: last.position.byte_offset,
          event_id: last.event.event_id,
        }
      : cursor,
    reset_required: false,
  };
}

function readFrames(
  rawBytes: Buffer,
  segmentOrdinal: number,
  state: ReaderState,
  allowPartialFinalFrame: boolean,
): void {
  const raw = rawBytes.toString("utf8");
  state.bytes += rawBytes.length;
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
      state.diagnostics.push({
        code: allowPartialFinalFrame ? "partial_final_frame" : "malformed_json",
        byte_offset: byteOffset,
        segment_ordinal: segmentOrdinal,
      });
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      state.diagnostics.push({
        code: "malformed_json",
        byte_offset: byteOffset,
        segment_ordinal: segmentOrdinal,
      });
      byteOffset += frameBytes + 1;
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const contract = record.contract as Record<string, unknown> | undefined;
    if (record.schema_version === 1 || (contract && contract.major !== 2)) {
      state.diagnostics.push({
        code: "unsupported_major",
        byte_offset: byteOffset,
        segment_ordinal: segmentOrdinal,
      });
      byteOffset += frameBytes + 1;
      continue;
    }
    const validation = validateEventV2(parsed);
    if (!validation.ok || !validation.event) {
      state.diagnostics.push({
        code: "invalid_contract",
        byte_offset: byteOffset,
        segment_ordinal: segmentOrdinal,
      });
      byteOffset += frameBytes + 1;
      continue;
    }
    const event = validation.event;
    if (!state.accepted.has(event.contract.schema_digest)) {
      state.diagnostics.push({
        code: "unsupported_schema_digest",
        byte_offset: byteOffset,
        segment_ordinal: segmentOrdinal,
        event_id: event.event_id,
      });
      byteOffset += frameBytes + 1;
      continue;
    }
    if (canonicalJsonV2(event) !== frame) {
      state.diagnostics.push({
        code: "noncanonical_frame",
        byte_offset: byteOffset,
        segment_ordinal: segmentOrdinal,
        event_id: event.event_id,
      });
      byteOffset += frameBytes + 1;
      continue;
    }
    const priorBytes = state.seenIds.get(event.event_id);
    if (priorBytes !== undefined) {
      if (priorBytes !== frame) {
        state.diagnostics.push({
          code: "conflicting_event_id",
          byte_offset: byteOffset,
          segment_ordinal: segmentOrdinal,
          event_id: event.event_id,
        });
      }
      byteOffset += frameBytes + 1;
      continue;
    }
    state.seenIds.set(event.event_id, frame);

    for (const parentId of (event.links as { caused_by: string[] }).caused_by) {
      if (!state.seenIds.has(parentId)) {
        state.diagnostics.push({
          code: "causal_parent_missing",
          byte_offset: byteOffset,
          segment_ordinal: segmentOrdinal,
          event_id: event.event_id,
        });
        break;
      }
    }

    const priorClock = state.clocks.get(event.time.clock_id);
    const observedAtMs = Date.parse(event.time.observed_at);
    if (priorClock && observedAtMs < priorClock.observed_at_ms && event.time.skew !== "regressed") {
      state.diagnostics.push({
        code: "wall_clock_regression_unmarked",
        byte_offset: byteOffset,
        segment_ordinal: segmentOrdinal,
        event_id: event.event_id,
      });
    }
    const monotonicNs = event.time.monotonic_ns ? BigInt(event.time.monotonic_ns) : undefined;
    if (
      priorClock?.monotonic_ns !== undefined &&
      monotonicNs !== undefined &&
      monotonicNs < priorClock.monotonic_ns
    ) {
      state.diagnostics.push({
        code: "monotonic_clock_regression",
        byte_offset: byteOffset,
        segment_ordinal: segmentOrdinal,
        event_id: event.event_id,
      });
    }
    state.clocks.set(event.time.clock_id, {
      observed_at_ms: observedAtMs,
      ...(monotonicNs !== undefined ? { monotonic_ns: monotonicNs } : {}),
    });

    if (event.event_type === "session.started") {
      state.attestations.add(event.attestation_id);
    } else if (event.event_type === "session.attestation_changed") {
      if (!state.attestations.has(event.payload.prior_attestation_id)) {
        state.diagnostics.push({
          code: "unresolved_attestation",
          byte_offset: byteOffset,
          segment_ordinal: segmentOrdinal,
          event_id: event.event_id,
        });
      }
      state.attestations.add(event.attestation_id);
    } else if ("attestation_id" in event && !state.attestations.has(event.attestation_id)) {
      state.diagnostics.push({
        code: "unresolved_attestation",
        byte_offset: byteOffset,
        segment_ordinal: segmentOrdinal,
        event_id: event.event_id,
      });
    }

    const sequenceKey = `${event.producer.producer_id}\0${event.producer.boot_id}`;
    const priorSequence = state.producerSequences.get(sequenceKey);
    if (
      (priorSequence === undefined && event.producer.sequence !== 1) ||
      (priorSequence !== undefined && event.producer.sequence !== priorSequence + 1)
    ) {
      state.diagnostics.push({
        code: "producer_sequence_gap",
        byte_offset: byteOffset,
        segment_ordinal: segmentOrdinal,
        event_id: event.event_id,
      });
    }
    state.producerSequences.set(sequenceKey, event.producer.sequence);
    state.events.push({
      event,
      position: { segment_ordinal: segmentOrdinal, byte_offset: byteOffset },
    });
    byteOffset += frameBytes + 1;
  }
}

function createState(options: ReadLedgerV2Options): ReaderState {
  return {
    diagnostics: [],
    events: [],
    seenIds: new Map(),
    producerSequences: new Map(),
    clocks: new Map(),
    attestations: new Set(),
    accepted: new Set(options.acceptedSchemaDigests ?? [EVENT_V2_SCHEMA_DIGEST]),
    bytes: 0,
  };
}

function result(state: ReaderState): ReadLedgerV2Result {
  return {
    events: state.events,
    diagnostics: state.diagnostics,
    complete: state.diagnostics.length === 0,
    bytes: state.bytes,
  };
}
