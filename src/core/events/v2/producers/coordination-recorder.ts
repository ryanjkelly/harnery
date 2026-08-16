import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { Adapter } from "../../../hooks/events/schema.ts";
import { fsyncParentDirectory } from "../../../workflow/durable-record.ts";
import { acquireNoClobberLease } from "../../../workflow/workspaces/leases.ts";
import {
  type AuthorityReceiptV2,
  type AuthorityReconcilerV2,
  type AuthorityTransactionV2,
  buildAuthorityTransactionV2,
  publishAuthorityTransactionV2,
  reconcileAuthorityTransactionV2,
} from "../authority-outbox.ts";
import { canonicalJsonV2, normalizeNativeIdV2 } from "../canonical.ts";
import type { EventV2 } from "../contract.ts";
import { type EventV2WriteMode, readEventV2ControlState } from "../control.ts";
import { fingerprintContextV2 } from "../fingerprint-keys.ts";
import { clockIdV2 } from "../ids.ts";
import {
  type CoordinationAuthoritySignalV2,
  type CoordinationObservationBySignalV2,
  normalizeCoordinationAuthorityV2,
} from "./coordination.ts";
import { readHookProducerStateV2 } from "./recorder.ts";

const COORDINATION_STATE_FORMAT = "harnery-v2-coordination-producer" as const;
const COORDINATION_STATE_VERSION = 1 as const;
const MAX_OBSERVATIONS = 512;

interface RecordedCoordinationObservationV2 {
  source_id: `hid_${string}`;
  event_id: `evt_${string}`;
  transaction_id: `txn_${string}`;
}

interface PendingCoordinationTransactionV2 {
  source_id: `hid_${string}`;
  transaction: AuthorityTransactionV2;
}

interface CoordinationRecorderStateV2 {
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
  observations: RecordedCoordinationObservationV2[];
  pending?: PendingCoordinationTransactionV2;
}

export interface RecordCoordinationAuthorityV2Input<
  S extends CoordinationAuthoritySignalV2 = CoordinationAuthoritySignalV2,
> {
  coordRoot: string;
  mode: EventV2WriteMode;
  signal: S;
  observation: CoordinationObservationBySignalV2[S];
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
  reconciler: AuthorityReconcilerV2;
}

export type RecordCoordinationAuthorityV2Result =
  | { state: "gate_closed"; reason: string }
  | { state: "generation_unavailable"; reason: string }
  | { state: "already_recorded"; event_id: string; transaction_id: string }
  | { state: "pending_transaction"; transaction_id: string; mutation_kind: string }
  | {
      state: "recorded";
      event: EventV2;
      receipt: AuthorityReceiptV2;
      recovered: boolean;
    };

/**
 * Record and apply an authority-bearing coordination transition through the
 * spool-first outbox. It is inert until an exact V2 gate is open and refuses
 * to guess how to recover a different pending mutation.
 */
