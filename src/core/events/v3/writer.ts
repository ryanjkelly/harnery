import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { processMayBeAlive } from "../../../lib/process-alive.ts";
import { fsyncParentDirectory } from "../../storage/durable-record.ts";
import { stateDirMode, stateFileMode, stateModeTooOpen } from "../../storage/modes.ts";
import { acquireNoClobberLease } from "../../storage/no-clobber-lease.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import type { EventV3 } from "./contract.ts";
import { genesisIdFromManifestV3, liveGenesisIdV3 } from "./control.ts";
import { advanceControlWitnessV3, readAdvanceableControlWitnessV3 } from "./control-witness.ts";
import {
  type EventV3AppendValidationCheckpointV3,
  readCommittedFramesV3,
  readEventV3AppendValidationCheckpointV3,
} from "./reader.ts";
import {
  admitRowsV3,
  learnCommittedFramesV3,
  type RowDiagnosticCodeV3,
  type RowV3,
  type RowValidationStateV3,
  rowValidationStateFromCheckpointV3,
} from "./row-validation.ts";
import { acceptedSchemaDigestsV3, schemaGroupForDigestV3 } from "./schema-lineage.ts";
import { assertEventV3, validateEventV3 } from "./validate.ts";

const MAX_LINE_BYTES = 16 * 1024;
const DEFAULT_LEASE_MS = 5_000;
const publicationSleepCell = new Int32Array(new SharedArrayBuffer(4));
const publishingRoots = new Set<string>();

export const EVENT_V3_LEDGER_RELATIVE_ROOT = ".harnery/ledgers/v3" as const;

/**
 * What happened to one written row.
 *
 * - `committed`: the row is in the active ledger (appended now or earlier).
 * - `ready`: the row is durable in the queue and was not drained, because the
 *   caller deferred the drain, another writer held the append lease, or the
 *   drain failed.
 * - `waiting`: the row is durable in the queue, but the door will not admit it
 *   yet; `reason` is the code the reader would raise for it.
 * - `set_aside`: the row's file can never be appended and was renamed aside;
 *   `reason` names the failure.
 */
export type EventV3DurabilityState = "committed" | "ready" | "waiting" | "set_aside";

export interface WriteEventV3Result {
  state: EventV3DurabilityState | "epoch_replaced";
  event_id: string;
  row_digest: `sha256:${string}`;
  ready_path?: string;
  diagnostic_code?: "wal_drain_failed";
  reason?: EventV3WaitingReasonV3 | EventV3SetAsideReasonV3;
}

export interface WriteEventV3Options {
  leaseMs?: number;
  /**
   * Leave the durable row in the ready WAL instead of draining it into the
   * active authority during this call. A later `drainReadyEventsV3` commits
   * the batch under one append lease. Production writers default to false;
   * the option exists for matched harness-cost experiments.
   */
  deferDrain?: boolean;
  /**
   * Epoch fence: the genesis id of the epoch this event was produced for.
   * An event carries per-epoch authority (producer boot sequences start at 1
   * and every causal link must resolve inside its own epoch), so committing
   * it into a replaced epoch would poison the new authority. When set, the
   * write refuses with `epoch_replaced` if the live genesis no longer
   * matches, the spooled ready row is tagged with the id, and the drain
   * quarantines any tagged row whose epoch has been replaced underneath it.
   */
  expectedGenesisId?: `gex_${string}`;
  now?: () => number;
  onStep?: (step: EventV3WriteStep, eventId?: string) => void;
}

export type EventV3WriteStep =
  | "ready_temp_flushed"
  | "ready_published"
  | "active_tail_repaired"
  | "active_row_appended"
  | "active_row_flushed"
  | "receipt_committed"
  | "receipt_removed";

/**
 * Persist one already-normalized V3 event through the spool-first WAL.
 *
 * A successful ready rename is the durability boundary. Lease contention or
 * append failure leaves that ready record recoverable and returns `ready`
 * instead of changing the producing tool's result.
 */
