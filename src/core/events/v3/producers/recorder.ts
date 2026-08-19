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
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Adapter } from "../../../adapter.ts";
import { extractBashCommand, type ParsedPayload } from "../../../hooks/adapter/parse.ts";
import { fsyncParentDirectory } from "../../../workflow/durable-record.ts";
import { acquireNoClobberLease } from "../../../workflow/workspaces/leases.ts";
import { buildEventV3 } from "../builder.ts";
import { normalizeNativeIdV3 } from "../canonical.ts";
import {
  type AdapterSignalV3,
  adapterCapabilityProfileDigestV3,
  adapterSignalSupportV3,
} from "../capabilities.ts";
import { capabilityDriftPayloadsV3 } from "../capability-drift.ts";
import type { EventV3 } from "../contract.ts";
import { type EventV3WriteMode, readEventV3ControlState } from "../control.ts";
import { fingerprintContextV3 } from "../fingerprint-keys.ts";
import { attestationIdV3, clockIdV3, delegationIdV3, generationIdV3, spanIdV3 } from "../ids.ts";
import { readLedgerV3 } from "../reader.ts";
import {
  closeSpanStateV3,
  type OpenSpanStateV3,
  openSpanStateV3,
  type SpanClockV3,
} from "../span-state.ts";
import { type ContextMeasurementV3, extractTurnTelemetryV3 } from "../turn-telemetry.ts";
import { assertEventV3, validateEventV3 } from "../validate.ts";
import {
  EVENT_V3_LEDGER_RELATIVE_ROOT,
  type WriteEventV3Options,
  type WriteEventV3Result,
  writeEventV3,
} from "../writer.ts";
import { type HookSignalV3, normalizeHookEventV3 } from "./hook.ts";
import type { TurnRitualEvidenceV3 } from "./hook-base.ts";
import {
  appendHookIntakeRecordV3,
  type HookIntakeRecordV3,
  hookIntakeGroupDirV3,
  listHookIntakeGroupsV3,
  listHookIntakeRecordsV3,
  removeIntakeRecordV3,
  writeProducerDiagnosticV3,
} from "./intake.ts";

const STATE_FORMAT = "harnery-v3-hook-producer" as const;
const STATE_VERSION = 3 as const;

/** ADR 0078 recovery policy constants. */
const CLOSED_SPAN_TURN_RETENTION = 2;
const CLOSED_SPAN_MEMORY_CAP = 512;
const SPAN_SOFT_WATERMARK = 128;
/**
 * Adapters whose turn-boundary recovery and mid-flight onboarding are enabled.
 * Kept in code, outside the digested capability profiles, so tuning recovery
 * never changes an adapter capability digest (ADR 0078).
 */
const RECOVERY_ENABLED_ADAPTERS: ReadonlySet<Adapter> = new Set(["claude-code", "codex", "cursor"]);

interface SpanStateV3 extends OpenSpanStateV3 {
  source_id: `hid_${string}`;
  semantic_key?: `hid_${string}`;
  recovery_reason?: string;
  turn_id?: `tid_${string}`;
  turn_stamp?: "native_payload" | "producer_state";
  requested_event_id?: `evt_${string}`;
  tool_name?: string;
}

interface ClosedSpanV3 {
  source_id: `hid_${string}`;
  semantic_key?: `hid_${string}`;
  span_id: `span_${string}`;
  closed_event_id: `evt_${string}`;
  turn_ordinal: number;
}

interface OpenWaitV3 extends OpenSpanStateV3 {
  wait_id: `hid_${string}`;
  started_event_id: `evt_${string}`;
  turn_id: `tid_${string}`;
}

interface TurnHarnessTimingV3 {
  hook_time_ms: number;
  hook_count: number;
  slowest_hook?: string;
  slowest_hook_ms: number;
}

interface PendingEventV3 {
  source_id?: `hid_${string}`;
  event: EventV3;
}

interface DelegationStateV3 extends OpenSpanStateV3 {
  source_id: `hid_${string}`;
  delegation_id: `del_${string}`;
  child_generation_id: `gen_${string}`;
  role: string;
}

export interface HookProducerStateV3 {
  format: typeof STATE_FORMAT;
  format_version: typeof STATE_VERSION;
  adapter: Adapter;
  instance_id: `inst_${string}`;
  session_id: `sid_${string}`;
  generation_id: `gen_${string}`;
  attestation_id: `att_${string}`;
  capability_profile: `cap_${string}`;
  privacy_epoch_id: `pep_${string}`;
  boot_id: `boot_${string}`;
  clock_id: `clk_${string}`;
  next_sequence: number;
  current_turn_id?: `tid_${string}`;
  tool_call_count: number;
  tool_call_count_turn_id?: `tid_${string}`;
  last_event_id?: `evt_${string}`;
  last_monotonic_ns?: string;
  started_event_id?: `evt_${string}`;
  session_span: OpenSpanStateV3;
  current_turn_span?: OpenSpanStateV3;
  terminal: boolean;
  spans: SpanStateV3[];
  delegations: DelegationStateV3[];
  closed_spans: ClosedSpanV3[];
  waits: OpenWaitV3[];
  turn_harness: TurnHarnessTimingV3;
  turn_ordinal: number;
  pending?: PendingEventV3;
}

export interface RecordHookSignalV3Input {
  coordRoot: string;
  mode: EventV3WriteMode;
  signal: HookSignalV3;
  payload: ParsedPayload;
  adapter: Adapter;
  instance_id: `inst_${string}`;
  run_id?: `run_${string}`;
  workflow_id?: `wf_${string}`;
  workflow_agent_id?: string;
  producer_id: `prd_${string}`;
  build_id: `build_${string}`;
  platform: "linux" | "windows" | "macos" | "unknown";
  bridge?: "codex-wsl";
  adapterVersion?: string;
  harnessVersion?: string;
  monotonic_ns?: string;
  observed_at?: string;
  hook_name?: string;
  hook_duration_ms?: number;
  stop_remediation?: boolean;
  turn_ritual?: TurnRitualEvidenceV3;
  writerOptions?: WriteEventV3Options;
}

export type RecordHookSignalV3Result =
  | { state: "gate_closed"; reason: string }
  | { state: "missing_session_start" }
  | { state: "already_started"; event_id: string }
  | { state: "unpairable_tool"; reason: "missing_tool_use_id" | "no_open_span" }
  /** A late signal for a span already closed in memory; preserved in diagnostics, never re-opened. */
  | { state: "suppressed"; reason: "closed_span" }
  | { state: "ignored" }
  /** Durably queued in the intake spool; a lease holder or drain hook records it. */
  | { state: "spooled" }
  | { state: "recorded"; event: EventV3; durability: WriteEventV3Result; recovered: boolean };

export type ApprovedSessionEndReasonV3 =
  | "approved_explicit_end"
  | "approved_verified_archive"
  | "policy_idle_timeout"
  | "policy_parent_terminal"
  | "policy_stale_sweep"
  | "policy_agent_completed"
  | "policy_run_completed"
  | "policy_superseded"
  | "policy_host_disappeared";

export interface HookProducerStateRecordV3 {
  path: string;
  modified_at_ms: number;
  state: HookProducerStateV3;
}

export interface RecordApprovedSessionEndV3Input {
  coordRoot: string;
  mode: EventV3WriteMode;
  instance_id: `inst_${string}`;
  generation_id: `gen_${string}`;
  build_id: `build_${string}`;
  platform: "linux" | "windows" | "macos" | "unknown";
  reason: ApprovedSessionEndReasonV3;
  outcome:
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "denied"
    | "interrupted"
    | "unknown";
  observed_at?: string;
  caused_by_event_id?: `evt_${string}`;
  coordination_finalized?: boolean;
  confidence?: "exact" | "high" | "medium" | "low";
  writerOptions?: WriteEventV3Options;
}

export type RecordApprovedSessionEndV3Result =
  | { state: "gate_closed"; reason: string }
  | { state: "generation_unavailable"; reason: string }
  | { state: "already_ended"; event_id?: `evt_${string}` }
  | { state: "recorded"; event: EventV3; durability: WriteEventV3Result; recovered: boolean };

type OpenHookControlStateV3 = Extract<
  ReturnType<typeof readEventV3ControlState>,
  { state: "candidate" } | { state: "active" }
>;

const STATE_LEASE_RETRY_ATTEMPTS = 8;
const STATE_LEASE_RETRY_DELAY_MS = 25;

/**
 * Record one hook signal through a private, crash-recoverable producer state file.
 * The function is inert unless the exact requested candidate or active gate is open.
 *
 * Delivery guarantee: the parsed signal is appended to a durable intake spool
 * BEFORE any producer state is read or validated, so a lost lease, a crash, or
 * a state-format mismatch never destroys a delivered signal. Whichever process
 * holds the session's state lease drains the spool in append order and rescans
 * until an empty pass; reconcile and session-start hooks drain any group whose
 * final appender never got the lease.
 */
export function recordHookSignalV3(input: RecordHookSignalV3Input): RecordHookSignalV3Result {
  const control = readEventV3ControlState(input.coordRoot);
  if (control.state !== input.mode) {
    return { state: "gate_closed", reason: control.state };
  }
  const gate = hookSignalGate(control, input.adapter, input.signal);
  if (gate) return gate;
  const rootId = control.genesis.event.scope.root_id as `root_${string}`;
  const epochId = control.genesis.profile.privacy_key_epoch;
  const rootFingerprintContext = fingerprintContextV3(input.coordRoot, rootId, undefined, epochId);
  const sessionHash = sessionHashForSignal(input, rootFingerprintContext);
  const path = producerStatePath(input.coordRoot, input.adapter, sessionHash);
  const spoolPath = appendHookIntakeRecordV3(input.coordRoot, sessionHash, intakeRecord(input));
  const lease = acquireStateLeaseWithRetry(input.coordRoot, path, STATE_LEASE_RETRY_ATTEMPTS);
  if (!lease) return { state: "spooled" };
  try {
    return (
      drainSessionIntakeLocked(input.coordRoot, control, input.adapter, sessionHash, path, {
        path: spoolPath,
        input,
      }) ?? { state: "spooled" }
    );
  } finally {
    lease.release();
  }
}

