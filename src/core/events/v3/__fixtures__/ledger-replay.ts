/**
 * Synthetic replay fixtures for the event ledger's known failure families.
 *
 * Every builder makes events from the contract's own fixture sampler, so the
 * rows are valid V3 events with invented identities. Nothing here copies a
 * recorded ledger row. Tests own their temporary roots. The queue helpers take
 * the spool directory from the test, so only the writer and tests name ledger
 * storage.
 */
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EventV3Fixture,
  eventV3Fixture,
  fixtureObject,
} from "../../../../../tests/helpers/event-v3.ts";
import { stateFileMode } from "../../../storage/modes.ts";
import { initializeEventLedgerV3 } from "../bootstrap.ts";
import { canonicalJsonV3, sha256V3 } from "../canonical.ts";
import type { EventV3 } from "../contract.ts";
import { EVENT_V3_SCHEMA_DIGEST, EVENT_V3_SCHEMA_LINEAGE } from "../generated.ts";
import type { LedgerFrameV3 } from "../reader.ts";
import { assertEventV3 } from "../validate.ts";

export type ReplayDigestV3 = `sha256:${string}`;

/** A digest no lineage holds: what a runtime from an unpublished schema would stamp. */
export const UNKNOWN_SCHEMA_DIGEST_V3: ReplayDigestV3 = `sha256:${"e".repeat(64)}`;

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

