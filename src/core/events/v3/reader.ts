import { Buffer } from "node:buffer";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import {
  type EventV3Catalog,
  type EventV3SegmentManifest,
  readEventV3Catalog,
  readEventV3SegmentManifest,
} from "./catalog.ts";
import type { EventV3 } from "./contract.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { validateEventV3 } from "./validate.ts";

export type LedgerDiagnosticCodeV3 =
  | "malformed_json"
  | "partial_final_frame"
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
  | "cursor_position_missing"
  | "catalog_invalid"
  | "missing_segment"
  | "segment_digest_mismatch"
  | "manifest_digest_mismatch"
  | "manifest_segment_mismatch"
  | "active_replaced";

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
  bytes: number;
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

interface DiscoveredFramesV3 {
  frames: LedgerFrameV3[];
  diagnostics: LedgerDiagnosticV3[];
  bytes: number;
  active?: {
    bytes: number;
    path: string;
    segment_ordinal: number;
  };
}

interface LedgerStorageVersionV3 {
  fingerprint: string;
  stable_fingerprint: string;
  active?: {
    path: string;
    size: number;
  };
}

interface LedgerValidationStateV3 {
  diagnostics: LedgerDiagnosticV3[];
  events: PositionedEventV3[];
  advances: SchemaAdvanceV3[];
  accepted: Set<string>;
  reader_build: string;
  seen_ids: Map<string, string>;
  producer_sequences: Map<string, number>;
  attestations: Set<string>;
  clocks: Map<string, { observed_at_ms: number; monotonic_ns?: bigint }>;
  first_position?: LedgerFrameV3["position"];
  genesis_id?: string;
  active_schema_digest?: string;
  pending?: PendingAdvance;
}

interface CachedLedgerReadV3 {
  storage: LedgerStorageVersionV3;
  active?: DiscoveredFramesV3["active"];
  validation_state: LedgerValidationStateV3;
  result: ReadLedgerV3Result;
}

const MAX_CACHED_LEDGER_READS = 4;
const ledgerReadCacheV3 = new Map<string, CachedLedgerReadV3>();

export const EVENT_V3_LEDGER_RELATIVE_ROOT = ".harnery/ledgers/v3" as const;

export function eventV3Paths(coordRoot: string) {
  const root = join(resolve(coordRoot), EVENT_V3_LEDGER_RELATIVE_ROOT);
  return {
    root,
    active: join(root, "active.ndjson"),
    catalog: join(root, "catalog.json"),
    segments: join(root, "segments"),
  };
}

/** Stable file target for change notification only; reads still go through readLedgerV3. */
export function eventV3ActiveWatchPath(coordRoot: string): string {
  return eventV3Paths(coordRoot).active;
}

/** Read the complete V3 ledger through catalog-bound filesystem discovery. */
export function readLedgerV3(
  coordRoot: string,
  options: ReadLedgerV3Options = {},
): ReadLedgerV3Result {
  const cacheKey = ledgerReadCacheKeyV3(coordRoot, options);
  const storage = ledgerStorageVersionV3(coordRoot);
  const cached = ledgerReadCacheV3.get(cacheKey);
  if (cached?.storage.fingerprint === storage.fingerprint) {
    ledgerReadCacheV3.delete(cacheKey);
    ledgerReadCacheV3.set(cacheKey, cached);
    return cached.result;
  }

  const resumed = cached ? resumeCachedLedgerReadV3(cached, storage, options) : undefined;
  if (resumed) {
    rememberLedgerReadV3(cacheKey, resumed);
    return resumed.result;
  }

  const discovered = discoverLedgerFramesV3(coordRoot);
  const validated = validateLedgerFramesV3(discovered.frames, options);
  const diagnostics = [...discovered.diagnostics, ...validated.result.diagnostics];
  const result = {
    ...validated.result,
    diagnostics,
    complete: diagnostics.length === 0,
    bytes: discovered.bytes,
  };
  rememberLedgerReadV3(cacheKey, {
    storage,
    active: discovered.active,
    validation_state: isolateValidationStateV3(validated.state),
    result,
  });
  return result;
}

function rememberLedgerReadV3(cacheKey: string, cached: CachedLedgerReadV3): void {
  ledgerReadCacheV3.delete(cacheKey);
  ledgerReadCacheV3.set(cacheKey, cached);
  while (ledgerReadCacheV3.size > MAX_CACHED_LEDGER_READS) {
    const oldestKey = ledgerReadCacheV3.keys().next().value;
    if (oldestKey === undefined) break;
    ledgerReadCacheV3.delete(oldestKey);
  }
}

