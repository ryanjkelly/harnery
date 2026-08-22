import { randomUUID } from "node:crypto";
import type { Adapter } from "../adapter.ts";
import { buildEventV3 } from "../events/v3/builder.ts";
import { normalizeNativeIdV3 } from "../events/v3/canonical.ts";
import type { EventV3 } from "../events/v3/contract.ts";
import { readEventV3ControlState } from "../events/v3/control.ts";
import { fingerprintContextV3 } from "../events/v3/fingerprint-keys.ts";
import {
  liveInstanceIdV3,
  livePlatformV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import { readJoinableHookProducerStateV3 } from "../events/v3/producers/recorder.ts";
import { writeEventV3 } from "../events/v3/writer.ts";
import { LiveCoordinationAuthorityV3Error } from "./live-authority-v3.ts";
import { liveCoordinationAdapterV3 } from "./state/live-coordination-view.ts";

export type LiveLifecycleObservationV3Result = { state: "recorded"; event: EventV3 };

interface LiveLifecycleObservationBaseV3 {
  coordRoot: string;
  owner: string;
  nativeSessionId: string;
  adapter: Adapter;
  observedAt?: string;
}

export function recordLiveSweepObservationV3(
  input: LiveLifecycleObservationBaseV3 & {
    observation: "stale_heartbeat" | "killed" | "unparseable_heartbeat" | "missing_timestamp";
    ageMs: number;
  },
): LiveLifecycleObservationV3Result {
  return recordObservation(input, "lifecycle.sweep_observed", {
    subject_instance_id: liveInstanceIdV3(input.owner),
    observation: input.observation,
    provisional: true,
    age_ms: Math.max(0, Math.floor(input.ageMs)),
  });
}

export function recordLiveResumeObservationV3(
  input: LiveLifecycleObservationBaseV3,
): LiveLifecycleObservationV3Result {
  const normalized = withAttestedAdapter(input);
  const hook = requireHookState(normalized);
  return recordObservation(normalized, "session.resumed", {
    prior_generation_id: hook.generation_id,
    continuity: "native",
    evidence_reference: "heartbeat_recreated",
  });
}

function recordObservation<T extends "lifecycle.sweep_observed" | "session.resumed">(
  input: LiveLifecycleObservationBaseV3,
  eventType: T,
  payload: T extends "lifecycle.sweep_observed"
    ? {
        subject_instance_id: `inst_${string}`;
        observation: string;
        provisional: true;
        age_ms: number;
      }
    : {
        prior_generation_id: `gen_${string}`;
        continuity: "native";
        evidence_reference: string;
      },
): LiveLifecycleObservationV3Result {
  const route = resolveLiveEventLedgerRouteV3(input.coordRoot);
  if (route.state === "blocked") throw new LiveCoordinationAuthorityV3Error(route.reason);
  input = withAttestedAdapter(input);
  const control = readEventV3ControlState(input.coordRoot);
  if (control.state !== route.mode) {
    throw new LiveCoordinationAuthorityV3Error("control_state_changed");
  }
  const hook = requireHookState(input);
  if (!hook.last_event_id) throw new LiveCoordinationAuthorityV3Error("generation_has_no_event");
  const rootId = control.genesis.event.scope.root_id as `root_${string}`;
  const context = fingerprintContextV3(
    input.coordRoot,
    rootId,
    hook.generation_id,
    control.genesis.profile.privacy_key_epoch,
  );
  const nativeObservationId = `${eventType}\0${input.owner}\0${input.observedAt ?? "now"}\0${JSON.stringify(payload)}`;
  const common = {
    producer: {
      producer_id: "prd_agent-coord-lifecycle" as const,
      boot_id: `boot_${randomUUID()}` as const,
      sequence: 1,
      component: "agent-coord" as const,
      build_id: route.build_id,
      platform: livePlatformV3(),
    },
    scope: {
      root_id: rootId,
      instance_id: hook.instance_id,
      session_id: hook.session_id,
      generation_id: hook.generation_id,
    },
    attestation_id: hook.attestation_id,
    links: { caused_by: [hook.last_event_id] },
    provenance: {
      source_event: `agent-coord.${eventType}`,
      attestation: "derived" as const,
      confidence: "exact" as const,
      source_record_id: normalizeNativeIdV3(
        context,
        `agent-coord.${eventType}`,
        nativeObservationId,
      ),
      attribution: {
        method: "heartbeat_match" as const,
        state: "verified" as const,
        observer_instance_id: hook.instance_id,
        subject_instance_id: hook.instance_id,
      },
    },
    observed_at: input.observedAt,
    monotonic_ns: process.hrtime.bigint().toString(),
  };
  const event = buildEventV3(eventType, { ...common, payload } as never) as EventV3;
  writeEventV3(input.coordRoot, event);
  return { state: "recorded", event };
}

function withAttestedAdapter<T extends LiveLifecycleObservationBaseV3>(input: T): T {
  const adapter = liveCoordinationAdapterV3(input.coordRoot, input.owner);
  if (!adapter) return input;
  return { ...input, adapter };
}

function requireHookState(input: LiveLifecycleObservationBaseV3) {
  const hook = readJoinableHookProducerStateV3(
    input.coordRoot,
    input.adapter,
    input.nativeSessionId,
    liveInstanceIdV3(input.owner),
  );
  if (!hook) {
    throw new LiveCoordinationAuthorityV3Error("hook_generation_not_joinable");
  }
  return hook;
}
