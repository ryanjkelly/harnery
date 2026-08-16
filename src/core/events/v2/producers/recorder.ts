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
import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import type { Adapter } from "../../../hooks/events/schema.ts";
import { fsyncParentDirectory } from "../../../workflow/durable-record.ts";
import { acquireNoClobberLease } from "../../../workflow/workspaces/leases.ts";
import { normalizeNativeIdV2 } from "../canonical.ts";
import { adapterCapabilityProfileDigestV2 } from "../capabilities.ts";
import type { EventV2 } from "../contract.ts";
import { type EventV2WriteMode, readEventV2ControlState } from "../control.ts";
import { fingerprintContextV2 } from "../fingerprint-keys.ts";
import { attestationIdV2, clockIdV2, generationIdV2, spanIdV2 } from "../ids.ts";
import { assertEventV2, validateEventV2 } from "../validate.ts";
import { type WriteEventV2Options, type WriteEventV2Result, writeEventV2 } from "../writer.ts";
import { type HookSignalV2, normalizeHookEventV2 } from "./hook.ts";

const STATE_FORMAT = "harnery-v2-hook-producer" as const;
const STATE_VERSION = 1 as const;

interface SpanStateV2 {
  source_id: `hid_${string}`;
  span_id: `span_${string}`;
  started_monotonic_ns?: string;
}

interface PendingEventV2 {
  source_id?: `hid_${string}`;
  event: EventV2;
}

export interface HookProducerStateV2 {
  format: typeof STATE_FORMAT;
  format_version: typeof STATE_VERSION;
  adapter: Adapter;
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
  last_event_id?: `evt_${string}`;
  started_event_id?: `evt_${string}`;
  terminal: boolean;
  spans: SpanStateV2[];
  pending?: PendingEventV2;
}

export interface RecordHookSignalV2Input {
  coordRoot: string;
  mode: EventV2WriteMode;
  signal: HookSignalV2;
  payload: ParsedPayload;
  adapter: Adapter;
  instance_id: `inst_${string}`;
  producer_id: `prd_${string}`;
  build_id: `build_${string}`;
  platform: "linux" | "windows" | "macos" | "unknown";
  bridge?: "codex-wsl";
  adapterVersion?: string;
  harnessVersion?: string;
  monotonic_ns?: string;
  writerOptions?: WriteEventV2Options;
}

export type RecordHookSignalV2Result =
  | { state: "gate_closed"; reason: string }
  | { state: "missing_session_start" }
  | { state: "already_started"; event_id: string }
  | { state: "unpairable_tool" }
  | { state: "ignored" }
  | { state: "recorded"; event: EventV2; durability: WriteEventV2Result; recovered: boolean };

/**
 * Record one hook signal through a private, crash-recoverable producer state file.
 * The function is inert unless the exact requested candidate or active gate is open.
 */