export function readLedgerV3Since(
  coordRoot: string,
  cursor?: LedgerCursorV3,
  options: ReadLedgerV3Options = {},
): ReadLedgerV3SinceResult {
  const discovered = discoverLedgerFramesV3(coordRoot);
  const read = readLedgerFramesV3Since(discovered.frames, cursor, options);
  const diagnostics = [...discovered.diagnostics, ...read.diagnostics];
  return {
    ...read,
    events: diagnostics.length === 0 ? read.events : [],
    diagnostics,
    complete: diagnostics.length === 0,
    bytes: discovered.bytes,
  };
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
  return validateLedgerFramesV3(frames, options).result;
}

function validateLedgerFramesV3(
  frames: readonly LedgerFrameV3[],
  options: ReadLedgerV3Options,
): { result: ReadLedgerV3Result; state: LedgerValidationStateV3 } {
  const state: LedgerValidationStateV3 = {
    diagnostics: [],
    events: [],
    advances: [],
    accepted: new Set(options.accepted_schema_digests ?? [EVENT_V3_SCHEMA_DIGEST]),
    reader_build: options.reader_build ?? "build_harnery-v3",
    seen_ids: new Map(),
    producer_sequences: new Map(),
    attestations: new Set(),
    clocks: new Map(),
  };
  validateLedgerFramesIntoStateV3(frames, state);
  return { result: finishLedgerValidationV3(state, options, ledgerFramesBytesV3(frames)), state };
}