function hookSignalGate(
  control: OpenHookControlStateV3,
  adapter: Adapter,
  signal: HookSignalV3,
): RecordHookSignalV3Result | undefined {
  const expectedCapabilityDigest = `sha256:${adapterCapabilityProfileDigestV3(adapter).slice(4)}`;
  if (
    !control.genesis.profile.adapter_capability_profile_digests.includes(expectedCapabilityDigest)
  ) {
    return { state: "gate_closed", reason: "capability_profile_not_approved" };
  }
  const requiredCapability = hookSignalCapability(signal);
  if (adapterSignalSupportV3(adapter, requiredCapability) === "unsupported") {
    return {
      state: "gate_closed",
      reason: `signal_not_approved:${requiredCapability}`,
    };
  }
  return undefined;
}

function sessionHashForSignal(
  input: Pick<RecordHookSignalV3Input, "coordRoot" | "payload" | "adapter" | "instance_id">,
  context: ReturnType<typeof fingerprintContextV3>,
): `hid_${string}` {
  const nativeSession =
    input.payload.session_id ?? input.payload.conversation_id ?? input.payload.agent_id;
  if (nativeSession !== undefined) {
    return normalizeNativeIdV3(context, `${input.adapter}.session`, nativeSession);
  }

  // Cursor carries native session identity only on its start signal. Later
  // hooks may still have an exact coordination instance, so reuse its single
  // live producer authority instead of hashing the instance into a second
  // state path. Ambiguous or absent matches keep the fail-closed fallback.
  if (input.adapter === "cursor") {
    const matches = listHookProducerStateRecordsV3(input.coordRoot).filter(
      ({ state }) => state.adapter === input.adapter && state.instance_id === input.instance_id,
    );
    if (matches.length === 1) {
      const name = basename(matches[0]!.path);
      if (/^hid_[a-f0-9]{64}\.json$/.test(name)) {
        return name.slice(0, -".json".length) as `hid_${string}`;
      }
    }
  }
  return normalizeNativeIdV3(context, `${input.adapter}.session`, input.instance_id);
}

function intakeRecord(input: RecordHookSignalV3Input): HookIntakeRecordV3 {
  return {
    format: "harnery-v3-hook-intake",
    format_version: 1,
    mode: input.mode,
    signal: input.signal,
    payload: input.payload,
    adapter: input.adapter,
    instance_id: input.instance_id,
    producer_id: input.producer_id,
    build_id: input.build_id,
    platform: input.platform,
    ...(input.bridge ? { bridge: input.bridge } : {}),
    ...(input.adapterVersion ? { adapterVersion: input.adapterVersion } : {}),
    ...(input.harnessVersion ? { harnessVersion: input.harnessVersion } : {}),
    ...(input.monotonic_ns ? { monotonic_ns: input.monotonic_ns } : {}),
    ...(input.observed_at ? { observed_at: input.observed_at } : {}),
    ...(input.hook_name ? { hook_name: safeRole(input.hook_name) } : {}),
    ...(input.hook_duration_ms !== undefined
      ? { hook_duration_ms: Math.max(0, Math.floor(input.hook_duration_ms)) }
      : {}),
    ...(input.stop_remediation !== undefined ? { stop_remediation: input.stop_remediation } : {}),
    ...(input.turn_ritual ? { turn_ritual: input.turn_ritual } : {}),
  };
}

function inputForIntakeRecord(
  coordRoot: string,
  record: HookIntakeRecordV3,
): RecordHookSignalV3Input {
  return {
    coordRoot,
    mode: record.mode,
    signal: record.signal,
    payload: record.payload,
    adapter: record.adapter,
    instance_id: record.instance_id,
    producer_id: record.producer_id,
    build_id: record.build_id,
    platform: record.platform,
    ...(record.bridge ? { bridge: record.bridge } : {}),
    ...(record.adapterVersion ? { adapterVersion: record.adapterVersion } : {}),
    ...(record.harnessVersion ? { harnessVersion: record.harnessVersion } : {}),
    ...(record.monotonic_ns ? { monotonic_ns: record.monotonic_ns } : {}),
    ...(record.observed_at ? { observed_at: record.observed_at } : {}),
    ...(record.hook_name ? { hook_name: record.hook_name } : {}),
    ...(record.hook_duration_ms !== undefined ? { hook_duration_ms: record.hook_duration_ms } : {}),
    ...(record.stop_remediation !== undefined ? { stop_remediation: record.stop_remediation } : {}),
    ...(record.turn_ritual ? { turn_ritual: record.turn_ritual } : {}),
  };
}

interface OwnIntakeRecordV3 {
  path: string;
  input: RecordHookSignalV3Input;
}

/**
 * Drain one session's intake spool under its held state lease. Records are
 * processed in append order and deleted only after their outcome is durably
 * published; the loop rescans until an empty pass so appends that landed while
 * draining are still picked up. A record that throws is preserved in the
 * diagnostics spool and removed so it cannot poison the drain; the caller's
 * own record rethrows to keep today's error visibility.
 */
function drainSessionIntakeLocked(
  coordRoot: string,
  control: OpenHookControlStateV3,
  adapter: Adapter,
  sessionHash: `hid_${string}`,
  statePath: string,
  own?: OwnIntakeRecordV3,
): RecordHookSignalV3Result | undefined {
  const directory = hookIntakeGroupDirV3(coordRoot, adapter, sessionHash);
  let ownResult: RecordHookSignalV3Result | undefined;
  for (;;) {
    const entries = listHookIntakeRecordsV3(directory);
    if (entries.length === 0) break;
    for (const entry of entries) {
      const isOwn = own !== undefined && entry.path === own.path;
      let result: RecordHookSignalV3Result | undefined;
      if (!entry.record) {
        writeProducerDiagnosticV3(coordRoot, "intake_unreadable", { path: entry.path });
      } else if (entry.record.mode !== control.state) {
        writeProducerDiagnosticV3(coordRoot, "intake_gate_mismatch", {
          observed_gate: control.state,
          ...entry.record,
        });
      } else {
        const recordInput = isOwn ? own.input : inputForIntakeRecord(coordRoot, entry.record);
        try {
          result = processHookSignalLocked(control, recordInput, sessionHash, statePath);
        } catch (error) {
          writeProducerDiagnosticV3(coordRoot, "intake_poison", {
            error: String(error),
            ...entry.record,
          });
          removeIntakeRecordV3(entry.path);
          if (isOwn) throw error;
          continue;
        }
      }
      removeIntakeRecordV3(entry.path);
      if (isOwn) ownResult = result ?? { state: "spooled" };
    }
  }
  return ownResult;
}

export interface DrainHookIntakeSpoolV3Result {
  groups_with_records: number;
  groups_drained: number;
  groups_skipped_busy: number;
}

/**
 * Drain every session's pending intake records. This is the terminal drainer:
 * it does not depend on a "next signal" ever arriving for a session, so it is
 * wired into reconcile and session-start paths to pick up a final signal whose
 * appender lost the lease and exited.
 */
export function drainHookIntakeSpoolV3(coordRoot: string): DrainHookIntakeSpoolV3Result {
  const result: DrainHookIntakeSpoolV3Result = {
    groups_with_records: 0,
    groups_drained: 0,
    groups_skipped_busy: 0,
  };
  const control = readEventV3ControlState(coordRoot);
  if (control.state !== "candidate" && control.state !== "active") return result;
  for (const group of listHookIntakeGroupsV3(coordRoot)) {
    if (listHookIntakeRecordsV3(group.directory).length === 0) continue;
    result.groups_with_records += 1;
    const statePath = producerStatePath(coordRoot, group.adapter, group.session_hash);
    const lease = acquireStateLeaseWithRetry(coordRoot, statePath, 2);
    if (!lease) {
      result.groups_skipped_busy += 1;
      continue;
    }
    try {
      drainSessionIntakeLocked(coordRoot, control, group.adapter, group.session_hash, statePath);
      result.groups_drained += 1;
    } finally {
      lease.release();
    }
  }
  return result;
}

function acquireStateLeaseWithRetry(
  coordRoot: string,
  statePath: string,
  attempts: number,
): ReturnType<typeof acquireStateLease> | undefined {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return acquireStateLease(coordRoot, statePath);
    } catch (error) {
      const message = String(error);
      const contended =
        message.includes("held by a live or unexpired owner") ||
        message.includes("recovery is already in progress");
      if (!contended) throw error;
      if (attempt < attempts) sleepSync(STATE_LEASE_RETRY_DELAY_MS);
    }
  }
  return undefined;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** The pre-spool body of the recorder: requires the session's state lease to be held. */