export function writeEventV3(
  coordRoot: string,
  event: EventV3,
  options: WriteEventV3Options = {},
): WriteEventV3Result {
  // Builders stamp the runtime's own digest. A stored event that crash
  // recovery resubmits unchanged may carry an earlier digest of the same
  // additive group, which the reader accepts in this epoch, so its original
  // bytes are written as they are. Any other digest is refused.
  const stamped = (event as { contract?: { schema_digest?: unknown } }).contract?.schema_digest;
  if (typeof stamped !== "string" || !acceptedSchemaDigestsV3().includes(stamped as never)) {
    throw new Error("event schema digest is not accepted by this V3 writer");
  }
  assertEventV3(event);
  const row = `${canonicalJsonV3(event)}\n`;
  const bytes = Buffer.byteLength(row, "utf8");
  if (bytes > MAX_LINE_BYTES) {
    throw new Error(`event exceeds the V3 ${MAX_LINE_BYTES}-byte row limit`);
  }
  const rowDigest = sha256V3(row);
  const epochTag = options.expectedGenesisId ? `-${options.expectedGenesisId}` : "";
  const readyName = `${String(event.producer.sequence).padStart(16, "0")}-${event.event_id}-${rowDigest.slice(7)}${epochTag}.ready`;
  const readyPath = withReadyPublicationLease(coordRoot, () => {
    const paths = ensureEventV3Layout(coordRoot);
    if (options.expectedGenesisId && liveGenesisIdV3(coordRoot) !== options.expectedGenesisId) {
      return undefined;
    }
    const path = join(paths.spool, readyName);
    writeReadyRecord(paths.spool, path, row, event.event_id, options.onStep);
    return path;
  });
  if (!readyPath) {
    return { state: "epoch_replaced", event_id: event.event_id, row_digest: rowDigest };
  }
  options.onStep?.("ready_published", event.event_id);

  if (options.deferDrain) {
    return {
      state: "ready",
      event_id: event.event_id,
      row_digest: rowDigest,
      ready_path: readyPath,
    };
  }

  let outcome: EventV3DrainOutcomeV3;
  try {
    outcome = withEventV3LedgerLease(coordRoot, options, () =>
      drainReadyEventsDetailedUnderLeaseV3(ensureEventV3Layout(coordRoot), options),
    );
  } catch {
    return {
      state: "ready",
      event_id: event.event_id,
      row_digest: rowDigest,
      ready_path: readyPath,
      diagnostic_code: "wal_drain_failed",
    };
  }
  const base = { event_id: event.event_id, row_digest: rowDigest };
  if (existsSync(readyPath)) {
    const waiting = outcome.waiting.get(readyName);
    return waiting
      ? { state: "waiting", ...base, ready_path: readyPath, reason: waiting }
      : { state: "ready", ...base, ready_path: readyPath };
  }
  if (existsSync(`${readyPath.slice(0, -".ready".length)}.epoch-replaced`)) {
    return { state: "epoch_replaced", ...base };
  }
  const setAside = setAsideReasonForRowV3(readyPath, outcome);
  if (setAside) return { state: "set_aside", ...base, reason: setAside };
  return { state: "committed", ...base };
}

/** The reason the row's ready file or receipt was set aside, by this drain or an earlier one. */
function setAsideReasonForRowV3(
  readyPath: string,
  outcome: EventV3DrainOutcomeV3,
): EventV3SetAsideReasonV3 | undefined {
  const readyName = basename(readyPath);
  const committedName = `${readyName.slice(0, -".ready".length)}.committed`;
  const recorded = outcome.set_aside.get(readyName) ?? outcome.set_aside.get(committedName);
  if (recorded) return recorded;
  const spool = dirname(readyPath);
  const aside = readdirSync(spool).find(
    (name) =>
      (name.startsWith(`${readyName}.`) || name.startsWith(`${committedName}.`)) &&
      name.endsWith(EVENT_V3_SET_ASIDE_SUFFIX),
  );
  if (!aside) return undefined;
  return readSetAsideReasonV3(join(spool, aside)) ?? "unreadable";
}

function readSetAsideReasonV3(setAsidePath: string): EventV3SetAsideReasonV3 | undefined {
  try {
    const reason = (
      JSON.parse(readFileSync(`${setAsidePath}.json`, "utf8")) as { reason?: unknown }
    ).reason;
    return typeof reason === "string" ? (reason as EventV3SetAsideReasonV3) : undefined;
  } catch {
    return undefined;
  }
}

/** Drain every durable ready record under the fenced append lease. */
export function drainReadyEventsV3(coordRoot: string, options: WriteEventV3Options = {}): number {
  return withEventV3LedgerLease(coordRoot, options, () =>
    drainReadyEventsUnderLeaseV3(ensureEventV3Layout(coordRoot), options),
  );
}

/**
 * Drain the current epoch's ready records when the caller already holds the
 * append lease, as an epoch cutover does before it archives the directory.
 */
export function drainReadyEventsHeldLeaseV3(coordRoot: string): number {
  return drainReadyEventsUnderLeaseV3(eventV3Paths(coordRoot));
}