export function recordHookSignalV2(input: RecordHookSignalV2Input): RecordHookSignalV2Result {
  const control = readEventV2ControlState(input.coordRoot);
  if (control.state !== input.mode) {
    return { state: "gate_closed", reason: control.state };
  }
  const rootId = control.genesis.event.scope.root_id as `root_${string}`;
  const epochId = control.genesis.profile.privacy_key_epoch;
  const boundaryEventId =
    control.state === "candidate"
      ? control.genesis.event.event_id
      : control.activation.event.event_id;
  const expectedCapabilityDigest = `sha256:${adapterCapabilityProfileDigestV2(input.adapter).slice(4)}`;
  if (
    !control.genesis.profile.adapter_capability_profile_digests.includes(expectedCapabilityDigest)
  ) {
    return { state: "gate_closed", reason: "capability_profile_not_approved" };
  }
  const rootFingerprintContext = fingerprintContextV2(input.coordRoot, rootId, undefined, epochId);
  const nativeSession =
    input.payload.session_id ??
    input.payload.conversation_id ??
    input.payload.agent_id ??
    input.instance_id;
  const sessionHash = normalizeNativeIdV2(
    rootFingerprintContext,
    `${input.adapter}.session`,
    nativeSession,
  );
  const sessionId = `sid_${sessionHash.slice(4)}` as `sid_${string}`;
  const path = producerStatePath(input.coordRoot, input.adapter, sessionHash);
  const lease = acquireStateLease(input.coordRoot, path);
  try {
    let state = existsSync(path) ? readProducerState(path) : undefined;
    if (
      state &&
      (state.adapter !== input.adapter ||
        state.session_id !== sessionId ||
        state.privacy_epoch_id !== epochId ||
        state.capability_profile !== adapterCapabilityProfileDigestV2(input.adapter))
    ) {
      throw new Error("V2 producer state authority does not match the active boundary");
    }
    let recovered: RecordHookSignalV2Result | undefined;
    if (state?.pending) {
      const pendingSource = state.pending.source_id;
      const incomingSource = sourceIdForSignal(input, rootFingerprintContext);
      const pendingEvent = state.pending.event;
      const durability = writeEventV2(input.coordRoot, pendingEvent);
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
      return { state: "missing_session_start" };
    }

    const fingerprintContext = fingerprintContextV2(
      input.coordRoot,
      rootId,
      state.generation_id,
      state.privacy_epoch_id,
    );
    const sourceId = sourceIdForSignal(input, rootFingerprintContext);
    let span: SpanStateV2 | undefined;
    if (input.signal === "pre-tool-use") {
      if (!sourceId) return { state: "unpairable_tool" };
      span = state.spans.find((candidate) => candidate.source_id === sourceId);
      if (!span) {
        span = {
          source_id: sourceId,
          span_id: spanIdV2(),
          ...(input.monotonic_ns ? { started_monotonic_ns: input.monotonic_ns } : {}),
        };
        state.spans.push(span);
      }
    } else if (input.signal === "post-tool-use" || input.signal === "post-tool-use-failure") {
      if (!sourceId) return { state: "unpairable_tool" };
      span = state.spans.find((candidate) => candidate.source_id === sourceId);
      if (!span) return { state: "unpairable_tool" };
    }

    const event = normalizeHookEventV2(input.signal, input.payload, {
      coordRoot: input.coordRoot,
      adapter: input.adapter,
      adapterVersion: input.adapterVersion,
      harnessVersion: input.harnessVersion,
      root_id: rootId,
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
      span_id: span?.span_id,
      caused_by: state.last_event_id ? [state.last_event_id] : [],
      monotonic_ns: input.monotonic_ns,
      clock_id: state.clock_id,
      duration_ms: durationMilliseconds(span?.started_monotonic_ns, input.monotonic_ns),
      tool_call_count: state.tool_call_count,
    });
    if (!event) return { state: "ignored" };
    assertEventV2(event);

    state.pending = { ...(sourceId ? { source_id: sourceId } : {}), event };
    publishProducerState(path, state);
    const durability = writeEventV2(input.coordRoot, event, input.writerOptions);
    applyCommittedEvent(state, event);
    state.pending = undefined;
    publishProducerState(path, state);
    return { state: "recorded", event, durability, recovered: false };
  } finally {
    lease.release();
  }
}

export function readHookProducerStateV2(
  coordRoot: string,
  adapter: Adapter,
  nativeSessionId: string,
): HookProducerStateV2 | undefined {
  const control = readEventV2ControlState(coordRoot);
  if (control.state !== "candidate" && control.state !== "active") return undefined;
  const rootId = control.genesis.event.scope.root_id as `root_${string}`;
  const context = fingerprintContextV2(
    coordRoot,
    rootId,
    undefined,
    control.genesis.profile.privacy_key_epoch,
  );
  const sessionHash = normalizeNativeIdV2(context, `${adapter}.session`, nativeSessionId);
  const path = producerStatePath(coordRoot, adapter, sessionHash);
  return existsSync(path) ? readProducerState(path) : undefined;
}

function newProducerState(
  input: RecordHookSignalV2Input,
  sessionId: `sid_${string}`,
  epochId: `pep_${string}`,
  boundaryEventId: `evt_${string}`,
): HookProducerStateV2 {
  return {
    format: STATE_FORMAT,
    format_version: STATE_VERSION,
    adapter: input.adapter,
    session_id: sessionId,
    generation_id: generationIdV2(),
    attestation_id: attestationIdV2(),
    capability_profile: adapterCapabilityProfileDigestV2(input.adapter),
    privacy_epoch_id: epochId,
    boot_id: `boot_${randomUUID()}`,
    clock_id: clockIdV2(),
    next_sequence: 1,
    tool_call_count: 0,
    last_event_id: boundaryEventId,
    terminal: false,
    spans: [],
  };
}