function processHookSignalLocked(
  control: OpenHookControlStateV3,
  input: RecordHookSignalV3Input,
  sessionHash: `hid_${string}`,
  path: string,
): RecordHookSignalV3Result {
  const rootId = control.genesis.event.scope.root_id as `root_${string}`;
  const epochId = control.genesis.profile.privacy_key_epoch;
  const boundaryEventId =
    control.state === "candidate"
      ? control.genesis.event.event_id
      : control.activation.event.event_id;
  const rootFingerprintContext = fingerprintContextV3(input.coordRoot, rootId, undefined, epochId);
  const sessionId = `sid_${sessionHash.slice(4)}` as `sid_${string}`;
  try {
    let state = existsSync(path) ? readProducerState(path) : undefined;
    if (
      state &&
      (state.adapter !== input.adapter ||
        state.session_id !== sessionId ||
        state.privacy_epoch_id !== epochId ||
        state.capability_profile !== adapterCapabilityProfileDigestV3(input.adapter))
    ) {
      throw new Error("V3 producer state authority does not match the active boundary");
    }
    let recovered: RecordHookSignalV3Result | undefined;
    if (state?.pending) {
      const pendingSource = state.pending.source_id;
      const incomingSource = sourceIdForSignal(input, rootFingerprintContext);
      const pendingEvent = state.pending.event;
      const durability = writeEventV3(input.coordRoot, pendingEvent);
      applyCommittedEvent(state, pendingEvent);
      state.pending = undefined;
      publishProducerState(path, state);
      if (pendingSource && incomingSource === pendingSource) {
        recovered = { state: "recorded", event: pendingEvent, durability, recovered: true };
      }
    }
    if (recovered) return recovered;

    if (input.signal === "session-start") {
      if (state && !state.terminal && state.started_event_id) {
        return { state: "already_started", event_id: state.started_event_id };
      }
      state = newProducerState(input, sessionId, epochId, boundaryEventId as `evt_${string}`);
    } else if (!state || state.terminal) {
      // Mid-flight onboarding (ADR 0078): a live session with no producer
      // state in this epoch (fresh epoch, lost session-start hook) opens a
      // new generation with a derived session.started so its activity is
      // recorded instead of refused. A TERMINAL state never re-onboards:
      // resurrection after authoritative termination stays forbidden.
      // Onboarding requires the payload's own native session identity: an
      // env-attributed signal must not mint a generation under a hash derived
      // from the observer instance (that would split the real session).
      const nativeSessionIdentity =
        input.payload.session_id ?? input.payload.conversation_id ?? input.payload.agent_id;
      const onboardable =
        !state &&
        RECOVERY_ENABLED_ADAPTERS.has(input.adapter) &&
        input.signal !== "session-end" &&
        nativeSessionIdentity !== undefined;
      if (!onboardable) {
        writeProducerDiagnosticV3(input.coordRoot, "missing_session_start", {
          adapter: input.adapter,
          instance_id: input.instance_id,
          signal: input.signal,
          session_hash: sessionHash,
          payload: input.payload,
        });
        return { state: "missing_session_start" };
      }
      state = newProducerState(input, sessionId, epochId, boundaryEventId as `evt_${string}`);
      const cursorPromptBootstrap = isCursorPromptBootstrap(input);
      const onboarding = buildMidFlightSessionStart(input, state, rootId, cursorPromptBootstrap);
      commitEventLocked(input, state, path, onboarding);
      if (!cursorPromptBootstrap) {
        writeProducerDiagnosticV3(input.coordRoot, "mid_flight_onboarding", {
          adapter: input.adapter,
          instance_id: input.instance_id,
          signal: input.signal,
          session_hash: sessionHash,
        });
      }
    }

    const fingerprintContext = fingerprintContextV3(
      input.coordRoot,
      rootId,
      state.generation_id,
      state.privacy_epoch_id,
    );
    const recoveryEnabled = RECOVERY_ENABLED_ADAPTERS.has(input.adapter);
    const nativeTid = input.payload.turn_id
      ? (normalizeNativeIdV3(
          fingerprintContext,
          `${input.adapter}.turn`,
          input.payload.turn_id,
        ).replace(/^hid_/, "tid_") as `tid_${string}`)
      : undefined;

    if (input.signal === "user-prompt-submit" && !state.current_turn_span) {
      state.current_turn_span = openSpanStateV3({
        span_id: spanIdV3(),
        parent_span_id: state.session_span.span_id,
        boot_id: state.boot_id,
        clock: signalClock(input),
      });
    }

    recordTurnHarnessTiming(state, input);

    closeResolvedWaits(input, state, path, rootId, fingerprintContext, nativeTid);
    if (input.signal === "permission-request") {
      const waitId = waitIdForInput(input, fingerprintContext);
      if (waitId && state.waits.some((wait) => wait.wait_id === waitId)) {
        return { state: "ignored" };
      }
    }

    // Turn-boundary recovery (ADR 0078): a turn terminal is authoritative for
    // the spans it owns. Derived terminals land BEFORE the native turn event.
    if (recoveryEnabled && (input.signal === "stop" || input.signal === "stop-failure")) {
      // The open producer turn is authoritative for a terminal. Cursor may
      // report a different generation_id on Stop than beforeSubmitPrompt.
      const endingTid = state.current_turn_id ?? nativeTid;
      if (endingTid) {
        sweepOpenSpans(
          input,
          state,
          path,
          rootId,
          (candidate) => candidate.turn_id !== undefined && candidate.turn_id === endingTid,
          "completion_not_observed_before_turn_end",
        );
      }
    } else if (recoveryEnabled && input.signal === "user-prompt-submit") {
      sweepOpenSpans(
        input,
        state,
        path,
        rootId,
        (candidate) =>
          candidate.turn_id !== undefined &&
          (nativeTid === undefined || candidate.turn_id !== nativeTid),
        "completion_not_observed_before_next_turn",
      );
    }

    let sourceId = sourceIdForSignal(input, rootFingerprintContext);
    const semanticKey = cursorShellSemanticKey(input, rootFingerprintContext);
    let span: SpanStateV3 | undefined;
    let delegation: DelegationStateV3 | undefined;
    if (input.signal === "pre-tool-use") {
      span = semanticKey
        ? state.spans.find((candidate) => candidate.semantic_key === semanticKey)
        : undefined;
      if (span?.requested_event_id) return { state: "ignored" };
      if (!sourceId && semanticKey) {
        sourceId = cursorShellFallbackSourceId(semanticKey, state, rootFingerprintContext);
      }
      if (!sourceId) return unpairableTool(input, sessionHash, "missing_tool_use_id");
      if (state.closed_spans.some((closed) => closed.source_id === sourceId)) {
        // A late pre for a closed span must never open a fresh span: that is
        // the pre/post-inversion orphan (ADR 0078).
        return suppressClosedSpanSignal(input, sessionHash, "late_pre_suppressed");
      }
      if (recoveryEnabled && state.spans.length >= SPAN_SOFT_WATERMARK) {
        const currentTid = nativeTid ?? state.current_turn_id;
        sweepOpenSpans(
          input,
          state,
          path,
          rootId,
          (candidate) => candidate.turn_id !== undefined && candidate.turn_id !== currentTid,
          "span_cap_pressure",
        );
      }
      span ??= state.spans.find((candidate) => candidate.source_id === sourceId);
      if (span?.requested_event_id) return { state: "ignored" };
      if (!span) {
        const opened = openSpanStateV3({
          span_id: spanIdV3(),
          parent_span_id: state.current_turn_span?.span_id ?? state.session_span.span_id,
          boot_id: state.boot_id,
          clock: signalClock(input),
        });
        span = {
          source_id: sourceId,
          ...(semanticKey ? { semantic_key: semanticKey } : {}),
          ...opened,
          ...(input.payload.tool_name ? { tool_name: safeRole(input.payload.tool_name) } : {}),
        };
        state.spans.push(span);
      }
    } else if (input.signal === "post-tool-use" || input.signal === "post-tool-use-failure") {
      span = sourceId
        ? state.spans.find((candidate) => candidate.source_id === sourceId)
        : undefined;
      span ??= semanticKey
        ? state.spans.find((candidate) => candidate.semantic_key === semanticKey)
        : undefined;
      if (span) sourceId = span.source_id;
      if (!sourceId && semanticKey) {
        sourceId = cursorShellFallbackSourceId(semanticKey, state, rootFingerprintContext);
      }
      if (!sourceId) return unpairableTool(input, sessionHash, "missing_tool_use_id");
      if (!span) {
        if (
          semanticKey &&
          state.closed_spans.some((closed) => closed.semantic_key === semanticKey)
        ) {
          return { state: "ignored" };
        }
        if (state.closed_spans.some((closed) => closed.source_id === sourceId)) {
          return suppressClosedSpanSignal(input, sessionHash, "late_post_suppressed");
        }
        if (!recoveryEnabled) return unpairableTool(input, sessionHash, "no_open_span");
        // Unmatched post (ADR 0078): record a derived request and pair the
        // native completion on a fresh span instead of discarding the result.
        const opened = openSpanStateV3({
          span_id: spanIdV3(),
          parent_span_id: state.current_turn_span?.span_id ?? state.session_span.span_id,
          boot_id: state.boot_id,
          clock: signalClock(input),
        });
        span = {
          source_id: sourceId,
          ...(semanticKey ? { semantic_key: semanticKey } : {}),
          ...opened,
          recovery_reason: "request_not_observed",
          ...(input.payload.tool_name ? { tool_name: safeRole(input.payload.tool_name) } : {}),
        };
        const derivedRequest = normalizeHookEventV3("pre-tool-use", input.payload, {
          coordRoot: input.coordRoot,
          adapter: input.adapter,
          adapterVersion: input.adapterVersion,
          harnessVersion: input.harnessVersion,
          root_id: rootId,
          run_id: input.run_id,
          workflow_id: input.workflow_id,
          workflow_agent_id: input.workflow_agent_id,
          instance_id: input.instance_id,
          generation_id: state.generation_id,
          attestation_id: state.attestation_id,
          producer_id: input.producer_id,
          boot_id: state.boot_id,
          sequence: state.next_sequence,
          build_id: input.build_id,
          platform: input.platform,
          bridge: input.bridge,
          capability_profile: state.capability_profile,
          fingerprintContext,
          turn_id: state.current_turn_id,
          span_id: span.span_id,
          caused_by: state.last_event_id ? [state.last_event_id] : [],
          monotonic_ns: orderedEventMonotonic(state, input.monotonic_ns),
          clock_id: state.clock_id,
        });
        if (!derivedRequest) return unpairableTool(input, sessionHash, "no_open_span");
        derivedRequest.provenance = {
          ...derivedRequest.provenance,
          attestation: "derived",
          confidence: input.payload.tool_input !== undefined ? "high" : "medium",
        };
        (derivedRequest.payload as { recovery?: { reason: string } }).recovery = {
          reason: "request_not_observed",
        };
        state.spans.push(span);
        commitEventLocked(input, state, path, derivedRequest);
        span.requested_event_id = derivedRequest.event_id as `evt_${string}`;
        span.open_event_id = derivedRequest.event_id as `evt_${string}`;
        stampSpanTurn(span, derivedRequest, input, state);
      }
    }
    if (input.signal === "sub-agent-start") {
      if (!sourceId) return { state: "ignored" };
      delegation = state.delegations.find((candidate) => candidate.source_id === sourceId);
      if (!delegation) {
        const opened = openSpanStateV3({
          span_id: spanIdV3(),
          parent_span_id: state.current_turn_span?.span_id ?? state.session_span.span_id,
          boot_id: state.boot_id,
          clock: signalClock(input),
        });
        delegation = {
          source_id: sourceId,
          ...opened,
          delegation_id: delegationIdV3(),
          child_generation_id: generationIdV3(),
          role: safeRole(input.payload.raw.agent_type),
        };
        state.delegations.push(delegation);
      }
    } else if (input.signal === "sub-agent-stop") {
      if (!sourceId) return { state: "ignored" };
      delegation = state.delegations.find((candidate) => candidate.source_id === sourceId);
      if (!delegation) return { state: "ignored" };
    }

    const waitSpan =
      input.signal === "permission-request"
        ? openSpanStateV3({
            span_id: spanIdV3(),
            parent_span_id: state.current_turn_span?.span_id ?? state.session_span.span_id,
            boot_id: state.boot_id,
            clock: signalClock(input),
          })
        : undefined;
    const openingSpan =
      input.signal === "session-start"
        ? state.session_span
        : input.signal === "user-prompt-submit"
          ? state.current_turn_span
          : input.signal === "pre-tool-use"
            ? span
            : input.signal === "permission-request"
              ? waitSpan
              : input.signal === "sub-agent-start"
                ? delegation
                : undefined;
    const closingSpan =
      input.signal === "session-end"
        ? state.session_span
        : input.signal === "stop" || input.signal === "stop-failure"
          ? state.current_turn_span
          : input.signal === "post-tool-use" || input.signal === "post-tool-use-failure"
            ? span
            : input.signal === "sub-agent-stop"
              ? delegation
              : undefined;
    const terminalSpan = closingSpan
      ? closeSpanStateV3(closingSpan, {
          boot_id: state.boot_id,
          clock: signalClock(input),
          ...(span && closingSpan === span && span.recovery_reason
            ? { recovery_reason: span.recovery_reason }
            : {}),
        })
      : undefined;

    const turnTelemetry =
      input.signal === "stop" || input.signal === "stop-failure"
        ? extractTurnTelemetryV3(input.adapter, input.payload.raw, signalClock(input).observed_at)
        : undefined;
    const cursorToolChannelUnattested =
      (input.signal === "stop" || input.signal === "stop-failure") &&
      input.adapter === "cursor" &&
      state.tool_call_count === 0;
    const toolCallCountScopeMismatch =
      (input.signal === "stop" || input.signal === "stop-failure") &&
      (!state.current_turn_id || state.tool_call_count_turn_id !== state.current_turn_id);
    const event = normalizeHookEventV3(input.signal, input.payload, {
      coordRoot: input.coordRoot,
      adapter: input.adapter,
      adapterVersion: input.adapterVersion,
      harnessVersion: input.harnessVersion,
      root_id: rootId,
      run_id: input.run_id,
      workflow_id: input.workflow_id,
      workflow_agent_id: input.workflow_agent_id,
      // Native subagent tool hooks can carry the parent's session id while
      // resolving to a child process instance. The session-keyed producer
      // state remains the generation authority; route those signals through
      // its instance instead of rejecting or forging a child/parent scope.
      instance_id: state.instance_id,
      generation_id: state.generation_id,
      attestation_id: state.attestation_id,
      producer_id: input.producer_id,
      boot_id: state.boot_id,
      sequence: state.next_sequence,
      build_id: input.build_id,
      platform: input.platform,
      bridge: input.bridge,
      capability_profile: state.capability_profile,
      fingerprintContext,
      turn_id: state.current_turn_id,
      span_id: openingSpan?.span_id ?? closingSpan?.span_id,
      parent_span_id: openingSpan?.parent_span_id ?? closingSpan?.parent_span_id,
      terminal_span: terminalSpan,
      harness_timing: state.turn_harness,
      turn_telemetry: turnTelemetry,
      caused_by: [
        ...(state.last_event_id ? [state.last_event_id] : []),
        ...(terminalSpan?.open_event_id ? [terminalSpan.open_event_id] : []),
      ].filter((value, index, values) => values.indexOf(value) === index) as `evt_${string}`[],
      observed_at: signalClock(input).observed_at,
      monotonic_ns: orderedEventMonotonic(state, input.monotonic_ns),
      clock_id: state.clock_id,
      duration_ms: durationMilliseconds(span?.opened_monotonic_ns, input.monotonic_ns),
      // Cursor's terminal payload has no native tool aggregate. With no
      // delivered tool hook, the recorder has no evidence that zero calls
      // occurred; emitting an exact zero would turn hook loss into false data.
      tool_call_count:
        cursorToolChannelUnattested || toolCallCountScopeMismatch
          ? undefined
          : state.tool_call_count,
      tool_call_count_missing_reason: cursorToolChannelUnattested
        ? "tool_channel_unattested"
        : toolCallCountScopeMismatch
          ? "tool_count_turn_scope_unattested"
          : undefined,
      delegation_id: delegation?.delegation_id,
      child_generation_id: delegation?.child_generation_id,
      agent_role: delegation?.role,
      stop_remediation: input.stop_remediation,
      turn_ritual: input.turn_ritual,
    });
    if (!event) return { state: "ignored" };
    if (input.signal === "pre-tool-use" && span && !span.requested_event_id) {
      span.requested_event_id = event.event_id as `evt_${string}`;
      span.open_event_id = event.event_id as `evt_${string}`;
      stampSpanTurn(span, event, input, state);
    }
    const durability = commitEventLocked(input, state, path, event, sourceId);
    if (turnTelemetry?.context) {
      commitTurnContextObservation(input, state, path, rootId, event, turnTelemetry.context);
    }
    if (event.event_type === "session.ended") {
      commitCapabilityDriftEvents(input, state, path, rootId);
    }
    return { state: "recorded", event, durability, recovered: false };
  } finally {
    // The session's state lease is held by the draining caller.
  }
}

