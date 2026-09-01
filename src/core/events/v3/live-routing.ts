import type { Adapter } from "../../adapter.ts";
import type { ParsedPayload } from "../../hooks/adapter/parse.ts";
import { refreshIncompatibleEventLedgerV3, rotateOversizedEventLedgerV3 } from "./bootstrap.ts";
import type { EventV3 } from "./contract.ts";
import { readEventV3ControlState } from "./control.ts";
import { repairEventV3ControlPair } from "./control-writer.ts";
import {
  type LiveEventLedgerRouteV3,
  liveEventLedgerRouteFromControlV3,
  liveInstanceIdV3,
  runtimeCapabilityProfileCurrentV3,
} from "./live-route-observer.ts";
import type { HookSignalV3 } from "./producers/hook.ts";
import type { TurnRitualEvidenceV3 } from "./producers/hook-base.ts";
import {
  type ReconcilePendingRuntimeContextV3Result,
  type RecordHookSignalV3Result,
  reconcilePendingRuntimeContextV3,
  recordHookSignalV3,
} from "./producers/recorder.ts";
import { livePlatformV3 } from "./runtime-identity.ts";

export {
  type LiveEventLedgerRouteV3,
  liveInstanceIdV3,
  nativeInstanceIdV3,
} from "./live-route-observer.ts";
export { liveEventV3BuildId, livePlatformV3 } from "./runtime-identity.ts";

export const LIVE_HOOK_V3_PRODUCER_ID = "prd_agent-hook" as const;
export const LIVE_COMMAND_V3_PRODUCER_ID = "prd_session-tee" as const;

/**
 * Resolve the V3-only ledger route. A root without an initialized V3 control
 * packet is blocked; no mutating producer may fall back to an older ledger.
 * Manifest-first crashes are repaired from the immutable packet and every
 * other invalid state closes the writer gate.
 */
