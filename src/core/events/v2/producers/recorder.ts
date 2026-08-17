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
import { join, resolve } from "node:path";
import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import type { Adapter } from "../../../hooks/events/schema.ts";
import { fsyncParentDirectory } from "../../../workflow/durable-record.ts";
import { acquireNoClobberLease } from "../../../workflow/workspaces/leases.ts";
import { normalizeNativeIdV2 } from "../canonical.ts";
import {
  type AdapterSignalV2,
  adapterCapabilityProfileDigestV2,
  adapterSignalSupportV2,
} from "../capabilities.ts";
import type { EventV2 } from "../contract.ts";
import { type EventV2WriteMode, readEventV2ControlState } from "../control.ts";
import { fingerprintContextV2 } from "../fingerprint-keys.ts";
import { attestationIdV2, clockIdV2, delegationIdV2, generationIdV2, spanIdV2 } from "../ids.ts";
import { assertEventV2, validateEventV2 } from "../validate.ts";
import {
  EVENT_V2_LEDGER_RELATIVE_ROOT,
  type WriteEventV2Options,
  type WriteEventV2Result,
  writeEventV2,
} from "../writer.ts";
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

interface DelegationStateV2 {
  source_id: `hid_${string}`;
  delegation_id: `del_${string}`;
  child_generation_id: `gen_${string}`;
  role: string;
}

export interface HookProducerStateV2 {
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
  last_event_id?: `evt_${string}`;
  started_event_id?: `evt_${string}`;
  terminal: boolean;
  spans: SpanStateV2[];
  delegations: DelegationStateV2[];
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
  const requiredCapability = hookSignalCapability(input.signal);
  if (adapterSignalSupportV2(input.adapter, requiredCapability) === "unsupported") {
    return {
      state: "gate_closed",
      reason: `signal_not_approved:${requiredCapability}`,
    };
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
        state.instance_id !== input.instance_id ||
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
    let delegation: DelegationStateV2 | undefined;
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
    if (input.signal === "sub-agent-start") {
      if (!sourceId) return { state: "ignored" };
      delegation = state.delegations.find((candidate) => candidate.source_id === sourceId);
      if (!delegation) {
        delegation = {
          source_id: sourceId,
          delegation_id: delegationIdV2(),
          child_generation_id: generationIdV2(),
          role: safeRole(input.payload.raw.agent_type),
        };
        state.delegations.push(delegation);
      }
    } else if (input.signal === "sub-agent-stop") {
      if (!sourceId) return { state: "ignored" };
      delegation = state.delegations.find((candidate) => candidate.source_id === sourceId);
      if (!delegation) return { state: "ignored" };
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
      delegation_id: delegation?.delegation_id,
      child_generation_id: delegation?.child_generation_id,
      agent_role: delegation?.role,
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

function hookSignalCapability(signal: HookSignalV2): AdapterSignalV2 {
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

export function readHookProducerStateByInstanceV2(
  coordRoot: string,
  instanceId: `inst_${string}`,
): HookProducerStateV2 | undefined {
  const control = readEventV2ControlState(coordRoot);
  if (control.state !== "candidate" && control.state !== "active") return undefined;
  const producerRoot = join(resolve(coordRoot), EVENT_V2_LEDGER_RELATIVE_ROOT, "private-producers");
  if (!existsSync(producerRoot)) return undefined;
  const matches: HookProducerStateV2[] = [];
  for (const adapter of ["claude-code", "codex", "cursor"] as const) {
    const directory = join(producerRoot, adapter);
    if (!existsSync(directory)) continue;
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("V2 producer state directory is unsafe");
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
  input: RecordHookSignalV2Input,
  sessionId: `sid_${string}`,
  epochId: `pep_${string}`,
  boundaryEventId: `evt_${string}`,
): HookProducerStateV2 {
  return {
    format: STATE_FORMAT,
    format_version: STATE_VERSION,
    adapter: input.adapter,
    instance_id: input.instance_id,
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
    delegations: [],
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
  if (event.event_type === "agent.completed") {
    const completedDelegation = event.payload.delegation_id;
    state.delegations = state.delegations.filter(
      (delegation) => delegation.delegation_id !== completedDelegation,
    );
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
    ? normalizeNativeIdV2(
        context,
        `${input.adapter}.hook-source`,
        `${toolSignal ? "tool" : subagentSignal ? "subagent" : input.signal}:${native}`,
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
    EVENT_V2_LEDGER_RELATIVE_ROOT,
    "private-producers",
    adapter,
    `${sessionHash}.json`,
  );
}

function acquireStateLease(coordRoot: string, statePath: string) {
  const directory = join(statePath, "..");
  const producerRoot = join(resolve(coordRoot), EVENT_V2_LEDGER_RELATIVE_ROOT, "private-producers");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(producerRoot, 0o700);
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
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("V2 producer state path is unsafe");
  }
  if ((metadata.mode & 0o077) !== 0) throw new Error("V2 producer state is not owner-only");
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
    "delegations",
    "format",
    "format_version",
    "generation_id",
    "instance_id",
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
    typeof state.terminal !== "boolean" ||
    !Array.isArray(state.spans) ||
    !Array.isArray(state.delegations) ||
    state.delegations.length > 256 ||
    state.delegations.some(
      (delegation) =>
        !/^hid_[a-f0-9]{64}$/.test(delegation.source_id) ||
        !/^del_[0-9a-f-]{36}$/.test(delegation.delegation_id) ||
        !/^gen_[0-9a-f-]{36}$/.test(delegation.child_generation_id) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(delegation.role),
    ) ||
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
