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
import { join, resolve } from "node:path";
import type { Adapter } from "../../../adapter.ts";
import { fsyncParentDirectory } from "../../../workflow/durable-record.ts";
import { acquireNoClobberLease } from "../../../workflow/workspaces/leases.ts";
import { buildEventV2 } from "../builder.ts";
import { normalizeNativeIdV2 } from "../canonical.ts";
import type { EventV2 } from "../contract.ts";
import { type EventV2WriteMode, readEventV2ControlState } from "../control.ts";
import { fingerprintContextV2 } from "../fingerprint-keys.ts";
import { clockIdV2, spanIdV2 } from "../ids.ts";
import { assertEventV2, validateEventV2 } from "../validate.ts";
import {
  EVENT_V2_LEDGER_RELATIVE_ROOT,
  type WriteEventV2Options,
  type WriteEventV2Result,
  writeEventV2,
} from "../writer.ts";
import {
  type CommandObservationV2,
  type CommandSignalV2,
  normalizeCommandEventV2,
} from "./command.ts";
import { readHookProducerStateByInstanceV2 } from "./recorder.ts";

const COMMAND_STATE_FORMAT = "harnery-v2-command-producer" as const;
const COMMAND_STATE_VERSION = 1 as const;
const MAX_OBSERVATIONS = 512;

interface RecordedCommandObservationV2 {
  source_id: `hid_${string}`;
  event_id: `evt_${string}`;
}

interface PendingCommandEventV2 {
  source_id: `hid_${string}`;
  event: EventV2;
}

interface CommandRecorderStateV2 {
  format: typeof COMMAND_STATE_FORMAT;
  format_version: typeof COMMAND_STATE_VERSION;
  adapter: Adapter;
  instance_id: `inst_${string}`;
  session_id: `sid_${string}`;
  generation_id: `gen_${string}`;
  turn_id: `tid_${string}`;
  attestation_id: `att_${string}`;
  privacy_epoch_id: `pep_${string}`;
  boot_id: `boot_${string}`;
  clock_id: `clk_${string}`;
  span_id: `span_${string}`;
  next_sequence: number;
  last_event_id: `evt_${string}`;
  terminal: boolean;
  observations: RecordedCommandObservationV2[];
  pending?: PendingCommandEventV2;
}

export interface RecordCommandSignalV2Input {
  coordRoot: string;
  mode: EventV2WriteMode;
  signal: CommandSignalV2;
  observation: CommandObservationV2;
  adapter: Adapter;
  instance_id: `inst_${string}`;
  producer_id: `prd_${string}`;
  build_id: `build_${string}`;
  platform: "linux" | "windows" | "macos" | "unknown";
  bridge?: "codex-wsl";
  monotonic_ns?: string;
  writerOptions?: WriteEventV2Options;
}

export type RecordCommandSignalV2Result =
  | { state: "gate_closed"; reason: string }
  | { state: "generation_unavailable"; reason: string }
  | { state: "missing_command_start" }
  | { state: "missing_observation_id" }
  | { state: "already_recorded"; event_id: string }
  | { state: "recorded"; event: EventV2; durability: WriteEventV2Result; recovered: boolean };

/**
 * Join a CLI/session-tee command to an already-started hook generation and
 * record it through its own crash-recoverable producer sequence. This is
 * inert until the exact candidate or active control gate is open.
 */