export function withEventV3LedgerLease<T>(
  coordRoot: string,
  options: WriteEventV3Options,
  operation: () => T,
): T {
  const paths = eventV3Paths(coordRoot);
  // This lock survives both epoch and schema changes.
  const authority = createHash("sha256").update(resolve(coordRoot)).digest("hex");
  const lease = acquireNoClobberLease({
    path: paths.lease,
    scope: "event-v3-append",
    authoritySha256: authority,
    staleAfterMs: options.leaseMs ?? DEFAULT_LEASE_MS,
    now: options.now,
    validateStaleOwner: (owner) => owner.host === hostname() && !processMayBeAlive(owner.pid),
  });
  try {
    return operation();
  } finally {
    lease.release();
  }
}

function withReadyPublicationLease<T>(coordRoot: string, operation: () => T): T {
  const root = resolve(coordRoot);
  // Writes are synchronous. A nested publisher can borrow this stack's lease,
  // but a cutover must acquire its own: it cannot move an unfinished temp row.
  if (publishingRoots.has(root)) return operation();
  return withEventV3PublicationLease(root, () => {
    publishingRoots.add(root);
    try {
      return operation();
    } finally {
      publishingRoots.delete(root);
    }
  });
}

/** Stable across epoch renames. Cutovers always acquire exclusive ownership. */
export function withEventV3PublicationLease<T>(coordRoot: string, operation: () => T): T {
  const root = resolve(coordRoot);
  let lease: ReturnType<typeof acquireNoClobberLease> | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      lease = acquireNoClobberLease({
        path: join(root, ".harnery", "private", "event-v3-publication-lease"),
        scope: "event-v3-publication",
        authoritySha256: createHash("sha256").update(root).digest("hex"),
        staleAfterMs: DEFAULT_LEASE_MS,
        validateStaleOwner: (owner) => owner.host === hostname() && !processMayBeAlive(owner.pid),
      });
      break;
    } catch (error) {
      if (attempt === 19) throw error;
      Atomics.wait(publicationSleepCell, 0, 0, 25);
    }
  }
  if (!lease) throw new Error("event_v3_publication_lease_busy");
  try {
    return operation();
  } finally {
    lease.release();
  }
}

export function drainReadyEventsUnderLeaseV3(
  paths: ReturnType<typeof eventV3Paths>,
  options: WriteEventV3Options = {},
): number {
  return drainReadyEventsDetailedUnderLeaseV3(paths, options).committed;
}

/** Why the door left a valid queued row in the queue. */
export type EventV3WaitingReasonV3 =
  | RowDiagnosticCodeV3
  | "epoch_schema_unknown"
  | "append_checkpoint_unavailable";

/** Why a queued file or receipt was renamed aside instead of appended. */
export type EventV3SetAsideReasonV3 =
  | "unreadable"
  | "invalid_size"
  | "incomplete_frame"
  | "malformed_json"
  | "invalid_contract"
  | "noncanonical_frame"
  | "receipt_conflict";

/** What one drain did with the queue, keyed by queued file name. */
export interface EventV3DrainOutcomeV3 {
  committed: number;
  waiting: Map<string, EventV3WaitingReasonV3>;
  set_aside: Map<string, EventV3SetAsideReasonV3>;
}

/** Suffix of a queued file or receipt the drain renamed aside. */
export const EVENT_V3_SET_ASIDE_SUFFIX = ".set-aside" as const;

