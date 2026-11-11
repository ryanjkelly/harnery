import type { EventV3 } from "./contract.ts";
import type { EventV3AppendValidationCheckpointV3 } from "./reader.ts";
import { acceptedSchemaDigestsV3 } from "./schema-lineage.ts";

/**
 * The per-row checks the canonical ledger reader applies to every new row,
 * shared so that any producer that decides whether a row may enter the ledger
 * asks exactly the question the reader will ask later.
 *
 * Two functions split the work:
 *
 * - `checkRowV3` reports the diagnostic codes the reader would raise for the
 *   row at the current position. It mutates nothing, so a caller can ask
 *   about a row and decide not to admit it.
 * - `applyRowV3` advances the state past the row. The reader applies every
 *   row that reaches the per-row checks, including one that raised a
 *   diagnostic, because that is what it has always done; the reader's
 *   diagnostics already make such a read incomplete.
 *
 * Genesis and activation handling stay in the reader. A row may carry any
 * digest in the accepted set; nothing requires it to equal the genesis digest.
 */

/** Diagnostic codes the shared row check can return. */
export type RowDiagnosticCodeV3 =
  | "conflicting_event_id"
  | "unsupported_schema_digest"
  | "causal_parent_missing"
  | "wall_clock_regression_unmarked"
  | "monotonic_clock_regression"
  | "unresolved_attestation"
  | "producer_sequence_gap";

/** One row as it is or will be framed in the ledger: canonical bytes and parsed event. */
export interface RowV3 {
  raw: string;
  event: EventV3;
}

/** Last observation of one clock. */
export interface RowClockV3 {
  observed_at_ms: number;
  monotonic_ns?: bigint;
}

/** Validation state the shared row check reads and `applyRowV3` advances. */
export interface RowValidationStateV3 {
  /** Schema digests a row may carry: the runtime's additive group. */
  accepted: Set<string>;
  /**
   * Event IDs already in the ledger, mapped to their canonical frame. A state
   * rebuilt from a checkpoint knows only the IDs and maps each to "" until
   * `learnCommittedFramesV3` fills in the bytes a decision needs.
   */
  seen_ids: Map<string, string>;
  /** Last sequence per `producer_id\0boot_id`. */
  producer_sequences: Map<string, number>;
  attestations: Set<string>;
  clocks: Map<string, RowClockV3>;
}

/** Whether the row's event ID is already in the ledger, and with which bytes. */
export type RowIdentityV3 = "new" | "committed" | "conflicting";

