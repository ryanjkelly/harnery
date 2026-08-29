import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Adapter } from "../../../adapter.ts";
import { fsyncParentDirectory } from "../../../workflow/durable-record.ts";
import { acquireNoClobberLease } from "../../../workflow/workspaces/leases.ts";
import {
  type AuthorityReceiptV3,
  type AuthorityReconcilerV3,
  type AuthorityTransactionV3,
  authorityRecoveryIntentPathV3,
  buildAuthorityTransactionV3,
  publishAuthorityTransactionV3,
  reconcileAuthorityTransactionV3,
} from "../authority-outbox.ts";
import { canonicalJsonV3, normalizeNativeIdV3 } from "../canonical.ts";
import { markObservedClockRegressionV3 } from "../clock-order.ts";
import type { EventV3 } from "../contract.ts";
import { type EventV3WriteMode, readEventV3ControlState } from "../control.ts";
import { fingerprintContextV3 } from "../fingerprint-keys.ts";
import { clockIdV3, spanIdV3 } from "../ids.ts";
import { closeSpanStateV3, type OpenSpanStateV3, openSpanStateV3 } from "../span-state.ts";
import { EVENT_V3_LEDGER_RELATIVE_ROOT } from "../writer.ts";
import {
  type CoordinationAuthoritySignalV3,
  type CoordinationObservationBySignalV3,
  normalizeCoordinationAuthorityV3,
} from "./coordination.ts";
import { readJoinableHookProducerStateV3 } from "./recorder.ts";

const COORDINATION_STATE_FORMAT = "harnery-v3-coordination-producer" as const;
const COORDINATION_STATE_VERSION = 2 as const;
const MAX_OBSERVATIONS = 512;

interface RecordedCoordinationObservationV3 {
  source_id: `hid_${string}`;
  event_id: `evt_${string}`;
  transaction_id: `txn_${string}`;
}

interface PendingCoordinationTransactionV3 {
  source_id: `hid_${string}`;
  transaction: AuthorityTransactionV3;
}

interface CoordinationRecorderStateV3 {
  format: typeof COORDINATION_STATE_FORMAT;
  format_version: typeof COORDINATION_STATE_VERSION;
  adapter: Adapter;
  actor_instance_id: `inst_${string}`;
  session_id: `sid_${string}`;
  generation_id: `gen_${string}`;
  attestation_id: `att_${string}`;
  privacy_epoch_id: `pep_${string}`;
  producer_id: `prd_${string}`;
  boot_id: `boot_${string}`;
  build_id: `build_${string}`;
  platform: "linux" | "windows" | "macos" | "unknown";
  bridge?: "codex-wsl";
  clock_id: `clk_${string}`;
  next_sequence: number;
  last_event_id: `evt_${string}`;
  last_observed_at?: string;
  observations: RecordedCoordinationObservationV3[];
  open_waits: Record<string, OpenSpanStateV3>;
  pending?: PendingCoordinationTransactionV3;
}

export interface PendingCoordinationTransactionV3Location {
  producer_state_file: string;
  transaction: AuthorityTransactionV3;
}

export interface RecordCoordinationAuthorityV3Input<
  S extends CoordinationAuthoritySignalV3 = CoordinationAuthoritySignalV3,
> {
  coordRoot: string;
  mode: EventV3WriteMode;
  signal: S;
  observation: CoordinationObservationBySignalV3[S];
  adapter: Adapter;
  native_actor_session_id: string;
  actor_instance_id: `inst_${string}`;
  subject_instance_id: `inst_${string}`;
  producer_id: `prd_${string}`;
  build_id: `build_${string}`;
  platform: "linux" | "windows" | "macos" | "unknown";
  bridge?: "codex-wsl";
  expected_prior_state_digest: `sha256:${string}`;
  desired_state_digest: `sha256:${string}`;
  monotonic_ns?: string;
  observed_at?: string;
  reconciler: AuthorityReconcilerV3;
}

export type RecordCoordinationAuthorityV3Result =
  | { state: "gate_closed"; reason: string }
  | { state: "generation_unavailable"; reason: string }
  | { state: "already_recorded"; event_id: string; transaction_id: string }
  | { state: "pending_transaction"; transaction_id: string; mutation_kind: string }
  | {
      state: "recorded";
      event: EventV3;
      receipt: AuthorityReceiptV3;
      recovered: boolean;
    };

/**
 * Record and apply an authority-bearing coordination transition through the
 * spool-first outbox. It is inert until an exact V3 gate is open. A stale
 * pending transaction left by a crashed writer is completed when the
 * idempotent outbox can still settle it; a pending mutation that cannot be
 * settled is refused rather than guessed at.
 */
