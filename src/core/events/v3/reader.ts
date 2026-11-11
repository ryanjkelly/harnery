import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
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
import { join, relative, resolve } from "node:path";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import {
  type EventV3Catalog,
  type EventV3SegmentManifest,
  readEventV3Catalog,
  readEventV3SegmentManifest,
} from "./catalog.ts";
import type { EventV3 } from "./contract.ts";
import { readAdvanceableControlWitnessV3 } from "./control-witness.ts";
import {
  type EventV3RecoveryFailure,
  type EventV3RecoveryReceipt,
  eventV3RecoveryRecordsRoot,
  listEventV3RecoveryReceipts,
} from "./recovery-record.ts";
import {
  applyRowV3,
  checkRowV3,
  createRowValidationStateV3,
  type RowV3,
  type RowValidationStateV3,
  recordRowIdentityV3,
  rowIdentityV3,
  rowValidationStateFromCheckpointV3,
} from "./row-validation.ts";
import { acceptedSchemaDigestsV3 } from "./schema-lineage.ts";
import { validateEventV3 } from "./validate.ts";

export type LedgerDiagnosticCodeV3 =
  | "malformed_json"
  | "partial_final_frame"
  | "unsupported_major"
  | "invalid_contract"
  | "unsupported_schema_digest"
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
  | "cursor_genesis_mismatch"
  | "cursor_position_missing"
  | "catalog_invalid"
  | "missing_segment"
  | "segment_digest_mismatch"
  | "manifest_digest_mismatch"
  | "manifest_segment_mismatch"
  | "active_replaced"
  | "recovery_record_invalid";

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

export interface ReadLedgerV3Options {
  authority?: "candidate" | "active";
  reader_build?: string;
  /**
   * Schema digests a row may carry. Defaults to the runtime's whole additive
   * group: rows of any digest in it share one epoch.
   */
  accepted_schema_digests?: readonly string[];
}

export interface ReadLedgerV3Result {
  events: PositionedEventV3[];
  diagnostics: LedgerDiagnosticV3[];
  complete: boolean;
  genesis_id?: string;
  /** Schema digest the genesis row records. */
  genesis_schema_digest?: string;
  /** Every schema digest a read frame carries, sorted, including digests the reader rejected. */
  schema_digests?: string[];
  bytes: number;
  failed_epochs?: EventV3RecoveryReceipt[];
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

/** Inspect one failed active authority without weakening the canonical read boundary. */
export function inspectInvalidActiveAuthorityV3(
  coordRoot: string,
  controlReason: string,
): EventV3RecoveryFailure {
  const paths = eventV3Paths(coordRoot);
  const ledger = readLedgerV3(coordRoot, { authority: "active" });
  if (ledger.complete || ledger.diagnostics.length === 0) {
    throw new Error("event_v3_recovery_requires_incomplete_ledger");
  }
  const diagnostic = [...ledger.diagnostics].sort(
    (left, right) =>
      left.segment_ordinal - right.segment_ordinal || left.byte_offset - right.byte_offset,
  )[0]!;
  const activeOrdinal = existsSync(paths.catalog)
    ? readEventV3Catalog(paths.catalog).active.ordinal
    : 1;
  if (diagnostic.segment_ordinal !== activeOrdinal) {
    throw new Error("event_v3_recovery_first_failure_is_not_in_active_authority");
  }
  const active = readFileSync(paths.active);
  if (diagnostic.byte_offset > active.length) {
    throw new Error("event_v3_recovery_diagnostic_offset_exceeds_active_authority");
  }
  return {
    control_reason: controlReason,
    authority_digest: digestEventV3AuthorityDirectoryV3(paths.root),
    active_digest: sha256V3(active),
    active_bytes: active.length,
    validated_prefix_digest: sha256V3(active.subarray(0, diagnostic.byte_offset)),
    validated_prefix_bytes: diagnostic.byte_offset,
    diagnostic: {
      code: diagnostic.code,
      segment_ordinal: diagnostic.segment_ordinal,
      byte_offset: diagnostic.byte_offset,
      ...(diagnostic.event_id ? { event_id: diagnostic.event_id } : {}),
    },
  };
}

/** Hash one preserved V3 authority by relative path, byte count, and file digest. */
export function digestEventV3AuthorityDirectoryV3(root: string): `sha256:${string}` {
  const base = resolve(root);
  if (!lstatSync(base).isDirectory()) throw new Error("V3 authority root is not a directory");
  const files: Array<{ path: string; bytes: number; digest: `sha256:${string}` }> = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("V3 authority contains a symbolic link");
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error("V3 authority contains a non-regular file");
      const bytes = readFileSync(path);
      files.push({
        path: relative(base, path).replaceAll("\\", "/"),
        bytes: bytes.length,
        digest: sha256V3(bytes),
      });
    }
  };
  visit(base);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return `sha256:${createHash("sha256").update(canonicalJsonV3(files)).digest("hex")}`;
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