export function recordCommandSignalV2(
  input: RecordCommandSignalV2Input,
): RecordCommandSignalV2Result {
  const control = readEventV2ControlState(input.coordRoot);
  if (control.state !== input.mode) {
    return { state: "gate_closed", reason: control.state };
  }
  const hook = readHookProducerStateByInstanceV2(input.coordRoot, input.instance_id);
  if (!hook || hook.adapter !== input.adapter) {
    return { state: "generation_unavailable", reason: "hook_generation_not_joinable" };
  }
  if (!hook.current_turn_id) {
    return { state: "generation_unavailable", reason: "turn_not_started" };
  }
  const rootId = control.genesis.event.scope.root_id as `root_${string}`;
  const epochId = control.genesis.profile.privacy_key_epoch;
  const rootContext = fingerprintContextV2(input.coordRoot, rootId, undefined, epochId);
  const commandSource = normalizeNativeIdV2(
    rootContext,
    "session-tee.command",
    `${input.adapter}\0${hook.session_id}\0${input.observation.native_command_id}`,
  );
  const sourceId = observationSourceId(input, rootContext);
  if (!sourceId) return { state: "missing_observation_id" };
  const path = commandStatePath(input.coordRoot, commandSource);
  const lease = acquireCommandLease(input.coordRoot, path);
  try {
    let state = existsSync(path) ? readCommandState(path) : undefined;
    if (state && !matchesHookState(state, hook, input, epochId)) {
      throw new Error("V2 command producer state does not match the joined hook generation");
    }
    let recovered = false;
    if (state?.pending) {
      const pending = state.pending;
      const durability = writeEventV2(input.coordRoot, pending.event);
      applyCommandEvent(state, pending.source_id, pending.event);
      state.pending = undefined;
      publishCommandState(path, state);
      if (pending.source_id === sourceId) {
        return { state: "recorded", event: pending.event, durability, recovered: true };
      }
      recovered = true;
    }
    if (state) {
      const already = state.observations.find((observation) => observation.source_id === sourceId);
      if (already) return { state: "already_recorded", event_id: already.event_id };
    }
    if (input.signal === "command-start") {
      if (state) {
        return {
          state: "already_recorded",
          event_id: state.observations[0]?.event_id ?? state.last_event_id,
        };
      }
      state = newCommandState(input, hook, epochId);
    } else if (!state) {
      return { state: "missing_command_start" };
    }
    if (state.terminal) return { state: "missing_command_start" };

    const fingerprintContext = fingerprintContextV2(
      input.coordRoot,
      rootId,
      state.generation_id,
      state.privacy_epoch_id,
    );
    const event = normalizeCommandEventV2(input.signal, input.observation, {
      root_id: rootId,
      instance_id: state.instance_id,
      session_id: state.session_id,
      generation_id: state.generation_id,
      turn_id: state.turn_id,
      attestation_id: state.attestation_id,
      producer_id: input.producer_id,
      boot_id: state.boot_id,
      sequence: state.next_sequence,
      build_id: input.build_id,
      platform: input.platform,
      bridge: input.bridge,
      span_id: state.span_id,
      caused_by: [state.last_event_id],
      monotonic_ns: input.monotonic_ns,
      clock_id: state.clock_id,
      fingerprintContext,
      attribution_method: "session_env",
    });
    if (!event) return { state: "missing_command_start" };

    state.pending = { source_id: sourceId, event };
    publishCommandState(path, state);
    const durability = writeEventV2(input.coordRoot, event, input.writerOptions);
    applyCommandEvent(state, sourceId, event);
    state.pending = undefined;
    publishCommandState(path, state);
    return { state: "recorded", event, durability, recovered };
  } finally {
    lease.release();
  }
}

export interface CloseAbandonedCommandSpansV2Input {
  coordRoot: string;
  mode: EventV2WriteMode;
  generation_id: `gen_${string}`;
  build_id: `build_${string}`;
  platform: "linux" | "windows" | "macos" | "unknown";
  observed_at: string;
  writerOptions?: WriteEventV2Options;
}

export interface CloseAbandonedCommandSpansV2Result {
  closed: number;
  skipped: number;
}

/**
 * Session-end command closer (ADR 0078): every non-terminal command span of
 * the ending generation gets a derived `command.completed` with an unknown
 * outcome, so a `process.exit` or SIGKILL that outran the CLI's finalize can
 * no longer leave the generation with an unpaired command forever. Command
 * spans never block turns; this exists for corpus honesty and invariant 11.
 */