/** Create a throwaway coordination root. The caller removes it. */
export function replayRootV3(prefix = "harnery-v3-replay-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Initialize a fresh active epoch on the runtime's own schema digest. */
export function initializeReplayLedgerV3(root: string): void {
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture-replay",
    hostBuild: "fixture-replay-host",
    configDigest: sha256V3("fixture-replay-config"),
    approvalRecordId: "fixture-replay",
    now: () => new Date("2026-08-20T09:00:00.000Z"),
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** One synthetic session: its producer, clock and attestation identities. */
export interface ReplaySessionV3 {
  label: string;
  instance_id: string;
  session_id: string;
  generation_id: string;
  attestation_id: string;
  producer_id: string;
  boot_id: string;
  clock_id: string;
  /** Producer sequence the next event takes. */
  next_sequence: number;
  /** Wall and monotonic time (milliseconds) the next event takes. */
  next_ms: number;
}

export interface ReplayEventOptionsV3 {
  caused_by?: readonly string[];
  /** Override the producer sequence; the session counter still advances past it. */
  sequence?: number;
  /** Override the observed time; the session clock is left unchanged. */
  observed_at?: string;
  monotonic_ns?: string;
  schema_digest?: string;
  mutate?: (event: EventV3Fixture) => void;
}

const BASE_MS = Date.parse("2026-08-20T10:00:00.000Z");

/**
 * Builds events for several synthetic sessions with unique IDs, per-session
 * producer sequences and per-session clocks that advance one second per event.
 */
export class ReplayEventsV3 {
  private nextId = 100;
  private nextSessionIndex = 1;

  session(label: string): ReplaySessionV3 {
    const index = this.nextSessionIndex++;
    const hex = String(index).padStart(12, "0");
    return {
      label,
      instance_id: `inst_replay-${label}`,
      session_id: `sid_${String(index).repeat(64).slice(0, 64)}`,
      generation_id: `gen_00000000-0000-7000-8001-${hex}`,
      attestation_id: `att_00000000-0000-7000-8002-${hex}`,
      producer_id: `prd_replay-${label}`,
      boot_id: `boot_replay-${label}`,
      clock_id: `clk_00000000-0000-7000-8003-${hex}`,
      next_sequence: 1,
      next_ms: BASE_MS + index * 3_600_000,
    };
  }

  /** The session's first event, which mints its attestation. */
  start(session: ReplaySessionV3, options: ReplayEventOptionsV3 = {}): EventV3Fixture {
    return this.event(session, "session.started", {
      ...options,
      mutate: (event) => {
        const attestation = fixtureObject(fixtureObject(event.payload).runtime_attestation);
        attestation.attestation_id = session.attestation_id;
        attestation.generation_id = session.generation_id;
        attestation.declared_by_event_id = event.event_id;
        options.mutate?.(event);
      },
    });
  }

  /** A claim acquisition or release by the session itself, or by a sweeper on its behalf. */
  claim(
    session: ReplaySessionV3,
    operation: "acquired" | "released",
    options: ReplayEventOptionsV3 & { subject?: ReplaySessionV3 } = {},
  ): EventV3Fixture {
    return this.event(session, "coord.claim_changed", {
      ...options,
      mutate: (event) => {
        const payload = fixtureObject(event.payload);
        payload.operation = operation;
        payload.access = "write";
        fixtureObject(payload.target).access = "write";
        payload.actor_instance_id = session.instance_id;
        payload.subject_instance_id = (options.subject ?? session).instance_id;
        options.mutate?.(event);
      },
    });
  }

  /** Any event type, aligned to the session. */
  event(
    session: ReplaySessionV3,
    eventType: string,
    options: ReplayEventOptionsV3 = {},
  ): EventV3Fixture {
    const event = eventV3Fixture(eventType, this.nextId++);
    fixtureObject(event.contract).schema_digest = options.schema_digest ?? EVENT_V3_SCHEMA_DIGEST;
    const sequence = options.sequence ?? session.next_sequence;
    session.next_sequence = Math.max(session.next_sequence, sequence + 1);
    const producer = fixtureObject(event.producer);
    producer.producer_id = session.producer_id;
    producer.boot_id = session.boot_id;
    producer.sequence = sequence;
    const time = fixtureObject(event.time);
    const ms = session.next_ms;
    if (options.observed_at === undefined) session.next_ms += 1_000;
    time.clock_id = session.clock_id;
    time.observed_at = options.observed_at ?? new Date(ms).toISOString();
    time.recorded_at = time.observed_at;
    time.monotonic_ns = options.monotonic_ns ?? String(BigInt(ms) * 1_000_000n);
    time.skew = "normal";
    const scope = fixtureObject(event.scope);
    scope.instance_id = session.instance_id;
    if ("session_id" in scope) scope.session_id = session.session_id;
    if ("generation_id" in scope) scope.generation_id = session.generation_id;
    if ("attestation_id" in event) event.attestation_id = session.attestation_id;
    const payload = fixtureObject(event.payload);
    if ("actor_instance_id" in payload) payload.actor_instance_id = session.instance_id;
    if ("subject_instance_id" in payload) payload.subject_instance_id = session.instance_id;
    if (payload.authority && typeof payload.authority === "object") {
      const transaction = String(this.nextId).padStart(12, "0");
      fixtureObject(payload.authority).transaction_id =
        `txn_00000000-0000-7000-8004-${transaction}`;
    }
    fixtureObject(event.links).caused_by = [...(options.caused_by ?? [])];
    options.mutate?.(event);
    if (fixtureObject(event.contract).schema_digest === EVENT_V3_SCHEMA_DIGEST) {
      assertEventV3(event);
    }
    return event;
  }
}

export function asEventV3(event: EventV3Fixture): EventV3 {
  return event as unknown as EventV3;
}

/** Frames as the reader would see them in one segment, 1,000 bytes apart. */
export function framesV3(events: readonly EventV3Fixture[], segmentOrdinal = 1): LedgerFrameV3[] {
  return events.map((event, index) => ({
    raw: canonicalJsonV3(event),
    position: { segment_ordinal: segmentOrdinal, byte_offset: index * 1_000 },
  }));
}

/** A genesis row whose recorded schema is the given digest. */
export function genesisForDigestV3(digest: string, genesisId?: string): EventV3Fixture {
  const genesis = eventV3Fixture("ledger.genesis", 1);
  fixtureObject(genesis.contract).schema_digest = digest;
  const payload = fixtureObject(genesis.payload);
  payload.generated_schema_digest = digest;
  if (genesisId) payload.genesis_id = genesisId;
  return genesis;
}

// ---------------------------------------------------------------------------
// Spool
// ---------------------------------------------------------------------------

/** Place a canonical row in the queue the way a writer of any runtime names it. */
export function plantReadyRowV3(spool: string, event: EventV3Fixture): string {
  return plantSpoolFileV3(spool, event, "ready");
}

/** Place a receipt for a row a crashed writer had already appended. */
export function plantCommittedReceiptV3(spool: string, event: EventV3Fixture): string {
  return plantSpoolFileV3(spool, event, "committed");
}

/** Place a queued file or receipt whose bytes are not an event. */
export function plantUnreadableSpoolFileV3(
  spool: string,
  kind: "ready" | "committed",
  name = "unreadable",
): string {
  const path = join(
    spool,
    `${"9".repeat(16)}-evt_00000000-0000-7000-8000-${name.padEnd(12, "0").slice(0, 12)}-${"0".repeat(64)}.${kind}`,
  );
  writeFileSync(path, "{not an event\n", { mode: stateFileMode() });
  return path;
}

export function spoolNamesV3(spool: string, suffix: ".ready" | ".committed"): string[] {
  return readdirSync(spool)
    .filter((name) => name.endsWith(suffix))
    .sort();
}

function plantSpoolFileV3(spool: string, event: EventV3Fixture, kind: "ready" | "committed") {
  const row = `${canonicalJsonV3(event)}\n`;
  const sequence = String(fixtureObject(event.producer).sequence).padStart(16, "0");
  const name = `${sequence}-${event.event_id as string}-${sha256V3(row).slice(7)}.${kind}`;
  const path = join(spool, name);
  writeFileSync(path, row, { mode: stateFileMode() });
  return path;
}

// ---------------------------------------------------------------------------
// (a) and (e): schema digests
// ---------------------------------------------------------------------------

/** The two newest digests of the runtime's additive group, oldest first. */
export function adjacentAdditiveDigestsV3(): { older: ReplayDigestV3; newer: ReplayDigestV3 } {
  const group = EVENT_V3_SCHEMA_LINEAGE.groups.at(-1) ?? [];
  if (group.length < 2) throw new Error("runtime additive group holds fewer than two digests");
  return { older: group.at(-2)!, newer: group.at(-1)! };
}

/** The newest digest of the group before the runtime's, separated by a breaking change. */
export function priorBreakingDigestV3(): ReplayDigestV3 {
  const group = EVENT_V3_SCHEMA_LINEAGE.groups.at(-2);
  if (!group?.length) throw new Error("lineage has no group before the runtime's");
  return group.at(-1)!;
}

/**
 * (a) Two runtimes on adjacent digests of one additive group taking turns on
 * one root: each turn is the digest of the runtime that opens the ledger.
 */
export function alternatingDigestTurnsV3(turns = 4): ReplayDigestV3[] {
  const { older, newer } = adjacentAdditiveDigestsV3();
  return Array.from({ length: turns }, (_, index) => (index % 2 === 0 ? newer : older));
}

/**
 * (e) An epoch begun on the older digest of the runtime's group whose later
 * rows carry the newer one, with no advance event between them.
 */
export function mixedAdditiveEpochV3(events = new ReplayEventsV3()): {
  genesis_digest: ReplayDigestV3;
  present_digests: ReplayDigestV3[];
  rows: EventV3Fixture[];
} {
  const { older, newer } = adjacentAdditiveDigestsV3();
  const genesis = genesisForDigestV3(older);
  const session = events.session("mixed");
  const start = events.start(session, { schema_digest: older });
  const task = events.event(session, "coord.task_changed", { schema_digest: newer });
  return { genesis_digest: older, present_digests: [older, newer], rows: [genesis, start, task] };
}

/** (e) An epoch whose genesis carries a digest outside the runtime's lineage. */
export function unknownDigestEpochV3(events = new ReplayEventsV3()): {
  genesis_digest: ReplayDigestV3;
  rows: EventV3Fixture[];
} {
  const genesis = genesisForDigestV3(UNKNOWN_SCHEMA_DIGEST_V3);
  const session = events.session("unknown");
  const start = events.start(session, { schema_digest: UNKNOWN_SCHEMA_DIGEST_V3 });
  return { genesis_digest: UNKNOWN_SCHEMA_DIGEST_V3, rows: [genesis, start] };
}

/** (e) A row for an active runtime epoch stamped by a runtime with an unknown schema. */
export function unknownDigestQueuedRowV3(
  events: ReplayEventsV3,
  session: ReplaySessionV3,
): EventV3Fixture {
  return events.event(session, "coord.task_changed", { schema_digest: UNKNOWN_SCHEMA_DIGEST_V3 });
}

// ---------------------------------------------------------------------------
// (b): one session's sequence gap while another holds a claim
// ---------------------------------------------------------------------------

export interface SequenceGapScenarioV3 {
  events: ReplayEventsV3;
  x: ReplaySessionV3;
  y: ReplaySessionV3;
  /** Rows both sessions have committed before the gap: starts and Y's claim. */
  committed: EventV3Fixture[];
  /** Y's claim acquisition, inside `committed`. */
  y_claim: EventV3Fixture;
  /** X's row queued after a skipped producer sequence. */
  x_waiting: EventV3Fixture;
  /** The row X skipped; absent from every queue. */
  x_missing: EventV3Fixture;
  /** Y's next coordination change, written after X's row is queued. */
  y_task: EventV3Fixture;
}

/** (b) X's queued row skips a producer sequence while Y holds a claim. */
export function sequenceGapScenarioV3(events = new ReplayEventsV3()): SequenceGapScenarioV3 {
  const x = events.session("x");
  const y = events.session("y");
  const xStart = events.start(x);
  const yStart = events.start(y);
  const yClaim = events.claim(y, "acquired", { caused_by: [yStart.event_id as string] });
  const xMissing = events.event(x, "coord.task_changed", {
    caused_by: [xStart.event_id as string],
  });
  const xWaiting = events.event(x, "coord.task_changed", {
    caused_by: [xStart.event_id as string],
  });
  const yTask = events.event(y, "coord.task_changed", { caused_by: [yClaim.event_id as string] });
  return {
    events,
    x,
    y,
    committed: [xStart, yStart, yClaim],
    y_claim: yClaim,
    x_waiting: xWaiting,
    x_missing: xMissing,
    y_task: yTask,
  };
}

export interface WaitingClaimScenarioV3 extends SequenceGapScenarioV3 {
  /** X's claim acquisition queued after the skipped sequence. */
  x_claim_waiting: EventV3Fixture;
  /** A sweeper's release of X's claim, emitted on X's behalf. */
  sweep_release: EventV3Fixture;
  sweeper: ReplaySessionV3;
}

/**
 * (b, variant) X's waiting row is a claim acquisition, and a stale sweep later
 * releases that claim on X's behalf while the acquisition is still queued.
 */
export function waitingClaimSweepScenarioV3(events = new ReplayEventsV3()): WaitingClaimScenarioV3 {
  const base = sequenceGapScenarioV3(events);
  const xClaimWaiting = events.claim(base.x, "acquired", {
    caused_by: [base.committed[0]!.event_id as string],
  });
  const sweeper = events.session("sweeper");
  const sweepRelease = events.claim(sweeper, "released", {
    subject: base.x,
    caused_by: [xClaimWaiting.event_id as string],
  });
  return { ...base, x_claim_waiting: xClaimWaiting, sweep_release: sweepRelease, sweeper };
}

// ---------------------------------------------------------------------------
// (c): rows the reader would reject, and files that cannot be read
// ---------------------------------------------------------------------------

export interface RejectableRowsScenarioV3 {
  events: ReplayEventsV3;
  session: ReplaySessionV3;
  /** The session's start, committed first. */
  start: EventV3Fixture;
  /** A row on the session's clock observed before the start, with no regression mark. */
  clock_regressed: EventV3Fixture;
}

/** (c) A row whose wall clock and monotonic clock run backwards. */
export function clockRegressionScenarioV3(events = new ReplayEventsV3()): RejectableRowsScenarioV3 {
  const session = events.session("clock");
  const start = events.start(session);
  const startTime = fixtureObject(start.time);
  const earlier = new Date(Date.parse(startTime.observed_at as string) - 60_000);
  const clockRegressed = events.event(session, "coord.task_changed", {
    caused_by: [start.event_id as string],
    observed_at: earlier.toISOString(),
    monotonic_ns: String(BigInt(earlier.getTime()) * 1_000_000n),
  });
  return { events, session, start, clock_regressed: clockRegressed };
}

/** (c) A row queued before its producer predecessor, which arrives later. */
export function latePredecessorScenarioV3(events = new ReplayEventsV3()): {
  events: ReplayEventsV3;
  session: ReplaySessionV3;
  start: EventV3Fixture;
  predecessor: EventV3Fixture;
  successor: EventV3Fixture;
} {
  const session = events.session("late");
  const start = events.start(session);
  const predecessor = events.event(session, "coord.task_changed", {
    caused_by: [start.event_id as string],
  });
  const successor = events.event(session, "coord.task_changed", {
    caused_by: [start.event_id as string],
  });
  return { events, session, start, predecessor, successor };
}

/** (c) Two rows that name each other as causes, beside a row that depends on neither. */
export function causalCycleScenarioV3(events = new ReplayEventsV3()): {
  events: ReplayEventsV3;
  cycle: [EventV3Fixture, EventV3Fixture];
  admissible: EventV3Fixture;
  admissible_session: ReplaySessionV3;
} {
  const first = events.session("cycle-a");
  const second = events.session("cycle-b");
  const aStart = events.start(first);
  const bStart = events.start(second);
  aStart.links = { caused_by: [bStart.event_id as string] };
  bStart.links = { caused_by: [aStart.event_id as string] };
  const admissibleSession = events.session("admissible");
  const admissible = events.start(admissibleSession);
  return { events, cycle: [aStart, bStart], admissible, admissible_session: admissibleSession };
}