/**
 * Stamp the span with the turn its request event was attributed to. No stamp
 * is written without a real turn context: a native payload turn id or an open
 * producer-state turn. Unstamped spans are excluded from every boundary and
 * cap sweep (fail closed; explicit-end salvage may still reach them).
 */
function stampSpanTurn(
  span: SpanStateV3,
  requestEvent: EventV3,
  input: RecordHookSignalV3Input,
  state: HookProducerStateV3,
): void {
  if (input.payload.turn_id) {
    span.turn_id = (requestEvent.scope as { turn_id: `tid_${string}` }).turn_id;
    span.turn_stamp = "native_payload";
  } else if (state.current_turn_id) {
    span.turn_id = state.current_turn_id;
    span.turn_stamp = "producer_state";
  }
}

/** The single pending-publish/write/apply/publish cycle every locked event commit uses. */
function commitEventLocked(
  input: RecordHookSignalV3Input,
  state: HookProducerStateV3,
  path: string,
  event: EventV3,
  sourceId?: `hid_${string}`,
): WriteEventV3Result {
  assertEventV3(event);
  state.pending = { ...(sourceId ? { source_id: sourceId } : {}), event };
  publishProducerState(path, state);
  const durability = writeEventV3(input.coordRoot, event, input.writerOptions);
  applyCommittedEvent(state, event);
  state.pending = undefined;
  publishProducerState(path, state);
  return durability;
}

function commitTurnContextObservation(
  input: RecordHookSignalV3Input,
  state: HookProducerStateV3,
  path: string,
  rootId: `root_${string}`,
  turnTerminal: EventV3,
  measurement: ContextMeasurementV3,
): void {
  if (turnTerminal.event_type !== "turn.completed") return;
  const event = buildEventV3("context.observed", {
    producer: {
      producer_id: input.producer_id,
      boot_id: state.boot_id,
      sequence: state.next_sequence,
      component: "agent-hook",
      build_id: input.build_id,
      platform: input.platform,
      ...(input.bridge ? { bridge: input.bridge } : {}),
    },
    scope: {
      root_id: rootId,
      instance_id: state.instance_id,
      session_id: state.session_id,
      generation_id: state.generation_id,
      turn_id: (turnTerminal.scope as { turn_id: `tid_${string}` }).turn_id,
      ...(input.run_id ? { run_id: input.run_id } : {}),
      ...(input.workflow_id ? { workflow_id: input.workflow_id } : {}),
      ...(input.workflow_agent_id ? { workflow_agent_id: input.workflow_agent_id } : {}),
    },
    attestation_id: state.attestation_id,
    links: { caused_by: [turnTerminal.event_id] },
    provenance: {
      source_event: `${input.adapter}.turn-context`,
      attestation: "native",
      confidence: "exact",
      attribution: {
        method: "native_payload",
        state: "verified",
        subject_instance_id: state.instance_id,
      },
    },
    observed_at: measurement.measured_at,
    monotonic_ns: orderedEventMonotonic(state, input.monotonic_ns),
    clock_id: state.clock_id,
    payload: {
      measurement: {
        state: "observed",
        value: measurement,
        attestation: "native",
        confidence: "exact",
      },
    },
  }) as EventV3;
  commitEventLocked(input, state, path, event);
}

function commitCapabilityDriftEvents(
  input: RecordHookSignalV3Input,
  state: HookProducerStateV3,
  path: string,
  rootId: `root_${string}`,
): void {
  const read = readLedgerV3(input.coordRoot);
  if (!read.complete) return;
  const generationEvents = read.events
    .map(({ event }) => event)
    .filter(
      (event) =>
        "generation_id" in event.scope && event.scope.generation_id === state.generation_id,
    );
  const emittedSignals = new Set(
    generationEvents
      .filter((event) => event.event_type === "health.capability_drift")
      .map((event) => (event.payload as { signal: string }).signal),
  );
  for (const payload of capabilityDriftPayloadsV3(input.adapter, generationEvents)) {
    if (emittedSignals.has(payload.signal)) continue;
    const event = buildEventV3("health.capability_drift", {
      producer: {
        producer_id: input.producer_id,
        boot_id: state.boot_id,
        sequence: state.next_sequence,
        component: "agent-hook",
        build_id: input.build_id,
        platform: input.platform,
        ...(input.bridge ? { bridge: input.bridge } : {}),
      },
      scope: {
        root_id: rootId,
        instance_id: state.instance_id,
        session_id: state.session_id,
        generation_id: state.generation_id,
      },
      attestation_id: state.attestation_id,
      links: { caused_by: state.last_event_id ? [state.last_event_id] : [] },
      provenance: {
        source_event: `${input.adapter}.capability-coherence`,
        attestation: "derived",
        confidence: "exact",
        attribution: {
          method: "session_env",
          state: "verified",
          subject_instance_id: state.instance_id,
        },
      },
      observed_at: signalClock(input).observed_at,
      monotonic_ns: orderedEventMonotonic(state, input.monotonic_ns),
      clock_id: state.clock_id,
      payload,
    }) as EventV3;
    commitEventLocked(input, state, path, event);
  }
}

/**
 * Terminalize every open span matching the predicate with a derived
 * `tool.completed` (ADR 0078). One event per span, committed sequentially
 * through the pending cycle so a crash replays exactly one.
 */