export function closeAbandonedCommandSpansV2(
  input: CloseAbandonedCommandSpansV2Input,
): CloseAbandonedCommandSpansV2Result {
  const result: CloseAbandonedCommandSpansV2Result = { closed: 0, skipped: 0 };
  const control = readEventV2ControlState(input.coordRoot);
  if (control.state !== input.mode) return result;
  const rootId = control.genesis.event.scope.root_id as `root_${string}`;
  const directory = join(
    resolve(input.coordRoot),
    EVENT_V2_LEDGER_RELATIVE_ROOT,
    "private-producers/session-tee",
  );
  if (!existsSync(directory)) return result;
  for (const name of readdirSync(directory).filter((entry) =>
    /^hid_[a-f0-9]{64}\.json$/.test(entry),
  )) {
    const path = join(directory, name);
    let preview: CommandRecorderStateV2;
    try {
      preview = readCommandState(path);
    } catch {
      result.skipped += 1;
      continue;
    }
    if (preview.generation_id !== input.generation_id || preview.terminal) continue;
    let lease: ReturnType<typeof acquireCommandLease>;
    try {
      lease = acquireCommandLease(input.coordRoot, path);
    } catch {
      result.skipped += 1;
      continue;
    }
    try {
      const state = readCommandState(path);
      if (state.generation_id !== input.generation_id) continue;
      if (state.pending) {
        const pending = state.pending;
        writeEventV2(input.coordRoot, pending.event, input.writerOptions);
        applyCommandEvent(state, pending.source_id, pending.event);
        state.pending = undefined;
        publishCommandState(path, state);
      }
      if (state.terminal) continue;
      const context = fingerprintContextV2(
        input.coordRoot,
        rootId,
        state.generation_id,
        state.privacy_epoch_id,
      );
      const sourceId = normalizeNativeIdV2(
        context,
        "session-tee.observation",
        `recovery:${state.span_id}`,
      );
      const event = buildEventV2("command.completed", {
        producer: {
          producer_id: "prd_agent-finalizer",
          boot_id: `boot_${randomUUID()}`,
          sequence: 1,
          component: "session-tee",
          build_id: input.build_id,
          platform: input.platform,
        },
        scope: {
          root_id: rootId,
          instance_id: state.instance_id,
          session_id: state.session_id,
          generation_id: state.generation_id,
          turn_id: state.turn_id,
        },
        attestation_id: state.attestation_id,
        links: { caused_by: [state.last_event_id], span_id: state.span_id },
        provenance: {
          source_event: "session-tee.recovery",
          attestation: "derived",
          confidence: "medium",
          attribution: {
            method: "session_env",
            state: "verified",
            subject_instance_id: state.instance_id,
          },
        },
        observed_at: input.observed_at,
        clock_id: state.clock_id,
        payload: {
          outcome: "unknown",
          duration_ms: 0,
          recovery: { reason: "command_completion_not_observed" },
        },
      }) as EventV2;
      assertEventV2(event);
      state.pending = { source_id: sourceId, event };
      publishCommandState(path, state);
      writeEventV2(input.coordRoot, event, input.writerOptions);
      applyCommandEvent(state, sourceId, event);
      state.pending = undefined;
      publishCommandState(path, state);
      result.closed += 1;
    } finally {
      lease.release();
    }
  }
  return result;
}

function newCommandState(
  input: RecordCommandSignalV2Input,
  hook: NonNullable<ReturnType<typeof readHookProducerStateByInstanceV2>>,
  epochId: `pep_${string}`,
): CommandRecorderStateV2 {
  return {
    format: COMMAND_STATE_FORMAT,
    format_version: COMMAND_STATE_VERSION,
    adapter: input.adapter,
    instance_id: input.instance_id,
    session_id: hook.session_id,
    generation_id: hook.generation_id,
    turn_id: hook.current_turn_id!,
    attestation_id: hook.attestation_id,
    privacy_epoch_id: epochId,
    boot_id: `boot_${randomUUID()}`,
    clock_id: clockIdV2(),
    span_id: spanIdV2(),
    next_sequence: 1,
    last_event_id: hook.last_event_id!,
    terminal: false,
    observations: [],
  };
}

function matchesHookState(
  state: CommandRecorderStateV2,
  hook: NonNullable<ReturnType<typeof readHookProducerStateByInstanceV2>>,
  input: RecordCommandSignalV2Input,
  epochId: string,
): boolean {
  return (
    state.adapter === input.adapter &&
    state.instance_id === input.instance_id &&
    state.session_id === hook.session_id &&
    state.generation_id === hook.generation_id &&
    state.turn_id === hook.current_turn_id &&
    state.attestation_id === hook.attestation_id &&
    state.privacy_epoch_id === epochId
  );
}

function observationSourceId(
  input: RecordCommandSignalV2Input,
  context: ReturnType<typeof fingerprintContextV2>,
): `hid_${string}` | undefined {
  const nativeObservation =
    input.signal === "command-output"
      ? input.observation.native_observation_id
      : `${input.signal}:${input.observation.native_command_id}`;
  return nativeObservation
    ? normalizeNativeIdV2(context, "session-tee.observation", nativeObservation)
    : undefined;
}