export interface EventV3AuthorityStorageVersionV3 {
  fingerprint: `sha256:${string}`;
  stable_fingerprint: `sha256:${string}`;
  active_bytes: number;
}

/**
 * The validator tail a complete read leaves behind, so a writer or a later
 * reader can validate only the bytes appended after it.
 *
 * `schema_digests` lists, sorted, every schema digest the validated rows
 * carry. It records what the epoch holds, never what a runtime accepts: each
 * runtime builds its accepted set from its own additive group and checks this
 * list against it.
 */
export interface EventV3AppendValidationCheckpointV3 {
  format: "harnery-event-v3-append-validation-checkpoint";
  format_version: 2;
  reader_build: string;
  schema_digests: string[];
  seen_event_ids: string[];
  producer_sequences: Array<[string, number]>;
  attestation_ids: string[];
  clocks: Array<[string, number, string?]>;
  event_count: number;
  genesis_id?: string;
  active_segment_ordinal: number;
  validated_active_bytes: number;
}

interface LedgerValidationStateV3 extends RowValidationStateV3 {
  diagnostics: LedgerDiagnosticV3[];
  events: PositionedEventV3[];
  reader_build: string;
  event_count: number;
  first_position?: LedgerFrameV3["position"];
  genesis_id?: string;
  genesis_schema_digest?: string;
  /** Digests of the rows this state has applied. */
  schema_digests: Set<string>;
  /** Digests of frames rejected as `unsupported_schema_digest`. */
  unsupported_schema_digests: Set<string>;
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
export const EVENT_V3_CONTROL_WITNESS_RELATIVE_PATH =
  `${EVENT_V3_LEDGER_RELATIVE_ROOT}/control-state-witness.json` as const;
export const EVENT_V3_CONTROL_CHECKPOINT_RELATIVE_PATH =
  `${EVENT_V3_LEDGER_RELATIVE_ROOT}/control-state-validation.json` as const;

export function eventV3Paths(coordRoot: string) {
  const root = join(resolve(coordRoot), EVENT_V3_LEDGER_RELATIVE_ROOT);
  return {
    root,
    active: join(root, "active.ndjson"),
    catalog: join(root, "catalog.json"),
    segments: join(root, "segments"),
  };
}

export type EventV3ActiveTailV3 =
  | { readonly status: "missing" }
  | { readonly status: "unsafe" }
  | { readonly status: "read"; readonly start: number; readonly bytes: Buffer };

/**
 * Read at most `maxBytes` raw bytes from the end of the active file without
 * validating frames, for bounded health snapshots. `start` is the byte offset
 * of the first returned byte; when it is above zero the first line may be
 * partial. A symlink or non-file is reported as unsafe; read errors throw.
 */
export function readEventV3ActiveTailV3(coordRoot: string, maxBytes: number): EventV3ActiveTailV3 {
  const active = eventV3Paths(coordRoot).active;
  if (!existsSync(active)) return { status: "missing" };
  let handle: number | undefined;
  try {
    const stat = lstatSync(active);
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: "unsafe" };
    if (stat.size === 0) return { status: "read", start: 0, bytes: Buffer.alloc(0) };
    const start = Math.max(0, stat.size - maxBytes);
    const bytes = Buffer.allocUnsafe(stat.size - start);
    handle = openSync(active, "r");
    const count = readSync(handle, bytes, 0, bytes.length, start);
    return { status: "read", start, bytes: bytes.subarray(0, count) };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/** Stable file target for change notification only; reads still go through readLedgerV3. */
export function eventV3ActiveWatchPath(coordRoot: string): string {
  return eventV3Paths(coordRoot).active;
}

/** Stable auxiliary control-cache target; canonical event reads remain inside this module. */
export function eventV3ControlWitnessPathV3(coordRoot: string): string {
  return join(eventV3Paths(coordRoot).root, "control-state-witness.json");
}

/** Stable auxiliary validator-checkpoint target owned by the control witness. */
export function eventV3ControlCheckpointPathV3(coordRoot: string): string {
  return join(eventV3Paths(coordRoot).root, "control-state-validation.json");
}

/**
 * Content-independent identity for the complete filesystem authority.
 *
 * The control witness authenticates this value after a complete validation.
 * Any append, rewrite, inode replacement, catalog change, sealed-segment
 * change, or recovery-record change produces a different fingerprint and
 * sends the control reader back through the canonical full validation path.
 */
export function eventV3AuthorityStorageVersionV3(
  coordRoot: string,
): EventV3AuthorityStorageVersionV3 {
  const storage = ledgerStorageVersionV3(coordRoot);
  return {
    fingerprint: sha256V3(storage.fingerprint),
    stable_fingerprint: sha256V3(storage.stable_fingerprint),
    active_bytes: storage.active?.size ?? 0,
  };
}

/** Serialize the validator tail produced by the current complete cached read. */
export function readEventV3AppendValidationCheckpointV3(
  coordRoot: string,
): EventV3AppendValidationCheckpointV3 | undefined {
  const options: ReadLedgerV3Options = {};
  const result = readLedgerV3(coordRoot, options);
  if (!result.complete) return undefined;
  const cached = ledgerReadCacheV3.get(ledgerReadCacheKeyV3(coordRoot, options));
  if (!cached?.active || !cached.result.complete) return undefined;
  return checkpointFromValidationStateV3(cached.validation_state, cached.active);
}

/**
 * The committed canonical frames (without the trailing newline) of the given
 * event IDs, taken from the validator state of a complete canonical read of
 * the active authority. IDs the read does not hold are absent from the map;
 * an incomplete read returns undefined. The read goes through the same cache
 * and witnessed fast path as `readLedgerV3`, so it is meant for the rare
 * caller that must compare a row's bytes with a committed row's, not for the
 * normal append path.
 */
export function readCommittedFramesV3(
  coordRoot: string,
  eventIds: readonly string[],
): Map<string, string> | undefined {
  const options: ReadLedgerV3Options = {};
  if (!readLedgerV3(coordRoot, options).complete) return undefined;
  const cached = ledgerReadCacheV3.get(ledgerReadCacheKeyV3(coordRoot, options));
  if (!cached?.result.complete) return undefined;
  const frames = new Map<string, string>();
  for (const eventId of eventIds) {
    const raw = cached.validation_state.seen_ids.get(eventId);
    if (raw) frames.set(eventId, raw);
  }
  return frames;
}

/**
 * Validate only the bytes appended after an authenticated checkpoint.
 * Unsupported or semantically invalid transitions return undefined so the
 * control reader falls back to a complete canonical validation.
 */
export function advanceEventV3AppendValidationCheckpointV3(
  coordRoot: string,
  checkpoint: EventV3AppendValidationCheckpointV3,
): EventV3AppendValidationCheckpointV3 | undefined {
  const parsed = parseEventV3AppendValidationCheckpointV3(checkpoint);
  if (!parsed) return undefined;
  const storage = ledgerStorageVersionV3(coordRoot);
  if (!storage.active || storage.active.size <= parsed.validated_active_bytes) return undefined;
  const appended = readActiveRangeV3(
    storage.active.path,
    parsed.validated_active_bytes,
    storage.active.size,
    parsed.active_segment_ordinal,
  );
  if (!appended || appended.diagnostics.length > 0) return undefined;
  const state = validationStateFromCheckpointV3(parsed);
  if (!state) return undefined;
  validateLedgerFramesIntoStateV3(appended.frames, state);
  if (state.diagnostics.length > 0) return undefined;
  return checkpointFromValidationStateV3(state, {
    bytes: storage.active.size,
    path: storage.active.path,
    segment_ordinal: parsed.active_segment_ordinal,
  });
}

/** Parse an untrusted persisted checkpoint without weakening the writer fence. */
export function parseEventV3AppendValidationCheckpointV3(
  value: unknown,
): EventV3AppendValidationCheckpointV3 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const checkpoint = value as Partial<EventV3AppendValidationCheckpointV3>;
  if (
    checkpoint.format !== "harnery-event-v3-append-validation-checkpoint" ||
    checkpoint.format_version !== 2 ||
    typeof checkpoint.reader_build !== "string" ||
    !sortedSchemaDigestList(checkpoint.schema_digests) ||
    !Array.isArray(checkpoint.seen_event_ids) ||
    !checkpoint.seen_event_ids.every((item) => typeof item === "string") ||
    !Array.isArray(checkpoint.producer_sequences) ||
    !checkpoint.producer_sequences.every(
      (item) =>
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === "string" &&
        Number.isSafeInteger(item[1]) &&
        item[1] > 0,
    ) ||
    !Array.isArray(checkpoint.attestation_ids) ||
    !checkpoint.attestation_ids.every((item) => typeof item === "string") ||
    !Array.isArray(checkpoint.clocks) ||
    !checkpoint.clocks.every(
      (item) =>
        Array.isArray(item) &&
        (item.length === 2 || item.length === 3) &&
        typeof item[0] === "string" &&
        typeof item[1] === "number" &&
        Number.isFinite(item[1]) &&
        (item[2] === undefined || (typeof item[2] === "string" && /^\d+$/.test(item[2]))),
    ) ||
    !Number.isSafeInteger(checkpoint.event_count) ||
    (checkpoint.event_count ?? -1) < 0 ||
    !Number.isSafeInteger(checkpoint.active_segment_ordinal) ||
    (checkpoint.active_segment_ordinal ?? 0) < 1 ||
    !Number.isSafeInteger(checkpoint.validated_active_bytes) ||
    (checkpoint.validated_active_bytes ?? -1) < 0 ||
    (checkpoint.genesis_id !== undefined && typeof checkpoint.genesis_id !== "string") ||
    Object.keys(checkpoint).some((key) => !CHECKPOINT_KEYS.has(key))
  ) {
    return undefined;
  }
  return checkpoint as EventV3AppendValidationCheckpointV3;
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
  const validated =
    validateWitnessedFramesV3(coordRoot, storage, discovered, options) ??
    validateLedgerFramesV3(discovered.frames, options);
  const recovery = discoverRecoveryReceiptsV3(coordRoot);
  const diagnostics = [
    ...discovered.diagnostics,
    ...validated.result.diagnostics,
    ...recovery.diagnostics,
  ];
  const result = {
    ...validated.result,
    diagnostics,
    complete: diagnostics.length === 0,
    bytes: discovered.bytes,
    failed_epochs: recovery.receipts,
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
  // Read through the validated snapshot cache that readLedgerV3 keeps, so a caller that
  // polls the tail pays for the bytes appended since its last call, not for the whole
  // authority. Until 2026-09-06 this rediscovered and revalidated every frame on every
  // call: a 24.5 MB active segment cost about 0.5 s to return zero new events, and the
  // semantic service asked once a second for three days (3.2 cores on an idle host).
  return sliceLedgerReadSinceV3(readLedgerV3(coordRoot, options), cursor);
}

function discoverRecoveryReceiptsV3(coordRoot: string): {
  receipts: EventV3RecoveryReceipt[];
  diagnostics: LedgerDiagnosticV3[];
} {
  try {
    return { receipts: listEventV3RecoveryReceipts(coordRoot), diagnostics: [] };
  } catch {
    return {
      receipts: [],
      diagnostics: [storageDiagnostic("recovery_record_invalid", 0)],
    };
  }
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

/**
 * Cold-process fast path. Writers advance an authenticated validation
 * checkpoint under the append lease after every drain, so when the witness
 * names exactly the storage this read observed, each frame already passed the
 * contract and canonical-byte checks that dominate a full read. Those two
 * checks are skipped; every ledger-level rule still runs and rebuilds the
 * validator state. The result is used only if that state reproduces the
 * witnessed checkpoint byte for byte with no diagnostics and storage did not
 * move during the read; anything else returns undefined and the caller runs
 * the canonical full validation.
 */
function validateWitnessedFramesV3(
  coordRoot: string,
  storage: LedgerStorageVersionV3,
  discovered: DiscoveredFramesV3,
  options: ReadLedgerV3Options,
): { result: ReadLedgerV3Result; state: LedgerValidationStateV3 } | undefined {
  if (!discovered.active || discovered.diagnostics.length > 0) return undefined;
  const witness = readAdvanceableControlWitnessV3(coordRoot);
  if (!witness || witness.payload.storage.fingerprint !== sha256V3(storage.fingerprint)) {
    return undefined;
  }
  const trusted = validateLedgerFramesV3(discovered.frames, options, true);
  if (trusted.state.diagnostics.length > 0) return undefined;
  const reproduced = checkpointFromValidationStateV3(trusted.state, discovered.active);
  if (canonicalJsonV3(reproduced) !== canonicalJsonV3(witness.checkpoint)) return undefined;
  if (ledgerStorageVersionV3(coordRoot).fingerprint !== storage.fingerprint) return undefined;
  return trusted;
}

function validateLedgerFramesV3(
  frames: readonly LedgerFrameV3[],
  options: ReadLedgerV3Options,
  witnessed = false,
): { result: ReadLedgerV3Result; state: LedgerValidationStateV3 } {
  const state: LedgerValidationStateV3 = {
    ...createRowValidationStateV3(options.accepted_schema_digests ?? acceptedSchemaDigestsV3()),
    diagnostics: [],
    events: [],
    reader_build: options.reader_build ?? "build_harnery-v3",
    event_count: 0,
    schema_digests: new Set(),
    unsupported_schema_digests: new Set(),
  };
  validateLedgerFramesIntoStateV3(frames, state, witnessed);
  return { result: finishLedgerValidationV3(state, options, ledgerFramesBytesV3(frames)), state };
}

/**
 * `witnessed` skips only the per-frame contract and canonical-byte checks, and
 * only validateWitnessedFramesV3 may pass it, after authenticating the frames.
 */
function validateLedgerFramesIntoStateV3(
  frames: readonly LedgerFrameV3[],
  state: LedgerValidationStateV3,
  witnessed = false,
): void {
  state.first_position ??= frames[0]?.position;
  const { diagnostics, events, accepted } = state;

  for (const frame of frames) {
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
    // The stamped digest is read before the row's shape is validated: a row
    // written by a runtime with a schema this one does not know is an unknown
    // digest, not an invalid event. Its ID, producer sequence and (for a
    // genesis) epoch ID are remembered for dependency purposes only, so later
    // rows are not also reported as missing a parent, a genesis or a sequence. It never reaches the per-row checks or any checkpoint, because
    // the read is incomplete.
    const stamped = looseContract.schema_digest;
    if (typeof stamped === "string" && !accepted.has(stamped)) {
      const eventId = typeof loose.event_id === "string" ? loose.event_id : undefined;
      diagnostics.push(diagnostic("unsupported_schema_digest", frame, eventId));
      state.unsupported_schema_digests.add(stamped);
      const genesisId = record(loose.payload).genesis_id;
      if (
        loose.event_type === "ledger.genesis" &&
        state.genesis_id === undefined &&
        typeof genesisId === "string"
      ) {
        state.genesis_id = genesisId;
      }
      if (eventId !== undefined && !state.seen_ids.has(eventId)) {
        state.seen_ids.set(eventId, frame.raw);
        const producer = record(loose.producer);
        if (
          typeof producer.producer_id === "string" &&
          typeof producer.boot_id === "string" &&
          Number.isSafeInteger(producer.sequence)
        ) {
          state.producer_sequences.set(
            `${producer.producer_id}\0${producer.boot_id}`,
            producer.sequence as number,
          );
        }
      }
      continue;
    }
    let event: EventV3;
    if (witnessed) {
      event = parsed as EventV3;
    } else {
      const validation = validateEventV3(parsed);
      if (!validation.ok || !validation.event) {
        diagnostics.push(diagnostic("invalid_contract", frame));
        continue;
      }
      event = validation.event;
      if (canonicalJsonV3(event) !== frame.raw) {
        diagnostics.push(diagnostic("noncanonical_frame", frame, event.event_id));
        continue;
      }
    }
    const shape = event as unknown as EventShape;
    const row: RowV3 = { raw: frame.raw, event };
    if (rowIdentityV3(state, row) !== "new") {
      // A replayed row is skipped and a conflicting one reported; neither
      // changes the validation state.
      for (const code of checkRowV3(state, row)) {
        diagnostics.push(diagnostic(code, frame, shape.event_id));
      }
      applyRowV3(state, row);
      continue;
    }

    if (shape.event_type === "ledger.genesis") {
      if (state.genesis_id !== undefined) {
        recordRowIdentityV3(state, row);
        diagnostics.push(diagnostic("multiple_genesis", frame, shape.event_id));
        continue;
      }
      if (state.event_count !== 0)
        diagnostics.push(diagnostic("genesis_not_first", frame, shape.event_id));
      const payload = shape.payload;
      state.genesis_id = string(payload.genesis_id);
      state.genesis_schema_digest = string(payload.generated_schema_digest);
      if (state.genesis_schema_digest !== shape.contract.schema_digest) {
        diagnostics.push(diagnostic("genesis_digest_mismatch", frame, shape.event_id));
      }
    } else if (state.genesis_id === undefined) {
      diagnostics.push(diagnostic("missing_genesis", frame, shape.event_id));
    }

    for (const code of checkRowV3(state, row)) {
      diagnostics.push(diagnostic(code, frame, shape.event_id));
    }
    applyRowV3(state, row);
    state.schema_digests.add(shape.contract.schema_digest);

    events.push({ event, position: frame.position });
    state.event_count += 1;
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
    ...(state.genesis_schema_digest !== undefined
      ? { genesis_schema_digest: state.genesis_schema_digest }
      : {}),
    schema_digests: [
      ...new Set([...state.schema_digests, ...state.unsupported_schema_digests]),
    ].sort(),
    bytes,
    failed_epochs: [],
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
  return sliceLedgerReadSinceV3(readLedgerFramesV3(frames, options), cursor);
}

/** Apply a resume cursor to a validated read: the events after it, plus the next cursor. */
function sliceLedgerReadSinceV3(
  read: ReadLedgerV3Result,
  cursor?: LedgerCursorV3,
): ReadLedgerV3SinceResult {
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function ledgerReadCacheKeyV3(coordRoot: string, options: ReadLedgerV3Options): string {
  const accepted = [
    ...new Set(options.accepted_schema_digests ?? acceptedSchemaDigestsV3()),
  ].sort();
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
    schema_digests: new Set(cached.validation_state.schema_digests),
    unsupported_schema_digests: new Set(cached.validation_state.unsupported_schema_digests),
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
      failed_epochs: cached.result.failed_epochs,
    },
  };
}

function isolateValidationStateV3(state: LedgerValidationStateV3): LedgerValidationStateV3 {
  return {
    ...state,
    diagnostics: [...state.diagnostics],
    events: [...state.events],
    schema_digests: new Set(state.schema_digests),
    unsupported_schema_digests: new Set(state.unsupported_schema_digests),
  };
}

function checkpointFromValidationStateV3(
  state: LedgerValidationStateV3,
  active: NonNullable<DiscoveredFramesV3["active"]>,
): EventV3AppendValidationCheckpointV3 {
  return {
    format: "harnery-event-v3-append-validation-checkpoint",
    format_version: 2,
    reader_build: state.reader_build,
    schema_digests: [...state.schema_digests].sort(),
    seen_event_ids: [...state.seen_ids.keys()].sort(),
    producer_sequences: [...state.producer_sequences.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
    attestation_ids: [...state.attestations].sort(),
    clocks: [...state.clocks.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([clockId, clock]): [string, number, string?] =>
        clock.monotonic_ns !== undefined
          ? [clockId, clock.observed_at_ms, clock.monotonic_ns.toString()]
          : [clockId, clock.observed_at_ms],
      ),
    event_count: state.event_count,
    ...(state.genesis_id ? { genesis_id: state.genesis_id } : {}),
    active_segment_ordinal: active.segment_ordinal,
    validated_active_bytes: active.bytes,
  };
}

/**
 * Rebuild a reader state from a checkpoint. The accepted set is always the
 * runtime's own additive group, never anything the checkpoint's writer
 * accepted; a checkpoint listing a digest outside that group is unusable, and
 * the caller falls back to a complete read that reports the digest.
 */
function validationStateFromCheckpointV3(
  checkpoint: EventV3AppendValidationCheckpointV3,
): LedgerValidationStateV3 | undefined {
  const rowState = rowValidationStateFromCheckpointV3(checkpoint);
  if (checkpoint.schema_digests.some((digest) => !rowState.accepted.has(digest))) return undefined;
  return {
    ...rowState,
    diagnostics: [],
    events: [],
    reader_build: checkpoint.reader_build,
    event_count: checkpoint.event_count,
    ...(checkpoint.genesis_id ? { genesis_id: checkpoint.genesis_id } : {}),
    schema_digests: new Set(checkpoint.schema_digests),
    unsupported_schema_digests: new Set(),
  };
}

const CHECKPOINT_KEYS = new Set([
  "format",
  "format_version",
  "reader_build",
  "schema_digests",
  "seen_event_ids",
  "producer_sequences",
  "attestation_ids",
  "clocks",
  "event_count",
  "genesis_id",
  "active_segment_ordinal",
  "validated_active_bytes",
]);

function sortedSchemaDigestList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && /^sha256:[a-f0-9]{64}$/.test(item)) &&
    value.every((item, index) => index === 0 || value[index - 1] < item)
  );
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
  const recoveryRoot = eventV3RecoveryRecordsRoot(coordRoot);
  let recoveryNames: string[] = [];
  try {
    recoveryNames = readdirSync(recoveryRoot)
      .filter((name) => name.endsWith(".committed.json"))
      .sort();
  } catch (error) {
    const code = filesystemErrorCode(error);
    if (code !== "ENOENT") {
      const part = `recoveries:${code}`;
      parts.push(part);
      stableParts.push(part);
    }
  }
  for (const name of recoveryNames) {
    const part = `recovery:${name}:${pathStorageVersionV3(join(recoveryRoot, name)).fingerprint}`;
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