function sweepOpenSpans(
  input: RecordHookSignalV3Input,
  state: HookProducerStateV3,
  path: string,
  rootId: `root_${string}`,
  matches: (span: SpanStateV3) => boolean,
  reason:
    | "completion_not_observed_before_turn_end"
    | "completion_not_observed_before_next_turn"
    | "span_cap_pressure",
): void {
  for (const span of [...state.spans]) {
    if (!matches(span)) continue;
    const event = buildDerivedToolCompleted(input, state, rootId, span, reason);
    commitEventLocked(input, state, path, event);
  }
}

function buildDerivedToolCompleted(
  input: RecordHookSignalV3Input,
  state: HookProducerStateV3,
  rootId: `root_${string}`,
  span: SpanStateV3,
  reason:
    | "completion_not_observed_before_turn_end"
    | "completion_not_observed_before_next_turn"
    | "span_cap_pressure"
    | "explicit_end_salvage",
  producerOverride?: { producer_id: `prd_${string}`; boot_id: `boot_${string}`; sequence: number },
  observedAt?: string,
): EventV3 {
  const baseConfidence =
    reason === "completion_not_observed_before_turn_end" || reason === "explicit_end_salvage"
      ? "medium"
      : "low";
  const confidence =
    span.turn_stamp === "producer_state" && baseConfidence === "medium" ? "low" : baseConfidence;
  const event = buildEventV3("tool.completed", {
    producer: {
      producer_id: producerOverride?.producer_id ?? input.producer_id,
      boot_id: producerOverride?.boot_id ?? state.boot_id,
      sequence: producerOverride?.sequence ?? state.next_sequence,
      component: "agent-hook",
      build_id: input.build_id,
      platform: input.platform,
      ...(input.bridge ? { bridge: input.bridge } : {}),
    },
    scope: {
      root_id: rootId,
      instance_id: state.instance_id,
      session_id: state.session_id,
      generation_id: state.generation_id,
      turn_id: span.turn_id as `tid_${string}`,
    },
    attestation_id: state.attestation_id,
    links: {
      caused_by: [
        ...(state.last_event_id ? [state.last_event_id] : []),
        ...(span.open_event_id ? [span.open_event_id] : []),
      ].filter((value, index, values) => values.indexOf(value) === index),
      span_id: span.span_id,
    },
    provenance: {
      source_event: `${input.adapter}.recovery`,
      attestation: "derived",
      confidence,
      attribution: {
        method: span.turn_stamp === "native_payload" ? "native_payload" : "session_env",
        state: "verified",
        subject_instance_id: state.instance_id,
      },
    },
    observed_at: observedAt,
    monotonic_ns: orderedEventMonotonic(state, input.monotonic_ns),
    clock_id: state.clock_id,
    payload: {
      tool: { namespace: input.adapter, name: span.tool_name ?? "unknown_tool" },
      outcome: "unknown",
      duration_ms: { state: "unknown", reason },
      span: closeSpanStateV3(span, {
        boot_id: state.boot_id,
        clock: {
          observed_at: observedAt ?? signalClock(input).observed_at,
          ...(input.monotonic_ns ? { monotonic_ns: input.monotonic_ns } : {}),
        },
        recovery_reason: reason,
      }),
      result: { storage: "omitted", media_type: "application/octet-stream", bytes: 0 },
      recovery: {
        reason,
        ...(span.requested_event_id ? { requested_event_id: span.requested_event_id } : {}),
      },
    },
  }) as EventV3;
  assertEventV3(event);
  return event;
}

/**
 * A derived `session.started` for a live session Harnery first observed
 * mid-flight (fresh epoch or lost session-start hook). Records that the
 * session exists without claiming the adapter delivered a start signal.
 */
function buildMidFlightSessionStart(
  input: RecordHookSignalV3Input,
  state: HookProducerStateV3,
  rootId: `root_${string}`,
  cursorPromptBootstrap = false,
): EventV3 {
  const fingerprintContext = fingerprintContextV3(
    input.coordRoot,
    rootId,
    state.generation_id,
    state.privacy_epoch_id,
  );
  const event = normalizeHookEventV3("session-start", input.payload, {
    coordRoot: input.coordRoot,
    adapter: input.adapter,
    adapterVersion: input.adapterVersion,
    harnessVersion: input.harnessVersion,
    root_id: rootId,
    run_id: input.run_id,
    workflow_id: input.workflow_id,
    workflow_agent_id: input.workflow_agent_id,
    instance_id: input.instance_id,
    generation_id: state.generation_id,
    attestation_id: state.attestation_id,
    producer_id: input.producer_id,
    boot_id: state.boot_id,
    sequence: state.next_sequence,
    build_id: input.build_id,
    platform: input.platform,
    bridge: input.bridge,
    capability_profile: state.capability_profile,
    fingerprintContext,
    caused_by: state.last_event_id ? [state.last_event_id] : [],
    monotonic_ns: orderedEventMonotonic(state, input.monotonic_ns),
    clock_id: state.clock_id,
  });
  if (!event) throw new Error("mid-flight session start could not be normalized");
  event.provenance = {
    ...event.provenance,
    attestation: "derived",
    confidence: cursorPromptBootstrap ? "high" : "medium",
  };
  (event.payload as { resume?: unknown }).resume = {
    state: "unknown",
    reason: cursorPromptBootstrap ? "cursor_prompt_bootstrap" : "mid_flight_onboarding",
  };
  assertEventV3(event);
  return event;
}

/**
 * Cursor can deliver its native `beforeSubmitPrompt` signal before its
 * `sessionStart` hook. The prompt carries both conversation and turn identity,
 * so it is a high-confidence session boundary rather than degraded recovery.
 */
function isCursorPromptBootstrap(input: RecordHookSignalV3Input): boolean {
  return (
    input.adapter === "cursor" &&
    input.signal === "user-prompt-submit" &&
    (input.payload.conversation_id !== undefined || input.payload.session_id !== undefined) &&
    input.payload.turn_id !== undefined
  );
}

function suppressClosedSpanSignal(
  input: RecordHookSignalV3Input,
  sessionHash: `hid_${string}`,
  category: "late_pre_suppressed" | "late_post_suppressed",
): RecordHookSignalV3Result {
  writeProducerDiagnosticV3(input.coordRoot, category, {
    adapter: input.adapter,
    instance_id: input.instance_id,
    signal: input.signal,
    session_hash: sessionHash,
    payload: input.payload,
  });
  return { state: "suppressed", reason: "closed_span" };
}

/**
 * End one exact live generation under the same private-state lease used by its
 * native hook producer. This is the only approved-authority terminal writer:
 * archive reconciliation, explicit `harn-end`, and policy cascades all converge
 * here so they cannot race each other or append activity after termination.
 */
export function recordApprovedSessionEndV3(
  input: RecordApprovedSessionEndV3Input,
): RecordApprovedSessionEndV3Result {
  const control = readEventV3ControlState(input.coordRoot);
  if (control.state !== input.mode) {
    return { state: "gate_closed", reason: control.state };
  }
  const matches = listHookProducerStateRecordsV3(input.coordRoot, { includeTerminal: true }).filter(
    ({ state }) =>
      state.instance_id === input.instance_id && state.generation_id === input.generation_id,
  );
  if (matches.length !== 1) {
    return {
      state: "generation_unavailable",
      reason: matches.length === 0 ? "not_found" : "ambiguous",
    };
  }
  const record = matches[0]!;
  const lease = acquireStateLease(input.coordRoot, record.path);
  try {
    const state = readProducerState(record.path);
    if (state.instance_id !== input.instance_id || state.generation_id !== input.generation_id) {
      return { state: "generation_unavailable", reason: "authority_changed" };
    }
    let recovered = false;
    if (state.pending) {
      const pending = state.pending.event;
      const durability = writeEventV3(input.coordRoot, pending, input.writerOptions);
      applyCommittedEvent(state, pending);
      state.pending = undefined;
      publishProducerState(record.path, state);
      recovered = true;
      if (pending.event_type === "session.ended") {
        return { state: "recorded", event: pending, durability, recovered };
      }
    }
    if (state.terminal) return { state: "already_ended", event_id: state.last_event_id };
    if (!state.started_event_id || !state.last_event_id) {
      return { state: "generation_unavailable", reason: "session_start_missing" };
    }

    const rootId = control.genesis.event.scope.root_id as `root_${string}`;
    const context = fingerprintContextV3(
      input.coordRoot,
      rootId,
      state.generation_id,
      state.privacy_epoch_id,
    );
    const expected = [
      "session_started",
      "turn_closed",
      "tool_spans_closed",
      "delegated_children_closed",
      "coordination_finalized",
    ];
    const observed = [
      ...(state.started_event_id ? ["session_started"] : []),
      ...(!state.current_turn_id ? ["turn_closed"] : []),
      ...(state.spans.length === 0 ? ["tool_spans_closed"] : []),
      ...(state.delegations.length === 0 ? ["delegated_children_closed"] : []),
      ...(input.coordination_finalized ? ["coordination_finalized"] : []),
    ];
    const observedSet = new Set(observed);
    const missing = expected.filter((field) => !observedSet.has(field));
    const causedBy = [
      ...new Set(
        [state.last_event_id, input.caused_by_event_id, state.session_span.open_event_id].filter(
          Boolean,
        ),
      ),
    ] as [`evt_${string}`, ...`evt_${string}`[]] | [];
    const event = buildEventV3("session.ended", {
      producer: {
        producer_id: "prd_agent-finalizer",
        boot_id: `boot_${randomUUID()}`,
        sequence: 1,
        component: "agent-coord",
        build_id: input.build_id,
        platform: input.platform,
      },
      scope: {
        root_id: rootId,
        instance_id: state.instance_id,
        session_id: state.session_id,
        generation_id: state.generation_id,
      },
      attestation_id: state.attestation_id,
      links: { caused_by: causedBy },
      provenance: {
        source_event: `agent-coord.session-finalizer.${input.reason}`,
        attestation: "derived",
        confidence: input.confidence ?? "high",
        source_record_id: normalizeNativeIdV3(
          context,
          "agent-coord.approved-session-end",
          `${input.reason}\0${state.generation_id}\0${input.observed_at ?? "now"}`,
        ),
        attribution: {
          method: "explicit_argument",
          state: "verified",
          observer_instance_id: state.instance_id,
          subject_instance_id: state.instance_id,
        },
      },
      observed_at: input.observed_at,
      clock_id: state.clock_id,
      payload: {
        outcome: input.outcome,
        authority: "approved",
        reason: input.reason,
        span: closeSpanStateV3(state.session_span, {
          boot_id: state.boot_id,
          clock: { observed_at: input.observed_at ?? new Date().toISOString() },
        }),
        completeness: {
          state: "observed",
          value: { expected, observed, missing },
          attestation: "derived",
          confidence: input.confidence ?? "high",
        },
      },
    }) as EventV3;
    assertEventV3(event);

    state.pending = { event };
    publishProducerState(record.path, state);
    const durability = writeEventV3(input.coordRoot, event, input.writerOptions);
    applyCommittedEvent(state, event);
    state.pending = undefined;
    publishProducerState(record.path, state);
    return { state: "recorded", event, durability, recovered };
  } finally {
    lease.release();
  }
}