interface RowShape {
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

/** Build a fresh state that accepts the given schema digests. */
export function createRowValidationStateV3(
  acceptedSchemaDigests: Iterable<string>,
): RowValidationStateV3 {
  return {
    accepted: new Set(acceptedSchemaDigests),
    seen_ids: new Map(),
    producer_sequences: new Map(),
    attestations: new Set(),
    clocks: new Map(),
  };
}

/**
 * Rebuild the row validation state recorded in an append validation
 * checkpoint. The accepted set is this runtime's own additive group, never a
 * set another runtime recorded.
 */
export function rowValidationStateFromCheckpointV3(
  checkpoint: EventV3AppendValidationCheckpointV3,
): RowValidationStateV3 {
  return {
    accepted: new Set(acceptedSchemaDigestsV3()),
    seen_ids: new Map(checkpoint.seen_event_ids.map((eventId) => [eventId, ""])),
    producer_sequences: new Map(checkpoint.producer_sequences),
    attestations: new Set(checkpoint.attestation_ids),
    clocks: new Map(
      checkpoint.clocks.map(([clockId, observedAtMs, monotonicNs]) => [
        clockId,
        {
          observed_at_ms: observedAtMs,
          ...(monotonicNs !== undefined ? { monotonic_ns: BigInt(monotonicNs) } : {}),
        },
      ]),
    ),
  };
}

/**
 * Classify the row's event ID. A committed row with identical bytes is a
 * replay the reader skips without a diagnostic; different bytes under the same
 * ID are a conflict. Neither changes any state.
 */
export function rowIdentityV3(state: RowValidationStateV3, row: RowV3): RowIdentityV3 {
  const prior = state.seen_ids.get(shape(row).event_id);
  if (prior === undefined) return "new";
  return prior === row.raw ? "committed" : "conflicting";
}

/**
 * Report, in the reader's order, every diagnostic the reader would raise for
 * this row at the current position. Mutates nothing.
 */
export function checkRowV3(state: RowValidationStateV3, row: RowV3): RowDiagnosticCodeV3[] {
  const identity = rowIdentityV3(state, row);
  if (identity === "conflicting") return ["conflicting_event_id"];
  if (identity === "committed") return [];

  const event = shape(row);
  const codes: RowDiagnosticCodeV3[] = [];
  if (!state.accepted.has(event.contract.schema_digest)) codes.push("unsupported_schema_digest");
  // The reader records a row's own ID before it checks the row's parents, so a
  // row naming itself as a parent has always passed this check.
  if (
    event.links.caused_by.some(
      (parentId) => parentId !== event.event_id && !state.seen_ids.has(parentId),
    )
  ) {
    codes.push("causal_parent_missing");
  }
  codes.push(...clockCodes(state, event));
  if (attestationUnresolved(state, event)) codes.push("unresolved_attestation");
  if (producerSequenceGap(state, event)) codes.push("producer_sequence_gap");
  return codes;
}

/**
 * Advance the state past a new row: record its ID, clock, attestation and
 * producer sequence. A row whose ID is already in the ledger changes nothing.
 * The updates happen whether or not `checkRowV3` reported the row.
 */
export function applyRowV3(state: RowValidationStateV3, row: RowV3): void {
  if (rowIdentityV3(state, row) !== "new") return;
  const event = shape(row);
  recordRowIdentityV3(state, row);

  const observedAtMs = Date.parse(event.time.observed_at);
  const monotonicNs = event.time.monotonic_ns ? BigInt(event.time.monotonic_ns) : undefined;
  state.clocks.set(event.time.clock_id, {
    observed_at_ms: observedAtMs,
    ...(monotonicNs !== undefined ? { monotonic_ns: monotonicNs } : {}),
  });

  if (
    event.event_type === "session.started" ||
    event.event_type === "session.attestation_changed"
  ) {
    if (event.attestation_id) state.attestations.add(event.attestation_id);
  }

  state.producer_sequences.set(producerKey(event), event.producer.sequence);
}

/** A row the door declined, with every code the reader would raise for it now. */
export interface DeclinedRowV3<Row> {
  row: Row;
  codes: RowDiagnosticCodeV3[];
}

/**
 * The door check, shared by the writer's drain and archive preparation. Admit
 * rows in the given order, one pass after another, until a pass admits
 * nothing. A row is admitted only when `checkRowV3` raises no code against the
 * state plus every row admitted before it; `applyRowV3` then advances the
 * state. A declined row changes nothing, so rows in a causal cycle never
 * become admissible while the rows beside them are admitted.
 *
 * A row whose event ID is already committed passes only when its bytes equal
 * the committed row's, which the reader skips as a replay; different bytes
 * raise `conflicting_event_id` and wait. A state rebuilt from a checkpoint
 * knows committed IDs without their bytes, so the caller first gives it those
 * bytes with `learnCommittedFramesV3`; a row whose committed bytes the state
 * still does not know is never proven identical and waits.
 */
export function admitRowsV3<Row>(
  state: RowValidationStateV3,
  rows: readonly Row[],
  rowOf: (row: Row) => RowV3,
): { admitted: Row[]; waiting: DeclinedRowV3<Row>[] } {
  const admitted: Row[] = [];
  let pending = [...rows];
  for (;;) {
    const remaining: Row[] = [];
    for (const queued of pending) {
      const row = rowOf(queued);
      if (checkRowV3(state, row).length === 0) {
        applyRowV3(state, row);
        admitted.push(queued);
      } else {
        remaining.push(queued);
      }
    }
    if (remaining.length === pending.length || remaining.length === 0) {
      pending = remaining;
      break;
    }
    pending = remaining;
  }
  return {
    admitted,
    waiting: pending.map((queued) => ({ row: queued, codes: checkRowV3(state, rowOf(queued)) })),
  };
}

/**
 * Give a state rebuilt from a checkpoint the committed bytes of every queued
 * row whose event ID it knows only by ID, so that `checkRowV3` can tell an
 * identical replay (a crash between append and receipt cleanup, or a producer
 * resubmitting an event that already committed) from a different row under a
 * committed ID. `committedFrames` is called at most once, and only when such a
 * row exists, so the common drain pays nothing. It returns the committed
 * canonical frame of each ID it can find, or undefined when it cannot read
 * the ledger completely. Returns the rows whose committed bytes are still
 * unknown; the caller must not judge them.
 */
export function learnCommittedFramesV3<Row>(
  state: RowValidationStateV3,
  rows: readonly Row[],
  rowOf: (row: Row) => RowV3,
  committedFrames: (eventIds: string[]) => ReadonlyMap<string, string> | undefined,
): Row[] {
  const unknown = rows.filter((queued) => state.seen_ids.get(shape(rowOf(queued)).event_id) === "");
  if (unknown.length === 0) return [];
  const eventIds = [...new Set(unknown.map((queued) => shape(rowOf(queued)).event_id))];
  const frames = committedFrames(eventIds);
  for (const eventId of eventIds) {
    const raw = frames?.get(eventId);
    if (raw) state.seen_ids.set(eventId, raw);
  }
  return unknown.filter((queued) => state.seen_ids.get(shape(rowOf(queued)).event_id) === "");
}

/**
 * Record only the row's event ID. The reader uses this for a second genesis,
 * which it rejects before the remaining per-row checks but still remembers.
 */
export function recordRowIdentityV3(state: RowValidationStateV3, row: RowV3): void {
  state.seen_ids.set(shape(row).event_id, row.raw);
}

function clockCodes(state: RowValidationStateV3, event: RowShape): RowDiagnosticCodeV3[] {
  const codes: RowDiagnosticCodeV3[] = [];
  const prior = state.clocks.get(event.time.clock_id);
  const observedAtMs = Date.parse(event.time.observed_at);
  if (prior && observedAtMs < prior.observed_at_ms && event.time.skew !== "regressed") {
    codes.push("wall_clock_regression_unmarked");
  }
  const monotonicNs = event.time.monotonic_ns ? BigInt(event.time.monotonic_ns) : undefined;
  if (
    prior?.monotonic_ns !== undefined &&
    monotonicNs !== undefined &&
    monotonicNs < prior.monotonic_ns
  ) {
    codes.push("monotonic_clock_regression");
  }
  return codes;
}

function attestationUnresolved(state: RowValidationStateV3, event: RowShape): boolean {
  if (event.event_type === "session.started") return false;
  if (event.event_type === "session.attestation_changed") {
    const prior = event.payload.prior_attestation_id;
    return !state.attestations.has(typeof prior === "string" ? prior : "");
  }
  return Boolean(event.attestation_id) && !state.attestations.has(event.attestation_id ?? "");
}

function producerSequenceGap(state: RowValidationStateV3, event: RowShape): boolean {
  const prior = state.producer_sequences.get(producerKey(event));
  return (
    (prior === undefined && event.producer.sequence !== 1) ||
    (prior !== undefined && event.producer.sequence !== prior + 1)
  );
}

function producerKey(event: RowShape): string {
  return `${event.producer.producer_id}\0${event.producer.boot_id}`;
}

function shape(row: RowV3): RowShape {
  return row.event as unknown as RowShape;
}