export function recordCoordinationAuthorityV3<S extends CoordinationAuthoritySignalV3>(
  input: RecordCoordinationAuthorityV3Input<S>,
): RecordCoordinationAuthorityV3Result {
  const control = readEventV3ControlState(input.coordRoot);
  if (control.state !== input.mode) return { state: "gate_closed", reason: control.state };
  const hook = readJoinableHookProducerStateV3(
    input.coordRoot,
    input.adapter,
    input.native_actor_session_id,
    input.actor_instance_id,
  );
  if (
    !hook ||
    hook.terminal ||
    hook.instance_id !== input.actor_instance_id ||
    !hook.last_event_id
  ) {
    return { state: "generation_unavailable", reason: "hook_generation_not_joinable" };
  }

  const rootId = control.genesis.event.scope.root_id as `root_${string}`;
  const epochId = control.genesis.profile.privacy_key_epoch;
  const rootContext = fingerprintContextV3(input.coordRoot, rootId, undefined, epochId);
  const producerSource = normalizeNativeIdV3(
    rootContext,
    "agent-coord.producer",
    `${input.adapter}\0${input.native_actor_session_id}\0${hook.generation_id}`,
  );
  const sourceId = normalizeNativeIdV3(
    rootContext,
    "agent-coord.observation",
    input.observation.native_observation_id,
  );
  const path = coordinationStatePath(input.coordRoot, producerSource);
  const lease = acquireCoordinationLease(input.coordRoot, path);
  try {
    let state = existsSync(path) ? readCoordinationState(path) : undefined;
    if (state && !matchesHookState(state, hook, input, epochId)) {
      throw new Error("V3 coordination producer state does not match the joined hook generation");
    }
    if (state && state.attestation_id !== hook.attestation_id) {
      // A mid-generation re-attestation (session.attestation_changed) moves
      // the hook's attestation id without opening a new generation. The
      // producer keeps its one continuous sequence, clock, and observation
      // dedupe for the generation and stamps later events with the live
      // attestation — the same in-place adoption the hook producer performs.
      // Refusing here would wedge the producer forever, since its state path
      // is derived from the generation alone and can never be superseded.
      state.attestation_id = hook.attestation_id;
    }
    if (state?.pending) {
      if (
        existsSync(
          authorityRecoveryIntentPathV3(input.coordRoot, state.pending.transaction.transaction_id),
        )
      ) {
        return {
          state: "pending_transaction",
          transaction_id: state.pending.transaction.transaction_id,
          mutation_kind: state.pending.transaction.mutation.kind,
        };
      }
      if (state.pending.source_id !== sourceId) {
        // A writer that died mid-commit leaves `pending` owned by an
        // observation that will never retry (hook observations are one-shot).
        // When the stale transaction can still be settled through the
        // idempotent outbox — its receipt already exists, or its ready record
        // reconciles cleanly — nothing is guessed: complete the bookkeeping
        // and continue with the current observation. Anything short of that
        // still refuses rather than guessing at a conflicting mutation.
        const stale = state.pending;
        try {
          publishAuthorityTransactionV3(input.coordRoot, stale.transaction);
          reconcileAuthorityTransactionV3(
            input.coordRoot,
            stale.transaction.transaction_id,
            input.reconciler,
          );
        } catch {
          return {
            state: "pending_transaction",
            transaction_id: stale.transaction.transaction_id,
            mutation_kind: stale.transaction.mutation.kind,
          };
        }
        applyCoordinationEvent(
          state,
          stale.source_id,
          stale.transaction,
          eventFromTransaction(stale.transaction),
        );
        state.pending = undefined;
        publishCoordinationState(path, state);
      } else {
        const pending = state.pending;
        publishAuthorityTransactionV3(input.coordRoot, pending.transaction);
        const receipt = reconcileAuthorityTransactionV3(
          input.coordRoot,
          pending.transaction.transaction_id,
          input.reconciler,
        );
        const event = eventFromTransaction(pending.transaction);
        applyCoordinationEvent(state, pending.source_id, pending.transaction, event);
        state.pending = undefined;
        publishCoordinationState(path, state);
        return { state: "recorded", event, receipt, recovered: true };
      }
    }
    const already = state?.observations.find((observation) => observation.source_id === sourceId);
    if (already) {
      return {
        state: "already_recorded",
        event_id: already.event_id,
        transaction_id: already.transaction_id,
      };
    }
    if (!state) state = newCoordinationState(input, hook, epochId);

    const transactionId = `txn_${randomUUID()}` as const;
    const fingerprintContext = fingerprintContextV3(
      input.coordRoot,
      rootId,
      state.generation_id,
      state.privacy_epoch_id,
    );
    const waitId =
      (input.signal === "wait-started" || input.signal === "wait-ended") &&
      "wait_id" in input.observation
        ? input.observation.wait_id
        : undefined;
    let waitSpan = waitId ? state.open_waits[waitId] : undefined;
    if (input.signal === "wait-started" && waitId && !waitSpan) {
      waitSpan = openSpanStateV3({
        span_id: spanIdV3(),
        parent_span_id: hook.current_turn_span?.span_id ?? hook.session_span.span_id,
        boot_id: state.boot_id,
        clock: {
          observed_at: input.observed_at ?? new Date().toISOString(),
          ...(input.monotonic_ns ? { monotonic_ns: input.monotonic_ns } : {}),
        },
      });
      state.open_waits[waitId] = waitSpan;
    }
    if (input.signal === "wait-ended" && !waitSpan) {
      return { state: "generation_unavailable", reason: "wait_span_not_started" };
    }
    const normalized = normalizeCoordinationAuthorityV3(input.signal, input.observation, {
      coordRoot: input.coordRoot,
      root_id: rootId,
      instance_id: state.actor_instance_id,
      session_id: state.session_id,
      generation_id: state.generation_id,
      attestation_id: state.attestation_id,
      producer_id: state.producer_id,
      boot_id: state.boot_id,
      sequence: state.next_sequence,
      build_id: state.build_id,
      platform: state.platform,
      bridge: state.bridge,
      actor_instance_id: state.actor_instance_id,
      subject_instance_id: input.subject_instance_id,
      transaction_id: transactionId,
      caused_by: [
        state.last_event_id,
        ...(input.signal === "wait-ended" && waitSpan?.open_event_id
          ? [waitSpan.open_event_id]
          : []),
      ].filter((value, index, values) => values.indexOf(value) === index),
      observed_at: input.observed_at,
      monotonic_ns: input.monotonic_ns,
      clock_id: state.clock_id,
      span_id: waitSpan?.span_id,
      parent_span_id: waitSpan?.parent_span_id,
      terminal_span:
        input.signal === "wait-ended" && waitSpan
          ? closeSpanStateV3(waitSpan, {
              boot_id: state.boot_id,
              clock: {
                observed_at: input.observed_at ?? new Date().toISOString(),
                ...(input.monotonic_ns ? { monotonic_ns: input.monotonic_ns } : {}),
              },
            })
          : undefined,
      fingerprintContext,
      attribution_method: "session_env",
    });
    markObservedClockRegressionV3(normalized.event, state.last_observed_at);
    const transaction = buildAuthorityTransactionV3({
      transaction_id: transactionId,
      expected_prior_state_digest: input.expected_prior_state_digest,
      desired_state_digest: input.desired_state_digest,
      actor_instance_id: state.actor_instance_id,
      subject_instance_id: input.subject_instance_id,
      mutation: normalized.mutation,
      event: normalized.event,
    });
    if (input.signal === "wait-ended" && waitId) delete state.open_waits[waitId];
    state.pending = { source_id: sourceId, transaction };
    publishCoordinationState(path, state);
    publishAuthorityTransactionV3(input.coordRoot, transaction);
    const receipt = reconcileAuthorityTransactionV3(
      input.coordRoot,
      transaction.transaction_id,
      input.reconciler,
    );
    applyCoordinationEvent(state, sourceId, transaction, normalized.event);
    state.pending = undefined;
    publishCoordinationState(path, state);
    return { state: "recorded", event: normalized.event, receipt, recovered: false };
  } finally {
    lease.release();
  }
}