export interface SalvageOpenSpansV3Input {
  coordRoot: string;
  mode: EventV3WriteMode;
  instance_id: `inst_${string}`;
  generation_id: `gen_${string}`;
  allowed_span_ids: readonly `span_${string}`[];
  requested_turn_id?: `tid_${string}`;
  build_id: `build_${string}`;
  platform: "linux" | "windows" | "macos" | "unknown";
  observed_at?: string;
  writerOptions?: WriteEventV3Options;
}

export type SalvageOpenSpansV3Result =
  | { state: "gate_closed"; reason: string }
  | { state: "generation_unavailable"; reason: string }
  | { state: "salvaged"; closed: number };

/**
 * Explicit-end salvage (ADR 0078): terminalize exactly the approved open-span
 * set with derived recovery terminals so an authorized end stops wedging
 * behind spans nothing else can close. Runs under the same private-state
 * lease as the native producer; spans outside the approved set are refused by
 * the caller's eligibility gate and never touched here.
 */
export function salvageOpenSpansV3(input: SalvageOpenSpansV3Input): SalvageOpenSpansV3Result {
  const control = readEventV3ControlState(input.coordRoot);
  if (control.state !== input.mode) {
    return { state: "gate_closed", reason: control.state };
  }
  const matches = listHookProducerStateRecordsV3(input.coordRoot).filter(
    ({ state }) =>
      state.instance_id === input.instance_id && state.generation_id === input.generation_id,
  );
  if (matches.length !== 1) {
    return {
      state: "generation_unavailable",
      reason: matches.length === 0 ? "not_found" : "ambiguous",
    };
  }
  const record = matches[0]!;
  const lease = acquireStateLeaseWithRetry(input.coordRoot, record.path, 2);
  if (!lease) return { state: "generation_unavailable", reason: "busy" };
  try {
    const state = readProducerState(record.path);
    if (
      state.instance_id !== input.instance_id ||
      state.generation_id !== input.generation_id ||
      state.terminal
    ) {
      return { state: "generation_unavailable", reason: "authority_changed" };
    }
    const rootId = control.genesis.event.scope.root_id as `root_${string}`;
    const salvageInput: RecordHookSignalV3Input = {
      coordRoot: input.coordRoot,
      mode: input.mode,
      signal: "stop",
      payload: { raw: {} },
      adapter: state.adapter,
      instance_id: state.instance_id,
      producer_id: "prd_agent-finalizer",
      build_id: input.build_id,
      platform: input.platform,
      writerOptions: input.writerOptions,
    };
    if (state.pending) {
      const pendingEvent = state.pending.event;
      writeEventV3(input.coordRoot, pendingEvent, input.writerOptions);
      applyCommittedEvent(state, pendingEvent);
      state.pending = undefined;
      publishProducerState(record.path, state);
    }
    const allowed = new Set(input.allowed_span_ids);
    const fingerprintContext = fingerprintContextV3(
      input.coordRoot,
      rootId,
      state.generation_id,
      state.privacy_epoch_id,
    );
    // Salvage runs outside the hook producer chain: a fresh boot starting at
    // sequence 1 keeps the reader's per-(producer, boot) continuity intact.
    const salvageBoot = `boot_${randomUUID()}` as `boot_${string}`;
    let salvageSequence = 1;
    let closed = 0;
    for (const span of [...state.spans]) {
      if (!allowed.has(span.span_id)) continue;
      if (!span.turn_id) {
        // An unstamped span still needs a turn scope; the requested turn is
        // the only honest owner the explicit end named, and a salvage-scoped
        // synthetic id is the last resort.
        span.turn_id =
          input.requested_turn_id ??
          (`tid_${normalizeNativeIdV3(
            fingerprintContext,
            `${state.adapter}.turn`,
            `salvage:${span.span_id}`,
          ).slice(4)}` as `tid_${string}`);
      }
      const event = buildDerivedToolCompleted(
        salvageInput,
        state,
        rootId,
        span,
        "explicit_end_salvage",
        { producer_id: "prd_agent-finalizer", boot_id: salvageBoot, sequence: salvageSequence },
        input.observed_at,
      );
      salvageSequence += 1;
      commitEventLocked(salvageInput, state, record.path, event);
      closed += 1;
    }
    return { state: "salvaged", closed };
  } finally {
    lease.release();
  }
}

export function listHookProducerStateRecordsV3(
  coordRoot: string,
  options: { includeTerminal?: boolean } = {},
): HookProducerStateRecordV3[] {
  const control = readEventV3ControlState(coordRoot);
  if (control.state !== "candidate" && control.state !== "active") return [];
  const producerRoot = join(resolve(coordRoot), EVENT_V3_LEDGER_RELATIVE_ROOT, "private-producers");
  if (!existsSync(producerRoot)) return [];
  const records: HookProducerStateRecordV3[] = [];
  for (const adapter of ["claude-code", "codex", "cursor"] as const) {
    const directory = join(producerRoot, adapter);
    if (!existsSync(directory)) continue;
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("V3 producer state directory is unsafe");
    }
    for (const name of readdirSync(directory).filter((entry) =>
      /^hid_[a-f0-9]{64}\.json$/.test(entry),
    )) {
      const path = join(directory, name);
      const state = readProducerState(path);
      if (!options.includeTerminal && state.terminal) continue;
      records.push({ path, modified_at_ms: lstatSync(path).mtimeMs, state });
    }
  }
  return records.sort(
    (left, right) =>
      left.state.generation_id.localeCompare(right.state.generation_id) ||
      left.path.localeCompare(right.path),
  );
}

function hookSignalCapability(signal: HookSignalV3): AdapterSignalV3 {
  switch (signal) {
    case "session-start":
      return "session_start";
    case "session-end":
      return "session_end";
    case "user-prompt-submit":
      return "prompt";
    case "stop":
    case "stop-failure":
      return "turn_completion";
    case "pre-tool-use":
      return "tool_request";
    case "post-tool-use":
      return "tool_result";
    case "post-tool-use-failure":
      return "tool_failure";
    case "permission-request":
      return "permission";
    case "sub-agent-start":
    case "sub-agent-stop":
      return "subagent";
    case "pre-compact":
      return "pre_compaction";
    case "post-compact":
      return "post_compaction";
  }
}

export function readHookProducerStateV3(
  coordRoot: string,
  adapter: Adapter,
  nativeSessionId: string,
): HookProducerStateV3 | undefined {
  const control = readEventV3ControlState(coordRoot);
  if (control.state !== "candidate" && control.state !== "active") return undefined;
  const rootId = control.genesis.event.scope.root_id as `root_${string}`;
  const context = fingerprintContextV3(
    coordRoot,
    rootId,
    undefined,
    control.genesis.profile.privacy_key_epoch,
  );
  const sessionHash = normalizeNativeIdV3(context, `${adapter}.session`, nativeSessionId);
  const path = producerStatePath(coordRoot, adapter, sessionHash);
  return existsSync(path) ? readProducerState(path) : undefined;
}