function validateLedgerFramesIntoStateV3(
  frames: readonly LedgerFrameV3[],
  state: LedgerValidationStateV3,
): void {
  state.first_position ??= frames[0]?.position;
  const {
    diagnostics,
    events,
    advances,
    accepted,
    reader_build: readerBuild,
    seen_ids: seenIds,
    producer_sequences: producerSequences,
    attestations,
    clocks,
  } = state;

  for (const frame of frames) {
    if (state.pending) {
      const comparison = comparePosition(frame.position, state.pending.position);
      if (comparison === 0) {
        state.active_schema_digest = state.pending.next_schema_digest;
        state.pending = undefined;
      } else if (comparison > 0) {
        diagnostics.push(diagnostic("advance_boundary_missed", frame, state.pending.event_id));
        state.pending = undefined;
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
    if (canonicalJsonV3(event) !== frame.raw) {
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
      if (state.genesis_id !== undefined) {
        diagnostics.push(diagnostic("multiple_genesis", frame, shape.event_id));
        continue;
      }
      if (events.length !== 0)
        diagnostics.push(diagnostic("genesis_not_first", frame, shape.event_id));
      const payload = shape.payload;
      state.genesis_id = string(payload.genesis_id);
      state.active_schema_digest = string(payload.generated_schema_digest);
      if (state.active_schema_digest !== shape.contract.schema_digest) {
        diagnostics.push(diagnostic("genesis_digest_mismatch", frame, shape.event_id));
      }
    } else if (state.genesis_id === undefined) {
      diagnostics.push(diagnostic("missing_genesis", frame, shape.event_id));
    }

    if (!accepted.has(shape.contract.schema_digest)) {
      diagnostics.push(diagnostic("unsupported_schema_digest", frame, shape.event_id));
    }
    if (
      state.active_schema_digest !== undefined &&
      shape.contract.schema_digest !== state.active_schema_digest
    ) {
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
      if (priorDigest !== state.active_schema_digest) {
        diagnostics.push(diagnostic("advance_prior_mismatch", frame, shape.event_id));
      }
      if (!accepted.has(nextDigest)) {
        diagnostics.push(diagnostic("advance_digest_unsupported", frame, shape.event_id));
      }
      const compatibleBuilds = stringArray(payload.compatible_reader_builds);
      if (!compatibleBuilds.includes(readerBuild)) {
        diagnostics.push(diagnostic("advance_reader_incompatible", frame, shape.event_id));
      }
      if (comparePosition(effectivePosition, frame.position) <= 0 || state.pending) {
        diagnostics.push(diagnostic("advance_boundary_invalid", frame, shape.event_id));
      } else {
        state.pending = {
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
}

function finishLedgerValidationV3(
  state: LedgerValidationStateV3,
  options: ReadLedgerV3Options,
  bytes: number,
): ReadLedgerV3Result {
  const diagnostics = [...state.diagnostics];
  if (
    state.genesis_id === undefined &&
    !diagnostics.some(({ code }) => code === "missing_genesis")
  ) {
    diagnostics.push({
      code: "missing_genesis",
      segment_ordinal: state.first_position?.segment_ordinal ?? 0,
      byte_offset: state.first_position?.byte_offset ?? 0,
    });
  }
  if (options.authority === "active" && state.genesis_id !== undefined) {
    const activations = state.events.filter(
      ({ event }) => (event as unknown as EventShape).event_type === "ledger.activated",
    );
    if (activations.length === 0) {
      diagnostics.push({ code: "missing_activation", segment_ordinal: 0, byte_offset: 0 });
    } else {
      const activation = activations.at(-1)!;
      const payload = (activation.event as unknown as EventShape).payload;
      if (payload.genesis_id !== state.genesis_id) {
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
    events: state.events,
    diagnostics,
    complete: diagnostics.length === 0,
    genesis_id: state.genesis_id,
    active_schema_digest: state.active_schema_digest,
    advances: state.advances,
    bytes,
  };
}

function ledgerFramesBytesV3(frames: readonly LedgerFrameV3[]): number {
  return frames.reduce((total, frame) => total + Buffer.byteLength(frame.raw, "utf8") + 1, 0);
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

function ledgerReadCacheKeyV3(coordRoot: string, options: ReadLedgerV3Options): string {
  const accepted = [...new Set(options.accepted_schema_digests ?? [EVENT_V3_SCHEMA_DIGEST])].sort();
  return JSON.stringify([
    resolve(coordRoot),
    options.authority ?? "",
    options.reader_build ?? "",
    accepted,
  ]);
}

function resumeCachedLedgerReadV3(
  cached: CachedLedgerReadV3,
  storage: LedgerStorageVersionV3,
  options: ReadLedgerV3Options,
): CachedLedgerReadV3 | undefined {
  if (
    !cached.result.complete ||
    !cached.active ||
    !storage.active ||
    cached.storage.stable_fingerprint !== storage.stable_fingerprint ||
    cached.active.path !== storage.active.path ||
    storage.active.size <= cached.active.bytes
  ) {
    return undefined;
  }
  const appended = readActiveRangeV3(
    storage.active.path,
    cached.active.bytes,
    storage.active.size,
    cached.active.segment_ordinal,
  );
  if (!appended) return undefined;

  const state: LedgerValidationStateV3 = {
    ...cached.validation_state,
    diagnostics: [],
    events: [...cached.validation_state.events],
    advances: [...cached.validation_state.advances],
  };
  validateLedgerFramesIntoStateV3(appended.frames, state);
  const validated = finishLedgerValidationV3(state, options, cached.result.bytes + appended.bytes);
  const diagnostics = [...appended.diagnostics, ...validated.diagnostics];
  return {
    storage,
    active: {
      ...cached.active,
      bytes: storage.active.size,
    },
    validation_state: isolateValidationStateV3(state),
    result: {
      ...validated,
      diagnostics,
      complete: diagnostics.length === 0,
    },
  };
}

function isolateValidationStateV3(state: LedgerValidationStateV3): LedgerValidationStateV3 {
  return {
    ...state,
    diagnostics: [...state.diagnostics],
    events: [...state.events],
    advances: [...state.advances],
  };
}

function readActiveRangeV3(
  path: string,
  start: number,
  end: number,
  segmentOrdinal: number,
): DiscoveredFramesV3 | undefined {
  const length = end - start;
  const bytes = Buffer.alloc(length);
  let offset = 0;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    while (offset < length) {
      const read = readSync(fd, bytes, offset, length - offset, start + offset);
      if (read === 0) return undefined;
      offset += read;
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return framesFromBytes(bytes, segmentOrdinal, true, start);
}

/**
 * Cheap identity for every filesystem object that can change discovery.
 * Capture it before reading: a concurrent append then changes the next call's
 * fingerprint, so a read that raced the writer is never retained as current.
 */
function ledgerStorageVersionV3(coordRoot: string): LedgerStorageVersionV3 {
  const paths = eventV3Paths(coordRoot);
  const catalog = pathStorageVersionV3(paths.catalog);
  const active = pathStorageVersionV3(paths.active);
  const parts = [`catalog:${catalog.fingerprint}`];
  const stableParts = [`catalog:${catalog.fingerprint}`, `active:${active.stable_fingerprint}`];
  let names: string[];
  try {
    names = readdirSync(paths.segments)
      .filter((name) => /^(\d{12})\.(ndjson|manifest\.json)$/.test(name))
      .sort();
  } catch (error) {
    const segmentError = `segments:${filesystemErrorCode(error)}`;
    parts.push(segmentError);
    stableParts.push(segmentError);
    return {
      fingerprint: [...parts, `active:${active.fingerprint}`].join("|"),
      stable_fingerprint: stableParts.join("|"),
      ...(active.regular ? { active: { path: paths.active, size: active.size } } : {}),
    };
  }
  for (const name of names) {
    const part = `segment:${name}:${pathStorageVersionV3(join(paths.segments, name)).fingerprint}`;
    parts.push(part);
    stableParts.push(part);
  }
  return {
    fingerprint: [...parts, `active:${active.fingerprint}`].join("|"),
    stable_fingerprint: stableParts.join("|"),
    ...(active.regular ? { active: { path: paths.active, size: active.size } } : {}),
  };
}

function pathStorageVersionV3(path: string): {
  fingerprint: string;
  stable_fingerprint: string;
  regular: boolean;
  size: number;
} {
  try {
    const stat = lstatSync(path, { bigint: true });
    const stableFingerprint = [stat.mode, stat.dev, stat.ino, stat.birthtimeNs].join(":");
    return {
      fingerprint: [stableFingerprint, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"),
      stable_fingerprint: stableFingerprint,
      regular: stat.isFile() && !stat.isSymbolicLink(),
      size: Number(stat.size),
    };
  } catch (error) {
    const code = filesystemErrorCode(error);
    return { fingerprint: code, stable_fingerprint: code, regular: false, size: 0 };
  }
}

function filesystemErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "unavailable";
}

function discoverLedgerFramesV3(coordRoot: string): DiscoveredFramesV3 {
  const paths = eventV3Paths(coordRoot);
  if (!existsSync(paths.catalog)) {
    if (hasSealedV3Metadata(paths.segments)) {
      return {
        frames: [],
        diagnostics: [storageDiagnostic("catalog_invalid", 0)],
        bytes: 0,
      };
    }
    if (!existsSync(paths.active)) return { frames: [], diagnostics: [], bytes: 0 };
    const bytes = readFileSync(paths.active);
    return {
      ...framesFromBytes(bytes, 1, true),
      active: { bytes: bytes.length, path: paths.active, segment_ordinal: 1 },
    };
  }

  let catalog: EventV3Catalog;
  try {
    catalog = readEventV3Catalog(paths.catalog);
  } catch {
    return {
      frames: [],
      diagnostics: [storageDiagnostic("catalog_invalid", 0)],
      bytes: 0,
    };
  }

  const discovered: DiscoveredFramesV3 = { frames: [], diagnostics: [], bytes: 0 };
  for (const entry of catalog.segments) {
    discoverSealedSegment(paths.segments, entry, discovered);
  }
  discoverActiveSegment(paths.active, catalog, discovered);
  return discovered;
}

function discoverSealedSegment(
  segmentsRoot: string,
  entry: EventV3Catalog["segments"][number],
  discovered: DiscoveredFramesV3,
): void {
  const segmentPath = join(segmentsRoot, entry.segment_file);
  const manifestPath = join(segmentsRoot, entry.manifest_file);
  if (!regularFile(segmentPath) || !regularFile(manifestPath)) {
    discovered.diagnostics.push(storageDiagnostic("missing_segment", entry.ordinal));
    return;
  }
  const segmentBytes = readFileSync(segmentPath);
  const manifestBytes = readFileSync(manifestPath);
  discovered.bytes += segmentBytes.length;
  if (segmentBytes.length !== entry.bytes || sha256V3(segmentBytes) !== entry.segment_digest) {
    discovered.diagnostics.push(storageDiagnostic("segment_digest_mismatch", entry.ordinal));
    return;
  }
  if (sha256V3(manifestBytes) !== entry.manifest_digest) {
    discovered.diagnostics.push(storageDiagnostic("manifest_digest_mismatch", entry.ordinal));
    return;
  }
  let manifest: EventV3SegmentManifest;
  try {
    manifest = readEventV3SegmentManifest(manifestPath);
  } catch {
    discovered.diagnostics.push(storageDiagnostic("manifest_segment_mismatch", entry.ordinal));
    return;
  }
  const segment = framesFromBytes(segmentBytes, entry.ordinal, false);
  if (
    !manifestMatchesCatalog(manifest, entry) ||
    !manifestMatchesFrames(manifest, segment.frames)
  ) {
    discovered.diagnostics.push(storageDiagnostic("manifest_segment_mismatch", entry.ordinal));
    return;
  }
  discovered.frames.push(...segment.frames);
  discovered.diagnostics.push(...segment.diagnostics);
}

function discoverActiveSegment(
  activePath: string,
  catalog: EventV3Catalog,
  discovered: DiscoveredFramesV3,
): void {
  if (!regularFile(activePath)) {
    discovered.diagnostics.push(storageDiagnostic("active_replaced", catalog.active.ordinal));
    return;
  }
  const stat = statSync(activePath);
  const bigintStat = statSync(activePath, { bigint: true });
  if (
    String(stat.dev) !== catalog.active.device ||
    String(stat.ino) !== catalog.active.inode ||
    String(bigintStat.birthtimeNs) !== catalog.active.birthtime_ns
  ) {
    discovered.diagnostics.push(storageDiagnostic("active_replaced", catalog.active.ordinal));
    return;
  }
  const bytes = readFileSync(activePath);
  const active = framesFromBytes(bytes, catalog.active.ordinal, true);
  discovered.frames.push(...active.frames);
  discovered.diagnostics.push(...active.diagnostics);
  discovered.bytes += bytes.length;
  discovered.active = {
    bytes: bytes.length,
    path: activePath,
    segment_ordinal: catalog.active.ordinal,
  };
}

function framesFromBytes(
  bytes: Buffer,
  segmentOrdinal: number,
  allowPartialFinalFrame: boolean,
  initialByteOffset = 0,
): DiscoveredFramesV3 {
  const raw = bytes.toString("utf8");
  const frames: LedgerFrameV3[] = [];
  const diagnostics: LedgerDiagnosticV3[] = [];
  const lines = raw.split("\n");
  let byteOffset = initialByteOffset;
  for (const [index, line] of lines.entries()) {
    const final = index === lines.length - 1;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (line.length === 0) {
      if (!final) {
        diagnostics.push(storageDiagnostic("malformed_json", segmentOrdinal, byteOffset));
        byteOffset += 1;
      }
      continue;
    }
    if (final && !raw.endsWith("\n")) {
      diagnostics.push(
        storageDiagnostic(
          allowPartialFinalFrame ? "partial_final_frame" : "malformed_json",
          segmentOrdinal,
          byteOffset,
        ),
      );
      break;
    }
    frames.push({
      raw: line,
      position: { segment_ordinal: segmentOrdinal, byte_offset: byteOffset },
    });
    byteOffset += lineBytes + 1;
  }
  return { frames, diagnostics, bytes: bytes.length };
}

function manifestMatchesCatalog(
  manifest: EventV3SegmentManifest,
  entry: EventV3Catalog["segments"][number],
): boolean {
  return (
    manifest.ordinal === entry.ordinal &&
    manifest.segment_file === entry.segment_file &&
    manifest.segment_digest === entry.segment_digest &&
    manifest.bytes === entry.bytes &&
    manifest.row_count === entry.row_count
  );
}

function manifestMatchesFrames(
  manifest: EventV3SegmentManifest,
  frames: readonly LedgerFrameV3[],
): boolean {
  if (frames.length !== manifest.row_count) return false;
  try {
    const records = frames.map(({ raw }) => record(JSON.parse(raw)));
    const schemaDigests = [
      ...new Set(records.map((event) => string(record(event.contract).schema_digest))),
    ].sort();
    return (
      records[0]?.event_id === manifest.first_event_id &&
      records.at(-1)?.event_id === manifest.last_event_id &&
      schemaDigests.join("\0") === manifest.schema_digests.join("\0")
    );
  } catch {
    return false;
  }
}

function hasSealedV3Metadata(segmentsPath: string): boolean {
  if (!existsSync(segmentsPath)) return false;
  return readdirSync(segmentsPath).some((name) => /^(\d{12})\.(ndjson|manifest\.json)$/.test(name));
}

function regularFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink();
}

function storageDiagnostic(
  code: LedgerDiagnosticCodeV3,
  segmentOrdinal: number,
  byteOffset = 0,
): LedgerDiagnosticV3 {
  return { code, segment_ordinal: segmentOrdinal, byte_offset: byteOffset };
}