/** Locate the one private producer state that owns a pending authority transaction. */
export function findPendingCoordinationTransactionV3(
  coordRoot: string,
  transactionId: string,
): PendingCoordinationTransactionV3Location | null {
  const directory = coordinationProducerDirectory(coordRoot);
  if (!existsSync(directory)) return null;
  const matches = readdirSync(directory)
    .filter((name) => /^hid_[a-f0-9]{64}\.json$/.test(name))
    .sort()
    .flatMap((name) => {
      const state = readCoordinationState(join(directory, name));
      return state.pending?.transaction.transaction_id === transactionId
        ? [{ producer_state_file: name, transaction: state.pending.transaction }]
        : [];
    });
  if (matches.length > 1) {
    throw new Error("authority transaction is pending in more than one coordination producer");
  }
  return matches[0] ?? null;
}

/** Clear one transaction from its exact producer state after durable quarantine is established. */
export function withPendingCoordinationTransactionRecoveryV3<T>(
  coordRoot: string,
  producerStateFile: string,
  transaction: AuthorityTransactionV3,
  allowAlreadyCleared: boolean,
  operation: (control: { clearPending: () => "cleared" | "already_cleared" }) => T,
): T {
  if (!/^hid_[a-f0-9]{64}\.json$/.test(producerStateFile)) {
    throw new Error("coordination producer state file is invalid");
  }
  const path = join(coordinationProducerDirectory(coordRoot), basename(producerStateFile));
  if (!existsSync(path)) throw new Error("coordination producer state is missing");
  const lease = acquireCoordinationLease(coordRoot, path);
  try {
    const state = readCoordinationState(path);
    if (!state.pending && !allowAlreadyCleared) {
      throw new Error("coordination producer no longer owns the pending transaction");
    }
    if (state.pending) {
      if (
        state.pending.transaction.transaction_id !== transaction.transaction_id ||
        canonicalJsonV3(state.pending.transaction) !== canonicalJsonV3(transaction)
      ) {
        throw new Error("coordination producer pending transaction changed during recovery");
      }
    }
    return operation({
      clearPending: () => {
        if (!state.pending) return "already_cleared";
        state.pending = undefined;
        publishCoordinationState(path, state);
        return "cleared";
      },
    });
  } finally {
    lease.release();
  }
}