export function readHookProducerStateByInstanceV3(
  coordRoot: string,
  instanceId: `inst_${string}`,
): HookProducerStateV3 | undefined {
  const control = readEventV3ControlState(coordRoot);
  if (control.state !== "candidate" && control.state !== "active") return undefined;
  const producerRoot = join(resolve(coordRoot), EVENT_V3_LEDGER_RELATIVE_ROOT, "private-producers");
  if (!existsSync(producerRoot)) return undefined;
  const matches: HookProducerStateV3[] = [];
  for (const adapter of ["claude-code", "codex", "cursor"] as const) {
    const directory = join(producerRoot, adapter);
    if (!existsSync(directory)) continue;
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("V3 producer state directory is unsafe");
    }
    for (const name of readdirSync(directory).filter((entry) =>
      /^hid_[a-f0-9]{64}\.json$/.test(entry),
    )) {
      const state = readProducerState(join(directory, name));
      if (state.instance_id === instanceId && !state.terminal) matches.push(state);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function newProducerState(
  input: RecordHookSignalV3Input,
  sessionId: `sid_${string}`,
  epochId: `pep_${string}`,
  boundaryEventId: `evt_${string}`,
): HookProducerStateV3 {
  const bootId = `boot_${randomUUID()}` as const;
  return {
    format: STATE_FORMAT,
    format_version: STATE_VERSION,
    adapter: input.adapter,
    instance_id: input.instance_id,
    session_id: sessionId,
    generation_id: generationIdV3(),
    attestation_id: attestationIdV3(),
    capability_profile: adapterCapabilityProfileDigestV3(input.adapter),
    privacy_epoch_id: epochId,
    boot_id: bootId,
    clock_id: clockIdV3(),
    next_sequence: 1,
    tool_call_count: 0,
    last_event_id: boundaryEventId,
    session_span: openSpanStateV3({
      span_id: spanIdV3(),
      boot_id: bootId,
      clock: signalClock(input),
    }),
    terminal: false,
    spans: [],
    delegations: [],
    closed_spans: [],
    waits: [],
    turn_harness: emptyTurnHarnessTiming(),
    turn_ordinal: 0,
  };
}

function applyCommittedEvent(state: HookProducerStateV3, event: EventV3): void {
  // Sequence continuity is keyed on (producer_id, boot_id): only events that
  // ride the state's own producer chain advance it. Finalizer-authored events
  // (fresh boot, sequence 1) must not create gaps in the hook chain.
  if (event.producer.boot_id === state.boot_id) state.next_sequence += 1;
  if (event.time.monotonic_ns) state.last_monotonic_ns = event.time.monotonic_ns;
  state.last_event_id = event.event_id as `evt_${string}`;
  if (event.event_type === "session.started") {
    state.started_event_id = event.event_id as `evt_${string}`;
    state.session_span.open_event_id = event.event_id as `evt_${string}`;
  }
  if (event.event_type === "turn.started") {
    const nextTurnId = (event.scope as { turn_id: `tid_${string}` }).turn_id;
    state.current_turn_id = nextTurnId;
    if (state.tool_call_count_turn_id !== nextTurnId) {
      state.tool_call_count = 0;
      state.tool_call_count_turn_id = nextTurnId;
    }
    if (state.current_turn_span) {
      state.current_turn_span.open_event_id = event.event_id as `evt_${string}`;
    }
    state.turn_ordinal += 1;
    state.closed_spans = state.closed_spans.filter(
      (closed) => closed.turn_ordinal >= state.turn_ordinal - CLOSED_SPAN_TURN_RETENTION,
    );
  }
  if (event.event_type === "tool.requested") {
    const requestTurnId = (event.scope as { turn_id: `tid_${string}` }).turn_id;
    if (state.tool_call_count_turn_id !== requestTurnId) {
      state.tool_call_count = 0;
      state.tool_call_count_turn_id = requestTurnId;
    }
    state.tool_call_count += 1;
  }
  if (event.event_type === "wait.started") {
    const waitId = (event.payload as { wait_id: `hid_${string}` }).wait_id;
    const turnId = (event.scope as { turn_id: `tid_${string}` }).turn_id;
    const waitLinks = event.links as {
      span_id: `span_${string}`;
      parent_span_id?: `span_${string}`;
    };
    if (!state.waits.some((wait) => wait.wait_id === waitId)) {
      state.waits.push({
        wait_id: waitId,
        started_event_id: event.event_id as `evt_${string}`,
        turn_id: turnId,
        span_id: waitLinks.span_id,
        ...(waitLinks.parent_span_id ? { parent_span_id: waitLinks.parent_span_id } : {}),
        opened_at: event.time.observed_at,
        boot_id: state.boot_id,
        ...(event.time.monotonic_ns ? { opened_monotonic_ns: event.time.monotonic_ns } : {}),
        open_event_id: event.event_id as `evt_${string}`,
      });
    }
  }
  if (event.event_type === "wait.ended") {
    const waitId = (event.payload as { wait_id: string }).wait_id;
    state.waits = state.waits.filter((wait) => wait.wait_id !== waitId);
  }
  if (event.event_type === "tool.completed") {
    const completedSpan = (event.links as { span_id: `span_${string}` }).span_id;
    const closing = state.spans.find((span) => span.span_id === completedSpan);
    if (closing) {
      state.closed_spans.push({
        source_id: closing.source_id,
        ...(closing.semantic_key ? { semantic_key: closing.semantic_key } : {}),
        span_id: closing.span_id,
        closed_event_id: event.event_id as `evt_${string}`,
        turn_ordinal: state.turn_ordinal,
      });
      if (state.closed_spans.length > CLOSED_SPAN_MEMORY_CAP) {
        state.closed_spans = state.closed_spans.slice(-CLOSED_SPAN_MEMORY_CAP);
      }
    }
    state.spans = state.spans.filter((span) => span.span_id !== completedSpan);
  }
  if (event.event_type === "agent.completed") {
    const completedDelegation = event.payload.delegation_id;
    state.delegations = state.delegations.filter(
      (delegation) => delegation.delegation_id !== completedDelegation,
    );
  }
  if (event.event_type === "agent.started") {
    const openedDelegation = state.delegations.find(
      (candidate) => candidate.delegation_id === event.payload.delegation_id,
    );
    if (openedDelegation) openedDelegation.open_event_id = event.event_id as `evt_${string}`;
  }
  if (event.event_type === "turn.completed") {
    state.current_turn_id = undefined;
    state.current_turn_span = undefined;
    state.tool_call_count = 0;
    state.tool_call_count_turn_id = undefined;
    state.turn_harness = emptyTurnHarnessTiming();
  }
  if (event.event_type === "session.ended") state.terminal = true;
}

function unpairableTool(
  input: RecordHookSignalV3Input,
  sessionHash: `hid_${string}`,
  reason: "missing_tool_use_id" | "no_open_span",
): RecordHookSignalV3Result {
  writeProducerDiagnosticV3(input.coordRoot, "unpairable_tool", {
    reason,
    adapter: input.adapter,
    instance_id: input.instance_id,
    signal: input.signal,
    session_hash: sessionHash,
    payload: input.payload,
  });
  return { state: "unpairable_tool", reason };
}

function sourceIdForSignal(
  input: RecordHookSignalV3Input,
  context: ReturnType<typeof fingerprintContextV3>,
): `hid_${string}` | undefined {
  const toolSignal =
    input.signal === "pre-tool-use" ||
    input.signal === "post-tool-use" ||
    input.signal === "post-tool-use-failure";
  const subagentSignal = input.signal === "sub-agent-start" || input.signal === "sub-agent-stop";
  const native = toolSignal
    ? input.payload.tool_use_id
    : subagentSignal
      ? (input.payload.subagent_id ?? input.payload.agent_id)
      : (input.payload.turn_id ??
        (input.signal === "session-start"
          ? (input.payload.session_id ?? input.payload.conversation_id ?? input.payload.agent_id)
          : undefined));
  return native
    ? normalizeNativeIdV3(
        context,
        `${input.adapter}.hook-source`,
        `${toolSignal ? "tool" : subagentSignal ? "subagent" : input.signal}:${native}`,
      )
    : undefined;
}

function cursorShellSemanticKey(
  input: RecordHookSignalV3Input,
  context: ReturnType<typeof fingerprintContextV3>,
): `hid_${string}` | undefined {
  if (input.adapter !== "cursor") return undefined;
  const command = extractBashCommand(input.payload.tool_name, input.payload.tool_input);
  return command
    ? normalizeNativeIdV3(context, "cursor.shell-operation", command.normalize("NFC"))
    : undefined;
}

function cursorShellFallbackSourceId(
  semanticKey: `hid_${string}`,
  state: HookProducerStateV3,
  context: ReturnType<typeof fingerprintContextV3>,
): `hid_${string}` {
  return normalizeNativeIdV3(
    context,
    "cursor.hook-source",
    `shell:${semanticKey}:${state.turn_ordinal}:${state.tool_call_count}`,
  );
}

function closeResolvedWaits(
  input: RecordHookSignalV3Input,
  state: HookProducerStateV3,
  path: string,
  rootId: `root_${string}`,
  fingerprintContext: ReturnType<typeof fingerprintContextV3>,
  nativeTid: `tid_${string}` | undefined,
): void {
  const toolResolution =
    input.signal === "pre-tool-use" ||
    input.signal === "post-tool-use" ||
    input.signal === "post-tool-use-failure";
  const resolvedWaitId = toolResolution ? waitIdForInput(input, fingerprintContext) : undefined;
  const endingTurnId =
    input.signal === "stop" || input.signal === "stop-failure"
      ? (nativeTid ?? state.current_turn_id)
      : undefined;
  let waits = state.waits.filter(
    (wait) => wait.wait_id === resolvedWaitId || wait.turn_id === endingTurnId,
  );
  if (endingTurnId && waits.length === 0) waits = [...state.waits];
  if (toolResolution && waits.length === 0 && state.current_turn_id) {
    const turnWaits = state.waits.filter((wait) => wait.turn_id === state.current_turn_id);
    if (turnWaits.length === 1) waits = turnWaits;
  }
  for (const wait of waits) {
    const outcome = endingTurnId
      ? "interrupted"
      : input.signal === "post-tool-use-failure"
        ? "denied"
        : "succeeded";
    const event = buildEventV3("wait.ended", {
      producer: {
        producer_id: input.producer_id,
        boot_id: state.boot_id,
        sequence: state.next_sequence,
        component: "agent-hook",
        build_id: input.build_id,
        platform: input.platform,
        ...(input.bridge ? { bridge: input.bridge } : {}),
      },
      scope: {
        root_id: rootId,
        instance_id: state.instance_id,
        session_id: state.session_id,
        generation_id: state.generation_id,
        turn_id: wait.turn_id,
        ...(input.run_id ? { run_id: input.run_id } : {}),
        ...(input.workflow_id ? { workflow_id: input.workflow_id } : {}),
        ...(input.workflow_agent_id ? { workflow_agent_id: input.workflow_agent_id } : {}),
      },
      attestation_id: state.attestation_id,
      links: { caused_by: [wait.started_event_id] },
      provenance: {
        source_event: `${input.adapter}.permission-resolution`,
        attestation: "derived",
        confidence: "high",
        attribution: {
          method: "native_payload",
          state: "verified",
          subject_instance_id: state.instance_id,
        },
      },
      monotonic_ns: orderedEventMonotonic(state, input.monotonic_ns),
      clock_id: state.clock_id,
      payload: {
        wait_id: wait.wait_id,
        outcome,
        resolution_reference: endingTurnId ? "turn_terminal" : input.signal,
        span: closeSpanStateV3(wait, {
          boot_id: state.boot_id,
          clock: signalClock(input),
        }),
      },
    }) as EventV3;
    commitEventLocked(input, state, path, event);
  }
}

function waitIdForInput(
  input: RecordHookSignalV3Input,
  fingerprintContext: ReturnType<typeof fingerprintContextV3>,
): `hid_${string}` | undefined {
  return input.payload.tool_use_id
    ? normalizeNativeIdV3(fingerprintContext, `${input.adapter}.wait`, input.payload.tool_use_id)
    : undefined;
}

function signalClock(
  input: Pick<RecordHookSignalV3Input, "observed_at" | "monotonic_ns">,
): SpanClockV3 {
  return {
    observed_at: input.observed_at ?? new Date().toISOString(),
    ...(input.monotonic_ns ? { monotonic_ns: input.monotonic_ns } : {}),
  };
}

function durationMilliseconds(
  start: string | undefined,
  end: string | undefined,
): number | undefined {
  if (!start || !end || !/^\d+$/.test(start) || !/^\d+$/.test(end)) return undefined;
  const delta = BigInt(end) - BigInt(start);
  if (delta < 0n) return undefined;
  const milliseconds = Number(delta / 1_000_000n);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function safeRole(value: unknown): string {
  if (typeof value !== "string") return "agent";
  const normalized = value
    .normalize("NFC")
    .replace(/[^a-zA-Z0-9._:/+-]/g, "_")
    .slice(0, 128);
  return /^[a-zA-Z0-9]/.test(normalized) ? normalized : "agent";
}

function producerStatePath(
  coordRoot: string,
  adapter: Adapter,
  sessionHash: `hid_${string}`,
): string {
  return join(
    resolve(coordRoot),
    EVENT_V3_LEDGER_RELATIVE_ROOT,
    "private-producers",
    adapter,
    `${sessionHash}.json`,
  );
}

function acquireStateLease(coordRoot: string, statePath: string) {
  const directory = join(statePath, "..");
  const producerRoot = join(resolve(coordRoot), EVENT_V3_LEDGER_RELATIVE_ROOT, "private-producers");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(producerRoot, 0o700);
  chmodSync(directory, 0o700);
  return acquireNoClobberLease({
    path: `${statePath}.lease`,
    scope: "event-v3-hook-producer",
    authoritySha256: createHash("sha256")
      .update(resolve(coordRoot))
      .update("\0")
      .update(statePath)
      .digest("hex"),
    staleAfterMs: 5_000,
    validateStaleOwner: (owner) => owner.host === hostname() && !pidIsAlive(owner.pid),
  });
}

function publishProducerState(path: string, state: HookProducerStateV3): void {
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

function readProducerState(path: string): HookProducerStateV3 {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("V3 producer state path is unsafe");
  }
  if ((metadata.mode & 0o077) !== 0) throw new Error("V3 producer state is not owner-only");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("V3 producer state is unreadable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("V3 producer state is invalid");
  }
  const state = parsed as HookProducerStateV3;
  // In-place additive upgrade from format 1 (pre-ADR-0078): the new fields
  // default empty; an old build reading a version-2 file still throws, and its
  // signal is already durable in the intake spool.
  if ((state as { format_version: number }).format_version === 1 && state.format === STATE_FORMAT) {
    state.format_version = STATE_VERSION;
    state.closed_spans ??= [];
    state.turn_ordinal ??= 0;
  }
  // Additive format-2 state: existing files predate wait tracking but remain
  // valid and acquire an empty set on their next read.
  state.waits ??= [];
  state.turn_harness ??= emptyTurnHarnessTiming();
  const allowedKeys = new Set([
    "adapter",
    "attestation_id",
    "boot_id",
    "capability_profile",
    "clock_id",
    "closed_spans",
    "current_turn_id",
    "current_turn_span",
    "delegations",
    "format",
    "format_version",
    "generation_id",
    "instance_id",
    "last_event_id",
    "last_monotonic_ns",
    "next_sequence",
    "pending",
    "privacy_epoch_id",
    "session_id",
    "session_span",
    "spans",
    "started_event_id",
    "terminal",
    "tool_call_count",
    "tool_call_count_turn_id",
    "turn_harness",
    "turn_ordinal",
    "waits",
  ]);
  if (
    Object.keys(state).some((key) => !allowedKeys.has(key)) ||
    state.format !== STATE_FORMAT ||
    state.format_version !== STATE_VERSION ||
    !["claude-code", "codex", "cursor"].includes(state.adapter) ||
    !/^inst_[a-zA-Z0-9._-]{1,128}$/.test(state.instance_id) ||
    !/^sid_[a-f0-9]{64}$/.test(state.session_id) ||
    !/^gen_[0-9a-f-]{36}$/.test(state.generation_id) ||
    !/^att_[0-9a-f-]{36}$/.test(state.attestation_id) ||
    !/^cap_[a-f0-9]{64}$/.test(state.capability_profile) ||
    !/^pep_[a-zA-Z0-9._-]+$/.test(state.privacy_epoch_id) ||
    !/^boot_[a-zA-Z0-9._-]+$/.test(state.boot_id) ||
    !/^clk_[0-9a-f-]{36}$/.test(state.clock_id) ||
    !Number.isSafeInteger(state.next_sequence) ||
    state.next_sequence < 1 ||
    !Number.isSafeInteger(state.tool_call_count) ||
    state.tool_call_count < 0 ||
    (state.tool_call_count_turn_id !== undefined &&
      !/^tid_[a-f0-9]{64}$/.test(state.tool_call_count_turn_id)) ||
    !validTurnHarnessTiming(state.turn_harness) ||
    !validOpenSpanState(state.session_span) ||
    (state.current_turn_span !== undefined && !validOpenSpanState(state.current_turn_span)) ||
    typeof state.terminal !== "boolean" ||
    !Array.isArray(state.spans) ||
    !Array.isArray(state.delegations) ||
    state.delegations.length > 256 ||
    state.delegations.some(
      (delegation) =>
        !/^hid_[a-f0-9]{64}$/.test(delegation.source_id) ||
        !/^del_[0-9a-f-]{36}$/.test(delegation.delegation_id) ||
        !/^gen_[0-9a-f-]{36}$/.test(delegation.child_generation_id) ||
        !validOpenSpanState(delegation) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(delegation.role),
    ) ||
    state.spans.length > 256 ||
    state.spans.some(
      (span) =>
        !/^hid_[a-f0-9]{64}$/.test(span.source_id) ||
        !validOpenSpanState(span) ||
        (span.recovery_reason !== undefined &&
          !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(span.recovery_reason)) ||
        (span.turn_id !== undefined && !/^tid_[a-f0-9]{64}$/.test(span.turn_id)) ||
        (span.turn_stamp !== undefined &&
          span.turn_stamp !== "native_payload" &&
          span.turn_stamp !== "producer_state") ||
        (span.requested_event_id !== undefined &&
          !/^evt_[0-9a-f-]{36}$/.test(span.requested_event_id)) ||
        (span.semantic_key !== undefined && !/^hid_[a-f0-9]{64}$/.test(span.semantic_key)) ||
        (span.tool_name !== undefined &&
          !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(span.tool_name)),
    ) ||
    !Array.isArray(state.closed_spans) ||
    state.closed_spans.length > CLOSED_SPAN_MEMORY_CAP ||
    state.closed_spans.some(
      (closed) =>
        !/^hid_[a-f0-9]{64}$/.test(closed.source_id) ||
        (closed.semantic_key !== undefined && !/^hid_[a-f0-9]{64}$/.test(closed.semantic_key)) ||
        !/^span_[0-9a-f-]{36}$/.test(closed.span_id) ||
        !/^evt_[0-9a-f-]{36}$/.test(closed.closed_event_id) ||
        !Number.isSafeInteger(closed.turn_ordinal) ||
        closed.turn_ordinal < 0,
    ) ||
    !Array.isArray(state.waits) ||
    state.waits.length > 256 ||
    state.waits.some(
      (wait) =>
        !/^hid_[a-f0-9]{64}$/.test(wait.wait_id) ||
        !/^evt_[0-9a-f-]{36}$/.test(wait.started_event_id) ||
        !/^tid_[a-f0-9]{64}$/.test(wait.turn_id) ||
        !validOpenSpanState(wait),
    ) ||
    !Number.isSafeInteger(state.turn_ordinal) ||
    state.turn_ordinal < 0 ||
    (state.current_turn_id !== undefined && !/^tid_[a-f0-9]{64}$/.test(state.current_turn_id)) ||
    (state.last_event_id !== undefined && !/^evt_[0-9a-f-]{36}$/.test(state.last_event_id)) ||
    (state.last_monotonic_ns !== undefined && !/^\d+$/.test(state.last_monotonic_ns)) ||
    (state.started_event_id !== undefined && !/^evt_[0-9a-f-]{36}$/.test(state.started_event_id)) ||
    (state.pending?.source_id !== undefined &&
      !/^hid_[a-f0-9]{64}$/.test(state.pending.source_id)) ||
    (state.pending && !validateEventV3(state.pending.event).ok)
  ) {
    throw new Error("V3 producer state is invalid");
  }
  return state;
}

function recordTurnHarnessTiming(state: HookProducerStateV3, input: RecordHookSignalV3Input): void {
  if (input.signal === "user-prompt-submit") state.turn_harness = emptyTurnHarnessTiming();
  if (
    input.hook_duration_ms === undefined ||
    (!state.current_turn_id && input.signal !== "user-prompt-submit")
  ) {
    return;
  }
  const duration = Math.max(0, Math.floor(input.hook_duration_ms));
  if (!Number.isSafeInteger(duration)) return;
  const hook = safeRole(input.hook_name ?? input.signal);
  state.turn_harness = {
    hook_time_ms: state.turn_harness.hook_time_ms + duration,
    hook_count: state.turn_harness.hook_count + 1,
    slowest_hook:
      duration >= state.turn_harness.slowest_hook_ms ? hook : state.turn_harness.slowest_hook,
    slowest_hook_ms: Math.max(duration, state.turn_harness.slowest_hook_ms),
  };
}

/**
 * Concurrent hook processes can acquire the session lease in a different
 * order from their clock capture. Preserve raw readings in span state for
 * pairing, but omit an out-of-order reading from the producer event chain so
 * a valid global clock is never asserted falsely.
 */
function orderedEventMonotonic(
  state: HookProducerStateV3,
  candidate: string | undefined,
): string | undefined {
  if (!candidate || !/^\d+$/.test(candidate)) return undefined;
  if (!state.last_monotonic_ns) return candidate;
  return BigInt(candidate) < BigInt(state.last_monotonic_ns) ? undefined : candidate;
}

function emptyTurnHarnessTiming(): TurnHarnessTimingV3 {
  return { hook_time_ms: 0, hook_count: 0, slowest_hook_ms: 0 };
}

function validOpenSpanState(value: OpenSpanStateV3 | undefined): boolean {
  return Boolean(
    value &&
      /^span_[0-9a-f-]{36}$/.test(value.span_id) &&
      (value.parent_span_id === undefined || /^span_[0-9a-f-]{36}$/.test(value.parent_span_id)) &&
      Number.isFinite(Date.parse(value.opened_at)) &&
      /^boot_[a-zA-Z0-9._-]+$/.test(value.boot_id) &&
      (value.opened_monotonic_ns === undefined || /^\d+$/.test(value.opened_monotonic_ns)) &&
      (value.open_event_id === undefined || /^evt_[0-9a-f-]{36}$/.test(value.open_event_id)),
  );
}

function validTurnHarnessTiming(value: TurnHarnessTimingV3): boolean {
  return (
    Number.isSafeInteger(value.hook_time_ms) &&
    value.hook_time_ms >= 0 &&
    Number.isSafeInteger(value.hook_count) &&
    value.hook_count >= 0 &&
    Number.isSafeInteger(value.slowest_hook_ms) &&
    value.slowest_hook_ms >= 0 &&
    (value.slowest_hook === undefined ||
      /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(value.slowest_hook))
  );
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