export function recordCoordinationAuthorityV2<S extends CoordinationAuthoritySignalV2>(
  input: RecordCoordinationAuthorityV2Input<S>,
): RecordCoordinationAuthorityV2Result {
  const control = readEventV2ControlState(input.coordRoot);
  if (control.state !== input.mode) return { state: "gate_closed", reason: control.state };
  const hook = readHookProducerStateV2(
    input.coordRoot,
    input.adapter,
    input.native_actor_session_id,
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
  const rootContext = fingerprintContextV2(input.coordRoot, rootId, undefined, epochId);
  const producerSource = normalizeNativeIdV2(
    rootContext,
    "agent-coord.producer",
    `${input.adapter}\0${input.native_actor_session_id}\0${hook.generation_id}`,
  );
  const sourceId = normalizeNativeIdV2(
    rootContext,
    "agent-coord.observation",
    input.observation.native_observation_id,
  );
  const path = coordinationStatePath(input.coordRoot, producerSource);
  const lease = acquireCoordinationLease(input.coordRoot, path);
  try {
    let state = existsSync(path) ? readCoordinationState(path) : undefined;
    if (state && !matchesHookState(state, hook, input, epochId)) {
      throw new Error("V2 coordination producer state does not match the joined hook generation");
    }
    if (state?.pending) {
      if (state.pending.source_id !== sourceId) {
        return {
          state: "pending_transaction",
          transaction_id: state.pending.transaction.transaction_id,
          mutation_kind: state.pending.transaction.mutation.kind,
        };
      }
      const pending = state.pending;
      publishAuthorityTransactionV2(input.coordRoot, pending.transaction);
      const receipt = reconcileAuthorityTransactionV2(
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
    const fingerprintContext = fingerprintContextV2(
      input.coordRoot,
      rootId,
      state.generation_id,
      state.privacy_epoch_id,
    );
    const normalized = normalizeCoordinationAuthorityV2(input.signal, input.observation, {
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
      caused_by: [state.last_event_id],
      monotonic_ns: input.monotonic_ns,
      clock_id: state.clock_id,
      fingerprintContext,
      attribution_method: "session_env",
    });
    const transaction = buildAuthorityTransactionV2({
      transaction_id: transactionId,
      expected_prior_state_digest: input.expected_prior_state_digest,
      desired_state_digest: input.desired_state_digest,
      actor_instance_id: state.actor_instance_id,
      subject_instance_id: input.subject_instance_id,
      mutation: normalized.mutation,
      event: normalized.event,
    });
    state.pending = { source_id: sourceId, transaction };
    publishCoordinationState(path, state);
    publishAuthorityTransactionV2(input.coordRoot, transaction);
    const receipt = reconcileAuthorityTransactionV2(
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

function newCoordinationState<S extends CoordinationAuthoritySignalV2>(
  input: RecordCoordinationAuthorityV2Input<S>,
  hook: NonNullable<ReturnType<typeof readHookProducerStateV2>>,
  epochId: `pep_${string}`,
): CoordinationRecorderStateV2 {
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
    clock_id: clockIdV2(),
    next_sequence: 1,
    last_event_id: hook.last_event_id!,
    observations: [],
  };
}

function matchesHookState<S extends CoordinationAuthoritySignalV2>(
  state: CoordinationRecorderStateV2,
  hook: NonNullable<ReturnType<typeof readHookProducerStateV2>>,
  input: RecordCoordinationAuthorityV2Input<S>,
  epochId: string,
): boolean {
  return (
    state.adapter === input.adapter &&
    state.actor_instance_id === input.actor_instance_id &&
    state.session_id === hook.session_id &&
    state.generation_id === hook.generation_id &&
    state.attestation_id === hook.attestation_id &&
    state.privacy_epoch_id === epochId &&
    state.producer_id === input.producer_id &&
    state.build_id === input.build_id &&
    state.platform === input.platform &&
    state.bridge === input.bridge
  );
}

function applyCoordinationEvent(
  state: CoordinationRecorderStateV2,
  sourceId: `hid_${string}`,
  transaction: AuthorityTransactionV2,
  event: EventV2,
): void {
  state.next_sequence += 1;
  state.last_event_id = event.event_id as `evt_${string}`;
  state.observations.push({
    source_id: sourceId,
    event_id: event.event_id as `evt_${string}`,
    transaction_id: transaction.transaction_id,
  });
  if (state.observations.length > MAX_OBSERVATIONS) state.observations.shift();
}

function eventFromTransaction(transaction: AuthorityTransactionV2): EventV2 {
  return JSON.parse(transaction.event_row) as EventV2;
}

function coordinationStatePath(coordRoot: string, producerSource: `hid_${string}`): string {
  return join(
    resolve(coordRoot),
    ".harnery/private/v2-producers/agent-coord",
    `${producerSource}.json`,
  );
}

function acquireCoordinationLease(coordRoot: string, statePath: string) {
  const directory = join(statePath, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(join(resolve(coordRoot), ".harnery/private"), 0o700);
  chmodSync(join(resolve(coordRoot), ".harnery/private/v2-producers"), 0o700);
  chmodSync(directory, 0o700);
  return acquireNoClobberLease({
    path: `${statePath}.lease`,
    scope: "event-v2-coordination-producer",
    authoritySha256: createHash("sha256")
      .update(resolve(coordRoot))
      .update("\0")
      .update(statePath)
      .digest("hex"),
    staleAfterMs: 5_000,
    validateStaleOwner: (owner) => owner.host === hostname() && !pidIsAlive(owner.pid),
  });
}

function publishCoordinationState(path: string, state: CoordinationRecorderStateV2): void {
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

function readCoordinationState(path: string): CoordinationRecorderStateV2 {
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error("V2 coordination state is not owner-only");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("V2 coordination state is unreadable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("V2 coordination state is invalid");
  }
  const state = parsed as CoordinationRecorderStateV2;
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
    "next_sequence",
    "observations",
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
    !Array.isArray(state.observations) ||
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
    throw new Error("V2 coordination state is invalid");
  }
  return state;
}

function validStoredTransaction(transaction: AuthorityTransactionV2): boolean {
  try {
    const event = eventFromTransaction(transaction);
    const rebuilt = buildAuthorityTransactionV2({
      transaction_id: transaction.transaction_id,
      expected_prior_state_digest: transaction.expected_prior_state_digest,
      desired_state_digest: transaction.desired_state_digest,
      actor_instance_id: transaction.actor_instance_id,
      subject_instance_id: transaction.subject_instance_id,
      mutation: transaction.mutation,
      event,
    });
    return canonicalJsonV2(rebuilt) === canonicalJsonV2(transaction);
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