function applyCommittedEvent(state: HookProducerStateV2, event: EventV2): void {
  state.next_sequence += 1;
  state.last_event_id = event.event_id as `evt_${string}`;
  if (event.event_type === "session.started") {
    state.started_event_id = event.event_id as `evt_${string}`;
  }
  if (event.event_type === "turn.started") {
    state.current_turn_id = (event.scope as { turn_id: `tid_${string}` }).turn_id;
  }
  if (event.event_type === "tool.requested") state.tool_call_count += 1;
  if (event.event_type === "tool.completed") {
    const completedSpan = (event.links as { span_id: `span_${string}` }).span_id;
    state.spans = state.spans.filter((span) => span.span_id !== completedSpan);
  }
  if (event.event_type === "turn.completed") {
    state.current_turn_id = undefined;
    state.tool_call_count = 0;
  }
  if (event.event_type === "session.ended") state.terminal = true;
}

function sourceIdForSignal(
  input: RecordHookSignalV2Input,
  context: ReturnType<typeof fingerprintContextV2>,
): `hid_${string}` | undefined {
  const toolSignal =
    input.signal === "pre-tool-use" ||
    input.signal === "post-tool-use" ||
    input.signal === "post-tool-use-failure";
  const native = toolSignal
    ? input.payload.tool_use_id
    : (input.payload.turn_id ??
      (input.signal === "session-start"
        ? (input.payload.session_id ?? input.payload.conversation_id ?? input.payload.agent_id)
        : undefined));
  return native
    ? normalizeNativeIdV2(
        context,
        `${input.adapter}.hook-source`,
        `${toolSignal ? "tool" : input.signal}:${native}`,
      )
    : undefined;
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

function producerStatePath(
  coordRoot: string,
  adapter: Adapter,
  sessionHash: `hid_${string}`,
): string {
  return join(resolve(coordRoot), ".harnery/private/v2-producers", adapter, `${sessionHash}.json`);
}

function acquireStateLease(coordRoot: string, statePath: string) {
  const directory = join(statePath, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(join(resolve(coordRoot), ".harnery/private"), 0o700);
  chmodSync(join(resolve(coordRoot), ".harnery/private/v2-producers"), 0o700);
  chmodSync(directory, 0o700);
  return acquireNoClobberLease({
    path: `${statePath}.lease`,
    scope: "event-v2-hook-producer",
    authoritySha256: createHash("sha256")
      .update(resolve(coordRoot))
      .update("\0")
      .update(statePath)
      .digest("hex"),
    staleAfterMs: 5_000,
    validateStaleOwner: (owner) => owner.host === hostname() && !pidIsAlive(owner.pid),
  });
}

function publishProducerState(path: string, state: HookProducerStateV2): void {
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

function readProducerState(path: string): HookProducerStateV2 {
  if ((statSync(path).mode & 0o077) !== 0) throw new Error("V2 producer state is not owner-only");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("V2 producer state is unreadable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("V2 producer state is invalid");
  }
  const state = parsed as HookProducerStateV2;
  const allowedKeys = new Set([
    "adapter",
    "attestation_id",
    "boot_id",
    "capability_profile",
    "clock_id",
    "current_turn_id",
    "format",
    "format_version",
    "generation_id",
    "last_event_id",
    "next_sequence",
    "pending",
    "privacy_epoch_id",
    "session_id",
    "spans",
    "started_event_id",
    "terminal",
    "tool_call_count",
  ]);
  if (
    Object.keys(state).some((key) => !allowedKeys.has(key)) ||
    state.format !== STATE_FORMAT ||
    state.format_version !== STATE_VERSION ||
    !["claude-code", "codex", "cursor"].includes(state.adapter) ||
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
    typeof state.terminal !== "boolean" ||
    !Array.isArray(state.spans) ||
    state.spans.length > 256 ||
    state.spans.some(
      (span) =>
        !/^hid_[a-f0-9]{64}$/.test(span.source_id) ||
        !/^span_[0-9a-f-]{36}$/.test(span.span_id) ||
        (span.started_monotonic_ns !== undefined && !/^\d+$/.test(span.started_monotonic_ns)),
    ) ||
    (state.current_turn_id !== undefined && !/^tid_[a-f0-9]{64}$/.test(state.current_turn_id)) ||
    (state.last_event_id !== undefined && !/^evt_[0-9a-f-]{36}$/.test(state.last_event_id)) ||
    (state.started_event_id !== undefined && !/^evt_[0-9a-f-]{36}$/.test(state.started_event_id)) ||
    (state.pending?.source_id !== undefined &&
      !/^hid_[a-f0-9]{64}$/.test(state.pending.source_id)) ||
    (state.pending && !validateEventV2(state.pending.event).ok)
  ) {
    throw new Error("V2 producer state is invalid");
  }
  return state;
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