function applyCommandEvent(
  state: CommandRecorderStateV2,
  sourceId: `hid_${string}`,
  event: EventV2,
): void {
  // Only events on the state's own producer chain advance its sequence; the
  // finalizer's derived closer uses a fresh boot at sequence 1.
  if (event.producer.boot_id === state.boot_id) state.next_sequence += 1;
  state.last_event_id = event.event_id as `evt_${string}`;
  state.observations.push({ source_id: sourceId, event_id: event.event_id as `evt_${string}` });
  if (state.observations.length > MAX_OBSERVATIONS) state.observations.shift();
  if (event.event_type === "command.completed") state.terminal = true;
}

function commandStatePath(coordRoot: string, commandSource: `hid_${string}`): string {
  return join(
    resolve(coordRoot),
    EVENT_V2_LEDGER_RELATIVE_ROOT,
    "private-producers/session-tee",
    `${commandSource}.json`,
  );
}

function acquireCommandLease(coordRoot: string, statePath: string) {
  const directory = join(statePath, "..");
  const producerRoot = join(resolve(coordRoot), EVENT_V2_LEDGER_RELATIVE_ROOT, "private-producers");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(producerRoot, 0o700);
  chmodSync(directory, 0o700);
  return acquireNoClobberLease({
    path: `${statePath}.lease`,
    scope: "event-v2-command-producer",
    authoritySha256: createHash("sha256")
      .update(resolve(coordRoot))
      .update("\0")
      .update(statePath)
      .digest("hex"),
    staleAfterMs: 5_000,
    validateStaleOwner: (owner) => owner.host === hostname() && !pidIsAlive(owner.pid),
  });
}

function publishCommandState(path: string, state: CommandRecorderStateV2): void {
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

function readCommandState(path: string): CommandRecorderStateV2 {
  if ((statSync(path).mode & 0o077) !== 0) throw new Error("V2 command state is not owner-only");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("V2 command state is unreadable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("V2 command state is invalid");
  }
  const state = parsed as CommandRecorderStateV2;
  const allowed = new Set([
    "adapter",
    "attestation_id",
    "boot_id",
    "clock_id",
    "format",
    "format_version",
    "generation_id",
    "instance_id",
    "last_event_id",
    "next_sequence",
    "observations",
    "pending",
    "privacy_epoch_id",
    "session_id",
    "span_id",
    "terminal",
    "turn_id",
  ]);
  if (
    Object.keys(state).some((key) => !allowed.has(key)) ||
    state.format !== COMMAND_STATE_FORMAT ||
    state.format_version !== COMMAND_STATE_VERSION ||
    !["claude-code", "codex", "cursor"].includes(state.adapter) ||
    !/^inst_[a-zA-Z0-9._-]{1,128}$/.test(state.instance_id) ||
    !/^sid_[a-f0-9]{64}$/.test(state.session_id) ||
    !/^gen_[0-9a-f-]{36}$/.test(state.generation_id) ||
    !/^tid_[a-f0-9]{64}$/.test(state.turn_id) ||
    !/^att_[0-9a-f-]{36}$/.test(state.attestation_id) ||
    !/^pep_[a-zA-Z0-9._-]+$/.test(state.privacy_epoch_id) ||
    !/^boot_[a-zA-Z0-9._-]+$/.test(state.boot_id) ||
    !/^clk_[0-9a-f-]{36}$/.test(state.clock_id) ||
    !/^span_[0-9a-f-]{36}$/.test(state.span_id) ||
    !/^evt_[0-9a-f-]{36}$/.test(state.last_event_id) ||
    !Number.isSafeInteger(state.next_sequence) ||
    state.next_sequence < 1 ||
    typeof state.terminal !== "boolean" ||
    !Array.isArray(state.observations) ||
    state.observations.length > MAX_OBSERVATIONS ||
    state.observations.some(
      (observation) =>
        !/^hid_[a-f0-9]{64}$/.test(observation.source_id) ||
        !/^evt_[0-9a-f-]{36}$/.test(observation.event_id),
    ) ||
    (state.pending !== undefined &&
      (!/^hid_[a-f0-9]{64}$/.test(state.pending.source_id) ||
        !validateEventV2(state.pending.event).ok))
  ) {
    throw new Error("V2 command state is invalid");
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