function drainReadyEventsDetailedUnderLeaseV3(
  paths: ReturnType<typeof eventV3Paths>,
  options: WriteEventV3Options = {},
): EventV3DrainOutcomeV3 {
  const outcome: EventV3DrainOutcomeV3 = {
    committed: 0,
    waiting: new Map(),
    set_aside: new Map(),
  };
  let priorWitness = readAdvanceableControlWitnessV3(paths.coordRoot);
  if (repairUnterminatedActiveFrame(paths.active)) {
    options.onStep?.("active_tail_repaired");
    // The repair can remove IDs that the old witness considered committed.
    // Never use that stale checkpoint to release a dependent ready row.
    priorWitness = undefined;
  }
  requeueCommittedReceipts(paths.spool, outcome, options.now);
  const readyNames = readdirSync(paths.spool)
    .filter((name) => name.endsWith(".ready"))
    .sort();
  if (readyNames.length === 0) return outcome;
  const drainableNames = quarantineReplacedEpochRows(paths, readyNames);
  if (drainableNames.length === 0) return outcome;
  const queued: ReadyEventRowV3[] = [];
  for (const readyName of drainableNames) {
    const readyPath = join(paths.spool, readyName);
    const read = readQueuedRowV3(readyPath);
    if (read.kind === "unknown_digest") {
      // A newer runtime's row: leave it exactly where it is for that runtime.
      outcome.waiting.set(readyName, "epoch_schema_unknown");
    } else if (read.kind === "unusable") {
      setAsideSpoolFileV3(readyPath, read.reason, options.now);
      outcome.set_aside.set(readyName, read.reason);
    } else {
      queued.push({ readyName, readyPath, row: read.row, event: read.event });
    }
  }
  if (queued.length === 0) return outcome;
  const verdict = doorVerdictV3(
    paths,
    priorWitness?.checkpoint ?? readEventV3AppendValidationCheckpointV3(paths.coordRoot),
    queued,
  );
  let readyRows: ReadyEventRowV3[];
  if (verdict.kind === "bare") {
    readyRows = causallyOrderedReadyRowsWithinBatch(queued);
  } else {
    readyRows = verdict.admitted;
    for (const { row, reason } of verdict.waiting) outcome.waiting.set(row.readyName, reason);
  }
  if (readyRows.length === 0) return outcome;
  const activeFd = openSync(paths.active, "a", stateFileMode());
  let committed = 0;
  try {
    for (const { readyName, readyPath, row } of readyRows) {
      const eventId = eventIdFromReadyName(readyName);
      writeSync(activeFd, row, undefined, "utf8");
      options.onStep?.("active_row_appended", eventId);
      fsyncSync(activeFd);
      options.onStep?.("active_row_flushed", eventId);
      const committedPath = `${readyPath.slice(0, -".ready".length)}.committed`;
      renameSync(readyPath, committedPath);
      fsyncParentDirectory(committedPath);
      options.onStep?.("receipt_committed", eventId);
      unlinkSync(committedPath);
      fsyncParentDirectory(committedPath);
      options.onStep?.("receipt_removed", eventId);
      committed += 1;
    }
  } finally {
    closeSync(activeFd);
  }
  outcome.committed = committed;
  if (committed > 0 && priorWitness) {
    advanceControlWitnessV3(
      paths.coordRoot,
      priorWitness,
      genesisIdFromManifestV3(join(paths.root, "genesis.json")),
    );
  }
  return outcome;
}

type DoorVerdictV3<Row extends ReadyEventRowV3> =
  | { kind: "bare" }
  | {
      kind: "judged";
      admitted: Row[];
      waiting: Array<{ row: Row; reason: EventV3WaitingReasonV3 }>;
    };

/**
 * Decide which queued rows the door admits, from the append validation
 * checkpoint (the witness's, or one from a canonical read).
 *
 * - With a checkpoint, the reader's own per-row check is the door. A queued
 *   row under an already committed event ID makes the door read that row's
 *   committed bytes once (see `readCommittedFramesV3`); if the ledger cannot
 *   be read completely, the row waits with `append_checkpoint_unavailable`.
 *   The state accepts this runtime's additive group only; a checkpoint listing a digest
 *   outside that group describes an epoch this runtime does not serve, so
 *   every row waits with `epoch_schema_unknown` and nothing is appended.
 * - With a genesis and committed rows but no checkpoint (the canonical read
 *   failed), every row waits with `append_checkpoint_unavailable`.
 * - Bare writer fixtures and pre-genesis bootstrap rows have no authority to
 *   consult; the caller keeps the within-batch causal ordering.
 */
function doorVerdictV3<Row extends ReadyEventRowV3>(
  paths: ReturnType<typeof eventV3Paths>,
  checkpoint: EventV3AppendValidationCheckpointV3 | undefined,
  rows: readonly Row[],
): DoorVerdictV3<Row> {
  if (checkpoint?.genesis_id) {
    const state = rowValidationStateFromCheckpointV3(checkpoint);
    if (checkpoint.schema_digests.some((digest) => !state.accepted.has(digest))) {
      return {
        kind: "judged",
        admitted: [],
        waiting: rows.map((row) => ({ row, reason: "epoch_schema_unknown" })),
      };
    }
    // Only a queued row under an already committed event ID costs a read: the
    // checkpoint keeps committed IDs without their bytes.
    const unknown = new Set(
      learnCommittedFramesV3(state, rows, readyRowAsRowV3, (eventIds) =>
        readCommittedFramesV3(paths.coordRoot, eventIds),
      ),
    );
    const admission = admitReadyRowsV3(
      state,
      rows.filter((row) => !unknown.has(row)),
    );
    return {
      kind: "judged",
      admitted: admission.admitted,
      waiting: [
        ...admission.waiting.map(({ row, codes }) => ({
          row,
          reason: codes[0] ?? ("causal_parent_missing" as const),
        })),
        ...[...unknown].map((row) => ({ row, reason: "append_checkpoint_unavailable" as const })),
      ],
    };
  }
  if (existsSync(join(paths.root, "genesis.json")) && statSync(paths.active).size > 0) {
    return {
      kind: "judged",
      admitted: [],
      waiting: rows.map((row) => ({ row, reason: "append_checkpoint_unavailable" })),
    };
  }
  return { kind: "bare" };
}