function newCoordinationState<S extends CoordinationAuthoritySignalV3>(
  input: RecordCoordinationAuthorityV3Input<S>,
  hook: NonNullable<ReturnType<typeof readJoinableHookProducerStateV3>>,
  epochId: `pep_${string}`,
): CoordinationRecorderStateV3 {
  return {
    format: COORDINATION_STATE_FORMAT,
    format_version: COORDINATION_STATE_VERSION,
    adapter: input.adapter,
    actor_instance_id: input.actor_instance_id,
    session_id: hook.session_id,
    generation_id: hook.generation_id,
    attestation_id: hook.attestation_id,
    privacy_epoch_id: epochId,
    producer_id: input.producer_id,
    boot_id: `boot_${randomUUID()}`,
    build_id: input.build_id,
    platform: input.platform,
    bridge: input.bridge,
    clock_id: clockIdV3(),
    next_sequence: 1,
    last_event_id: hook.last_event_id!,
    observations: [],
    open_waits: {},
  };
}

function matchesHookState<S extends CoordinationAuthoritySignalV3>(
  state: CoordinationRecorderStateV3,
  hook: NonNullable<ReturnType<typeof readJoinableHookProducerStateV3>>,
  input: RecordCoordinationAuthorityV3Input<S>,
  epochId: string,
): boolean {
  return (
    state.adapter === input.adapter &&
    state.actor_instance_id === input.actor_instance_id &&
    state.session_id === hook.session_id &&
    state.generation_id === hook.generation_id &&
    // attestation_id is deliberately absent: a re-attestation within the
    // generation is a continuation, adopted by the caller, not a mismatch.
    state.privacy_epoch_id === epochId &&
    state.producer_id === input.producer_id &&
    state.build_id === input.build_id &&
    state.platform === input.platform &&
    state.bridge === input.bridge
  );
}

function applyCoordinationEvent(
  state: CoordinationRecorderStateV3,
  sourceId: `hid_${string}`,
  transaction: AuthorityTransactionV3,
  event: EventV3,
): void {
  state.next_sequence += 1;
  state.last_event_id = event.event_id as `evt_${string}`;
  state.last_observed_at = event.time.observed_at;
  state.observations.push({
    source_id: sourceId,
    event_id: event.event_id as `evt_${string}`,
    transaction_id: transaction.transaction_id,
  });
  if (state.observations.length > MAX_OBSERVATIONS) state.observations.shift();
}

function eventFromTransaction(transaction: AuthorityTransactionV3): EventV3 {
  return JSON.parse(transaction.event_row) as EventV3;
}

function coordinationStatePath(coordRoot: string, producerSource: `hid_${string}`): string {
  return join(coordinationProducerDirectory(coordRoot), `${producerSource}.json`);
}

function coordinationProducerDirectory(coordRoot: string): string {
  return join(resolve(coordRoot), EVENT_V3_LEDGER_RELATIVE_ROOT, "private-producers/agent-coord");
}