export function resolveLiveEventLedgerRouteV3(coordRoot: string): LiveEventLedgerRouteV3 {
  let control = readEventV3ControlState(coordRoot);
  if (control.state === "closed") return { state: "blocked", reason: "v3_not_initialized" };
  if (control.state === "repairable") control = repairEventV3ControlPair(coordRoot);
  if (
    (control.state === "invalid" && control.reason === "genesis_schema_digest_incompatible") ||
    ((control.state === "candidate" || control.state === "active") &&
      !runtimeCapabilityProfileCurrentV3(control))
  ) {
    try {
      control = refreshIncompatibleEventLedgerV3(coordRoot).control;
    } catch (error) {
      return {
        state: "blocked",
        reason: `runtime_refresh_failed:${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (control.state === "active") {
    // Bound the epoch every producer must re-validate: an oversized active
    // segment rotates into the archive here, on the shared route boundary.
    // Rotation failure never blocks recording; the current epoch stays live.
    try {
      const rotated = rotateOversizedEventLedgerV3(coordRoot);
      if (rotated.state === "rotated" && rotated.control) control = rotated.control;
    } catch {
      // The oversized epoch keeps serving; the next route resolution retries.
    }
  }
  return liveEventLedgerRouteFromControlV3(control);
}

export function hookSignalV3(eventName: string): HookSignalV3 | undefined {
  switch (eventName) {
    case "session-start":
    case "session-end":
    case "user-prompt-submit":
    case "after-agent-response":
    case "stop":
    case "stop-failure":
    case "pre-tool-use":
    case "post-tool-use":
    case "post-tool-use-failure":
    case "permission-request":
    case "sub-agent-start":
    case "sub-agent-stop":
    case "pre-compact":
    case "post-compact":
      return eventName;
    case "before-shell-execution":
      return "pre-tool-use";
    case "after-shell-execution":
      return "post-tool-use";
    default:
      return undefined;
  }
}

/**
 * Tool lifecycle hooks may stop after publishing their event to the durable
 * ready WAL. The next non-tool hook drains the causal batch into the active
 * ledger, avoiding one global append-lease cycle for every tool boundary.
 */
export function liveHookSignalDefersDrainV3(eventName: string, override?: string): boolean {
  if (override === "1") return true;
  if (override === "0") return false;
  const signal = hookSignalV3(eventName);
  return (
    signal === "pre-tool-use" || signal === "post-tool-use" || signal === "post-tool-use-failure"
  );
}

export function recordLiveHookSignalV3(input: {
  coordRoot: string;
  route: Extract<LiveEventLedgerRouteV3, { state: "v3" }>;
  eventName: string;
  payload: ParsedPayload | null;
  adapter: Adapter;
  instanceId: string;
  run_id?: `run_${string}`;
  workflow_id?: `wf_${string}`;
  workflow_agent_id?: string;
  bridge?: "codex-wsl";
  monotonic_ns?: string;
  hook_name?: string;
  hook_duration_ms?: number;
  stop_remediation?: boolean;
  turn_ritual?: TurnRitualEvidenceV3;
  defer_drain?: boolean;
}): RecordHookSignalV3Result | { state: "ignored" } {
  const signal = hookSignalV3(input.eventName);
  if (!signal) return { state: "ignored" };
  const nativeChild = input.payload?.subagent_id ?? input.payload?.agent_id;
  const childOwnsSignal =
    signal !== "sub-agent-start" &&
    signal !== "sub-agent-stop" &&
    nativeChild !== undefined &&
    liveInstanceIdV3(input.instanceId) === liveInstanceIdV3(nativeChild);
  const payload = input.payload
    ? childOwnsSignal
      ? {
          ...input.payload,
          session_id: nativeChild,
          conversation_id: undefined,
          parent_session_id: input.payload.session_id ?? input.payload.conversation_id,
        }
      : input.payload
    : { raw: {} };
  return recordHookSignalV3({
    coordRoot: input.coordRoot,
    mode: input.route.mode,
    signal,
    payload,
    adapter: input.adapter,
    instance_id: liveInstanceIdV3(input.instanceId),
    run_id: input.run_id,
    workflow_id: input.workflow_id,
    workflow_agent_id: input.workflow_agent_id,
    producer_id: LIVE_HOOK_V3_PRODUCER_ID,
    build_id: input.route.build_id,
    platform: livePlatformV3(),
    ...(input.bridge ? { bridge: input.bridge } : {}),
    monotonic_ns: input.monotonic_ns,
    hook_name: input.hook_name,
    hook_duration_ms: input.hook_duration_ms,
    stop_remediation: input.stop_remediation,
    turn_ritual: input.turn_ritual,
    ...(input.defer_drain ? { writerOptions: { deferDrain: true } } : {}),
  });
}

export function reconcileLivePendingRuntimeContextV3(input: {
  coordRoot: string;
  route: Extract<LiveEventLedgerRouteV3, { state: "v3" }>;
  nativeSessionId: string;
  finalAttempt?: boolean;
}): ReconcilePendingRuntimeContextV3Result {
  return reconcilePendingRuntimeContextV3({
    coordRoot: input.coordRoot,
    mode: input.route.mode,
    nativeSessionId: input.nativeSessionId,
    producer_id: LIVE_HOOK_V3_PRODUCER_ID,
    build_id: input.route.build_id,
    platform: livePlatformV3(),
    finalAttempt: input.finalAttempt,
  });
}

/**
 * Open the child generation named by a native SubagentStart event.
 *
 * The parent producer owns the delegation span and mints its child generation
 * id. This second crash-safe session-start gives that exact generation its own
 * producer authority, so later child tool hooks can resolve away from the
 * parent session and the disposable heartbeat projection has a real source.
 */
export function recordLiveDelegatedChildSessionV3(input: {
  coordRoot: string;
  route: Extract<LiveEventLedgerRouteV3, { state: "v3" }>;
  parentEvent: Extract<EventV3, { event_type: "agent.started" }>;
  payload: ParsedPayload;
  adapter: Adapter;
  bridge?: "codex-wsl";
  monotonic_ns?: string;
}): RecordHookSignalV3Result | { state: "ignored" } {
  const nativeChild = input.payload.subagent_id ?? input.payload.agent_id;
  if (!nativeChild) return { state: "ignored" };
  const parentGeneration = (input.parentEvent.links as { parent_generation_id?: `gen_${string}` })
    .parent_generation_id;
  if (!parentGeneration) return { state: "ignored" };
  const nativeParent = input.payload.session_id ?? input.payload.conversation_id;
  const childPayload: ParsedPayload = {
    session_id: nativeChild,
    agent_id: nativeChild,
    parent_session_id: nativeParent,
    source: "startup",
    model: input.payload.model,
    cwd: input.payload.cwd,
    raw: {
      session_id: nativeChild,
      agent_id: nativeChild,
      ...(nativeParent ? { parent_session_id: nativeParent } : {}),
      ...(input.payload.raw.agent_type ? { agent_type: input.payload.raw.agent_type } : {}),
    },
  };
  const started = recordHookSignalV3({
    coordRoot: input.coordRoot,
    mode: input.route.mode,
    signal: "session-start",
    payload: childPayload,
    adapter: input.adapter,
    instance_id: liveInstanceIdV3(nativeChild),
    producer_id: LIVE_HOOK_V3_PRODUCER_ID,
    build_id: input.route.build_id,
    platform: livePlatformV3(),
    ...(input.bridge ? { bridge: input.bridge } : {}),
    monotonic_ns: input.monotonic_ns,
    hook_name: "sub-agent-start-child-session",
    delegated_child: {
      generation_id: input.parentEvent.payload.child_generation_id as `gen_${string}`,
      parent_generation_id: parentGeneration,
      delegation_id: input.parentEvent.payload.delegation_id as `del_${string}`,
      caused_by_event_id: input.parentEvent.event_id as `evt_${string}`,
    },
  });
  if (started.state !== "recorded" && started.state !== "already_started") return started;
  const childStartEventId = (
    started.state === "recorded" ? started.event.event_id : started.event_id
  ) as `evt_${string}`;
  recordHookSignalV3({
    coordRoot: input.coordRoot,
    mode: input.route.mode,
    signal: "user-prompt-submit",
    payload: {
      ...childPayload,
      turn_id: `delegated:${nativeChild}`,
      raw: { ...childPayload.raw, turn_id: `delegated:${nativeChild}` },
    },
    adapter: input.adapter,
    instance_id: liveInstanceIdV3(nativeChild),
    producer_id: LIVE_HOOK_V3_PRODUCER_ID,
    build_id: input.route.build_id,
    platform: livePlatformV3(),
    ...(input.bridge ? { bridge: input.bridge } : {}),
    monotonic_ns: input.monotonic_ns,
    hook_name: "sub-agent-start-child-turn",
    delegated_child: {
      generation_id: input.parentEvent.payload.child_generation_id as `gen_${string}`,
      parent_generation_id: parentGeneration,
      delegation_id: input.parentEvent.payload.delegation_id as `del_${string}`,
      caused_by_event_id: childStartEventId,
    },
  });
  return started;
}