/** A valid queued row the door currently declines. */
export interface EventV3WaitingRowV3 {
  name: string;
  event_id?: string;
  instance_id?: string;
  generation_id?: string;
  producer_sequence?: number;
  reason: EventV3WaitingReasonV3;
  queued_at_ms: number;
}

/** A queued file or receipt the drain renamed aside. */
export interface EventV3SetAsideFileV3 {
  name: string;
  reason: EventV3SetAsideReasonV3 | "unknown";
  generation_id?: string;
  set_aside_at_ms: number;
}

export interface EventV3QueueInspectionV3 {
  waiting: EventV3WaitingRowV3[];
  set_aside: EventV3SetAsideFileV3[];
}

/**
 * Report, without changing anything, which queued rows the door would decline
 * now and which files have been set aside. Rows the door would admit are only
 * undrained and are not reported; unusable files are reported once a drain
 * has set them aside.
 */
export function inspectEventV3QueueV3(
  coordRoot: string,
  options: { generationId?: string } = {},
): EventV3QueueInspectionV3 {
  const paths = eventV3Paths(coordRoot);
  if (!existsSync(paths.spool)) return { waiting: [], set_aside: [] };
  const names = readdirSync(paths.spool).sort();
  const liveGenesisId = existsSync(join(paths.root, "genesis.json"))
    ? genesisIdFromManifestV3(join(paths.root, "genesis.json"))
    : undefined;
  const waiting: EventV3WaitingRowV3[] = [];
  const queued: Array<ReadyEventRowV3 & { queuedAtMs: number; reported: boolean }> = [];
  for (const name of names) {
    if (!name.endsWith(".ready")) continue;
    const tag = epochTagFromReadyName(name);
    if (tag !== undefined && tag !== liveGenesisId) continue;
    const path = join(paths.spool, name);
    const loose = looseQueuedRowV3(path);
    const reported =
      options.generationId === undefined || loose.generation_id === options.generationId;
    const read = readQueuedRowV3(path);
    const queuedAtMs = mtimeMsOrZero(path);
    if (read.kind === "unknown_digest") {
      if (!reported) continue;
      waiting.push({
        name,
        ...loose,
        reason: "epoch_schema_unknown",
        queued_at_ms: queuedAtMs,
      });
    } else if (read.kind === "row") {
      queued.push({
        readyName: name,
        readyPath: path,
        row: read.row,
        event: read.event,
        queuedAtMs,
        reported,
      });
    }
  }
  if (queued.some((row) => row.reported)) {
    const verdict = doorVerdictV3(
      paths,
      readAdvanceableControlWitnessV3(coordRoot)?.checkpoint ??
        readEventV3AppendValidationCheckpointV3(coordRoot),
      queued,
    );
    // Bare roots keep within-batch ordering and decline nothing here.
    const declined = verdict.kind === "bare" ? [] : verdict.waiting;
    for (const { row, reason } of declined) {
      if (!row.reported) continue;
      waiting.push({
        name: row.readyName,
        ...looseQueuedRowV3(row.readyPath),
        reason,
        queued_at_ms: row.queuedAtMs,
      });
    }
  }
  const setAside: EventV3SetAsideFileV3[] = [];
  for (const name of names) {
    if (!name.endsWith(EVENT_V3_SET_ASIDE_SUFFIX)) continue;
    const path = join(paths.spool, name);
    const generationId = looseQueuedRowV3(path).generation_id;
    if (options.generationId !== undefined && generationId !== options.generationId) continue;
    setAside.push({
      name,
      reason: readSetAsideReasonV3(path) ?? "unknown",
      ...(generationId ? { generation_id: generationId } : {}),
      set_aside_at_ms: mtimeMsOrZero(path),
    });
  }
  waiting.sort((left, right) => left.name.localeCompare(right.name));
  return { waiting, set_aside: setAside };
}

/**
 * Whether the generation still has rows in the queue after an ordinary drain.
 * After a drain every such row is waiting, so a producer about to act on that
 * generation's behalf holds off and retries on its next pass. A drain that
 * cannot run (another writer holds the lease) leaves the queue as it is, and
 * any queued row of the generation counts.
 */