function acquireCoordinationLease(coordRoot: string, statePath: string) {
  const directory = join(statePath, "..");
  const producerRoot = join(resolve(coordRoot), EVENT_V3_LEDGER_RELATIVE_ROOT, "private-producers");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(producerRoot, 0o700);
  chmodSync(directory, 0o700);
  return acquireNoClobberLease({
    path: `${statePath}.lease`,
    scope: "event-v3-coordination-producer",
    authoritySha256: createHash("sha256")
      .update(resolve(coordRoot))
      .update("\0")
      .update(statePath)
      .digest("hex"),
    staleAfterMs: 5_000,
    validateStaleOwner: (owner) => owner.host === hostname() && !pidIsAlive(owner.pid),
  });
}

function publishCoordinationState(path: string, state: CoordinationRecorderStateV3): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(state)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncParentDirectory(path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readCoordinationState(path: string): CoordinationRecorderStateV3 {
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error("V3 coordination state is not owner-only");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("V3 coordination state is unreadable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("V3 coordination state is invalid");
  }
  const state = parsed as CoordinationRecorderStateV3;
  const allowed = new Set([
    "actor_instance_id",
    "adapter",
    "attestation_id",
    "boot_id",
    "bridge",
    "build_id",
    "clock_id",
    "format",
    "format_version",
    "generation_id",
    "last_event_id",
    "last_observed_at",
    "next_sequence",
    "observations",
    "open_waits",
    "pending",
    "platform",
    "privacy_epoch_id",
    "producer_id",
    "session_id",
  ]);
  if (
    Object.keys(state).some((key) => !allowed.has(key)) ||
    state.format !== COORDINATION_STATE_FORMAT ||
    state.format_version !== COORDINATION_STATE_VERSION ||
    !["claude-code", "codex", "cursor"].includes(state.adapter) ||
    !/^inst_[a-zA-Z0-9._-]{1,128}$/.test(state.actor_instance_id) ||
    !/^sid_[a-f0-9]{64}$/.test(state.session_id) ||
    !/^gen_[0-9a-f-]{36}$/.test(state.generation_id) ||
    !/^att_[0-9a-f-]{36}$/.test(state.attestation_id) ||
    !/^pep_[a-zA-Z0-9._-]+$/.test(state.privacy_epoch_id) ||
    !/^prd_[a-zA-Z0-9._-]+$/.test(state.producer_id) ||
    !/^boot_[a-zA-Z0-9._-]+$/.test(state.boot_id) ||
    !/^build_[a-zA-Z0-9._-]+$/.test(state.build_id) ||
    !["linux", "windows", "macos", "unknown"].includes(state.platform) ||
    (state.bridge !== undefined && state.bridge !== "codex-wsl") ||
    !/^clk_[0-9a-f-]{36}$/.test(state.clock_id) ||
    !/^evt_[0-9a-f-]{36}$/.test(state.last_event_id) ||
    (state.last_observed_at !== undefined &&
      !Number.isFinite(Date.parse(state.last_observed_at))) ||
    !Array.isArray(state.observations) ||
    !state.open_waits ||
    typeof state.open_waits !== "object" ||
    Array.isArray(state.open_waits) ||
    Object.entries(state.open_waits).some(
      ([waitId, span]) =>
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(waitId) ||
        !/^span_[0-9a-f-]{36}$/.test(span.span_id) ||
        !Number.isFinite(Date.parse(span.opened_at)) ||
        !/^boot_[a-zA-Z0-9._-]+$/.test(span.boot_id),
    ) ||
    state.observations.length > MAX_OBSERVATIONS ||
    state.observations.some(
      (observation) =>
        !/^hid_[a-f0-9]{64}$/.test(observation.source_id) ||
        !/^evt_[0-9a-f-]{36}$/.test(observation.event_id) ||
        !/^txn_[0-9a-f-]{36}$/.test(observation.transaction_id),
    ) ||
    !Number.isSafeInteger(state.next_sequence) ||
    state.next_sequence < 1 ||
    (state.pending !== undefined &&
      (!/^hid_[a-f0-9]{64}$/.test(state.pending.source_id) ||
        !validStoredTransaction(state.pending.transaction)))
  ) {
    throw new Error("V3 coordination state is invalid");
  }
  return state;
}

function validStoredTransaction(transaction: AuthorityTransactionV3): boolean {
  try {
    const event = eventFromTransaction(transaction);
    const rebuilt = buildAuthorityTransactionV3({
      transaction_id: transaction.transaction_id,
      expected_prior_state_digest: transaction.expected_prior_state_digest,
      desired_state_digest: transaction.desired_state_digest,
      actor_instance_id: transaction.actor_instance_id,
      subject_instance_id: transaction.subject_instance_id,
      mutation: transaction.mutation,
      event,
    });
    return canonicalJsonV3(rebuilt) === canonicalJsonV3(transaction);
  } catch {
    return false;
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