export function generationHasWaitingRowsV3(coordRoot: string, generationId: string): boolean {
  const paths = eventV3Paths(coordRoot);
  if (!existsSync(paths.spool)) return false;
  try {
    drainReadyEventsV3(coordRoot);
  } catch {
    // Judge the queue as it stands.
  }
  return readdirSync(paths.spool).some(
    (name) =>
      name.endsWith(".ready") &&
      looseQueuedRowV3(join(paths.spool, name)).generation_id === generationId,
  );
}

/** Identity fields read from a queued file without validating it. */
function looseQueuedRowV3(path: string): {
  event_id?: string;
  instance_id?: string;
  generation_id?: string;
  producer_sequence?: number;
} {
  try {
    if (statSync(path).size > MAX_LINE_BYTES) return {};
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      event_id?: unknown;
      scope?: { instance_id?: unknown; generation_id?: unknown };
      producer?: { sequence?: unknown };
    };
    return {
      ...(typeof value.event_id === "string" ? { event_id: value.event_id } : {}),
      ...(typeof value.scope?.instance_id === "string"
        ? { instance_id: value.scope.instance_id }
        : {}),
      ...(typeof value.scope?.generation_id === "string"
        ? { generation_id: value.scope.generation_id }
        : {}),
      ...(typeof value.producer?.sequence === "number"
        ? { producer_sequence: value.producer.sequence }
        : {}),
    };
  } catch {
    return {};
  }
}

function mtimeMsOrZero(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export interface ReadyEventRowV3 {
  readyName: string;
  readyPath: string;
  row: string;
  event: EventV3;
}

/** A queued row the door declined, with the first code the reader would raise for it. */
export interface WaitingReadyRowV3<Row extends ReadyEventRowV3 = ReadyEventRowV3> {
  row: Row;
  codes: RowDiagnosticCodeV3[];
}

/**
 * The door check. Admit queued rows in the queue's deterministic filename
 * order, one pass after another, until a pass admits nothing. A row is
 * admitted only when `checkRowV3` raises no code against the state built from
 * the checkpoint plus every row admitted before it; `applyRowV3` then advances
 * that state. A row that raises a code changes nothing and waits, so rows in a
 * causal cycle simply never become admissible while the rows beside them are
 * appended.
 *
 * A row whose event ID is already committed passes only when its bytes equal
 * the committed row's: an identical replay after a crash between append and
 * receipt cleanup, which the reader skips. Different bytes wait with
 * `conflicting_event_id`. A state rebuilt from a checkpoint must first learn
 * the committed bytes through `learnCommittedFramesV3`.
 */
export function admitReadyRowsV3<Row extends ReadyEventRowV3>(
  state: RowValidationStateV3,
  rows: readonly Row[],
): { admitted: Row[]; waiting: WaitingReadyRowV3<Row>[] } {
  return admitRowsV3(state, rows, readyRowAsRowV3);
}

function readyRowAsRowV3(queued: ReadyEventRowV3): RowV3 {
  return { raw: queued.row.slice(0, -1), event: queued.event };
}

function causallyOrderedReadyRowsWithinBatch(rows: ReadyEventRowV3[]): ReadyEventRowV3[] {
  const pending = new Map(rows.map((row) => [row.event.event_id, row]));
  const ordered: ReadyEventRowV3[] = [];
  while (pending.size > 0) {
    const next = rows.find(({ event }) => {
      const causes = (event.links as { caused_by: string[] }).caused_by;
      return pending.has(event.event_id) && causes.every((eventId) => !pending.has(eventId));
    });
    if (!next) throw new Error("ready V3 events contain a causal dependency cycle");
    pending.delete(next.event.event_id);
    ordered.push(next);
  }
  return ordered;
}

/**
 * A `.committed` receipt is created only after the active row is flushed. If
 * the process dies before unlinking it, replaying the exact canonical row is
 * safe: the validating reader deduplicates the event ID and detects conflicts.
 * A receipt that cannot be read, or that disagrees with its ready twin, is
 * renamed aside so it cannot stall the queue; one stamped with a schema this
 * runtime does not know is left for the runtime that wrote it.
 */
function requeueCommittedReceipts(
  spool: string,
  outcome: EventV3DrainOutcomeV3,
  now?: () => number,
): void {
  const committedNames = readdirSync(spool)
    .filter((name) => name.endsWith(".committed"))
    .sort();
  for (const committedName of committedNames) {
    const committedPath = join(spool, committedName);
    const read = readQueuedRowV3(committedPath);
    if (read.kind === "unknown_digest") continue;
    if (read.kind === "unusable") {
      setAsideSpoolFileV3(committedPath, read.reason, now);
      outcome.set_aside.set(committedName, read.reason);
      continue;
    }
    const readyPath = `${committedPath.slice(0, -".committed".length)}.ready`;
    if (existsSync(readyPath)) {
      if (readFileSync(readyPath, "utf8") !== read.row) {
        setAsideSpoolFileV3(committedPath, "receipt_conflict", now);
        outcome.set_aside.set(committedName, "receipt_conflict");
        continue;
      }
      unlinkSync(committedPath);
    } else {
      renameSync(committedPath, readyPath);
    }
    fsyncParentDirectory(readyPath);
  }
}

type QueuedRowReadV3 =
  | { kind: "row"; row: string; event: EventV3 }
  | { kind: "unknown_digest" }
  | { kind: "unusable"; reason: EventV3SetAsideReasonV3 };

/**
 * Read one queued file or receipt without throwing. A file that parses as
 * JSON but carries a schema digest outside this runtime's lineage belongs to
 * a newer runtime and is reported as such before its shape is judged.
 */
function readQueuedRowV3(path: string): QueuedRowReadV3 {
  let row: string;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return { kind: "unusable", reason: "unreadable" };
    if (stat.size <= 1 || stat.size > MAX_LINE_BYTES) {
      return { kind: "unusable", reason: "invalid_size" };
    }
    row = readFileSync(path, "utf8");
  } catch {
    return { kind: "unusable", reason: "unreadable" };
  }
  if (!row.endsWith("\n") || row.slice(0, -1).includes("\n")) {
    return { kind: "unusable", reason: "incomplete_frame" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row);
  } catch {
    return { kind: "unusable", reason: "malformed_json" };
  }
  const digest = (parsed as { contract?: { schema_digest?: unknown } } | null)?.contract
    ?.schema_digest;
  if (typeof digest === "string" && schemaGroupForDigestV3(digest) === undefined) {
    return { kind: "unknown_digest" };
  }
  if (!validateEventV3(parsed).ok) return { kind: "unusable", reason: "invalid_contract" };
  if (`${canonicalJsonV3(parsed)}\n` !== row) {
    return { kind: "unusable", reason: "noncanonical_frame" };
  }
  return { kind: "row", row, event: parsed as EventV3 };
}

/**
 * Rename a queued file that can never be appended beside the queue, keep its
 * bytes, and record the reason in a sidecar. Nothing is deleted.
 */
function setAsideSpoolFileV3(
  path: string,
  reason: EventV3SetAsideReasonV3,
  now: () => number = Date.now,
): void {
  let target = `${path}${EVENT_V3_SET_ASIDE_SUFFIX}`;
  if (existsSync(target)) target = `${path}.${randomUUID()}${EVENT_V3_SET_ASIDE_SUFFIX}`;
  renameSync(path, target);
  fsyncParentDirectory(target);
  try {
    writeFileSync(
      `${target}.json`,
      `${JSON.stringify({
        format: "harnery-event-v3-set-aside",
        format_version: 1,
        reason,
        set_aside_at: new Date(now()).toISOString(),
      })}\n`,
      { mode: stateFileMode(), flag: "wx" },
    );
    fsyncParentDirectory(target);
  } catch {
    // The renamed file is the durable record; a missing sidecar reads as an unknown reason.
  }
}

export function eventV3Paths(coordRoot: string) {
  const resolvedCoordRoot = resolve(coordRoot);
  const root = join(resolvedCoordRoot, EVENT_V3_LEDGER_RELATIVE_ROOT);
  return {
    coordRoot: resolvedCoordRoot,
    root,
    active: join(root, "active.ndjson"),
    catalog: join(root, "catalog.json"),
    spool: join(root, "spool"),
    diagnostics: join(root, "diagnostics"),
    segments: join(root, "segments"),
    authorityOutbox: join(root, "authority-outbox"),
    lease: join(resolvedCoordRoot, ".harnery", "private", "event-v3-append-lease"),
  };
}

/** Directory holding loose diagnostic records written beside the ledger. */
export function eventV3DiagnosticsRootV3(coordRoot: string): string {
  return eventV3Paths(coordRoot).diagnostics;
}

export function ensureEventV3Layout(coordRoot: string) {
  assertSupportedPath(coordRoot);
  const paths = eventV3Paths(coordRoot);
  for (const path of [
    paths.root,
    paths.spool,
    paths.diagnostics,
    paths.segments,
    paths.authorityOutbox,
  ]) {
    mkdirSync(path, { recursive: true, mode: stateDirMode() });
    chmodSync(path, stateDirMode());
  }
  if (!existsSync(paths.active)) {
    let fd: number | undefined;
    try {
      fd = openSync(paths.active, "wx", stateFileMode());
      fsyncSync(fd);
      fsyncParentDirectory(paths.active);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const active = lstatSync(paths.active);
  if (!active.isFile() || active.isSymbolicLink() || stateModeTooOpen(active.mode)) {
    throw new Error("active V3 ledger must be a regular file closed to other users");
  }
  return paths;
}

function writeReadyRecord(
  spool: string,
  readyPath: string,
  row: string,
  eventId: string,
  onStep?: WriteEventV3Options["onStep"],
): void {
  const temporary = join(spool, `.tmp-${process.pid}-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", stateFileMode());
    writeFileSync(fd, row, "utf8");
    fsyncSync(fd);
    onStep?.("ready_temp_flushed", eventId);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, readyPath);
    fsyncParentDirectory(readyPath);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function repairUnterminatedActiveFrame(activePath: string): boolean {
  const size = statSync(activePath).size;
  if (size === 0) return false;
  const tailBytes = Math.min(size, MAX_LINE_BYTES + 1);
  const fd = openSync(activePath, "r");
  const tail = Buffer.allocUnsafe(tailBytes);
  try {
    const bytesRead = readFileTail(fd, tail, size - tailBytes);
    if (bytesRead > 0 && tail[bytesRead - 1] === 0x0a) return false;
    const lastNewline = tail.lastIndexOf(0x0a, bytesRead - 1);
    if (lastNewline < 0 && size > MAX_LINE_BYTES) {
      throw new Error("active V3 tail exceeds the frame limit without a boundary");
    }
    const repairedSize = size - tailBytes + Math.max(0, lastNewline + 1);
    truncateSync(activePath, repairedSize);
  } finally {
    closeSync(fd);
  }
  const repairFd = openSync(activePath, "r+");
  try {
    fsyncSync(repairFd);
  } finally {
    closeSync(repairFd);
  }
  fsyncParentDirectory(activePath);
  return true;
}

function eventIdFromReadyName(name: string): string | undefined {
  const match = name.match(/^\d{16}-(evt_[0-9a-f-]{36})-/);
  return match?.[1];
}

function epochTagFromReadyName(name: string): `gex_${string}` | undefined {
  const match = name.match(/-(gex_[0-9a-f-]{36})\.ready$/);
  return match ? (match[1] as `gex_${string}`) : undefined;
}

/**
 * Move every ready row tagged with a replaced epoch out of the drainable
 * spool. A tagged row was produced for exactly one epoch; committing it into
 * a successor would break that epoch's boot-sequence and causal-link
 * authority, so the row is preserved beside the spool as `.epoch-replaced`
 * evidence instead of ever reaching the active file.
 */
function quarantineReplacedEpochRows(
  paths: ReturnType<typeof eventV3Paths>,
  readyNames: string[],
): string[] {
  if (!readyNames.some((name) => epochTagFromReadyName(name) !== undefined)) return readyNames;
  const liveGenesisId = genesisIdFromManifestV3(join(paths.root, "genesis.json"));
  const drainable: string[] = [];
  for (const name of readyNames) {
    const tag = epochTagFromReadyName(name);
    if (tag === undefined || tag === liveGenesisId) {
      drainable.push(name);
      continue;
    }
    const readyPath = join(paths.spool, name);
    const quarantinePath = `${readyPath.slice(0, -".ready".length)}.epoch-replaced`;
    renameSync(readyPath, quarantinePath);
    fsyncParentDirectory(quarantinePath);
  }
  return drainable;
}

function readFileTail(fd: number, buffer: Buffer, position: number): number {
  let read = 0;
  while (read < buffer.length) {
    const count = requireReadSync(fd, buffer, read, buffer.length - read, position + read);
    if (count === 0) break;
    read += count;
  }
  return read;
}

function requireReadSync(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): number {
  // Kept in one helper so the storage state machine has a single positional-read seam.
  return readSync(fd, buffer, offset, length, position);
}

function assertSupportedPath(coordRoot: string): void {
  if (
    /^(\\\\|\/\/wsl(?:\.localhost)?\/)/i.test(coordRoot) ||
    /^\/mnt\/[a-z](?:\/|$)/i.test(coordRoot)
  ) {
    throw new Error("V3 writer refuses direct UNC or cross-boundary coordination roots");
  }
}
