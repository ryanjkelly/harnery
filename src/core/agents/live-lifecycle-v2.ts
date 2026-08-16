import { randomUUID } from "node:crypto";
import { buildEventV2 } from "../events/v2/builder.ts";
import { normalizeNativeIdV2 } from "../events/v2/canonical.ts";
import type { EventV2 } from "../events/v2/contract.ts";
import { readEventV2ControlState } from "../events/v2/control.ts";
import { fingerprintContextV2 } from "../events/v2/fingerprint-keys.ts";
import {
  liveInstanceIdV2,
  livePlatformV2,
  resolveLiveEventLedgerRouteV2,
} from "../events/v2/live-routing.ts";
import { readHookProducerStateV2 } from "../events/v2/producers/recorder.ts";
import { writeEventV2 } from "../events/v2/writer.ts";
import type { Adapter } from "../hooks/events/schema.ts";
import { LiveCoordinationAuthorityV2Error } from "./live-authority-v2.ts";

export type LiveLifecycleObservationV2Result =
  | { state: "v1" }
  | { state: "recorded"; event: EventV2 };

interface LiveLifecycleObservationBaseV2 {
  coordRoot: string;
  owner: string;
  nativeSessionId: string;
  adapter: Adapter;
  observedAt?: string;
}

export function recordLiveSweepObservationV2(
  input: LiveLifecycleObservationBaseV2 & {
    observation: "stale_heartbeat" | "killed" | "unparseable_heartbeat" | "missing_timestamp";
    ageMs: number;
  },
): LiveLifecycleObservationV2Result {
  return recordObservation(input, "lifecycle.sweep_observed", {
    subject_instance_id: liveInstanceIdV2(input.owner),
    observation: input.observation,
    provisional: true,
    age_ms: Math.max(0, Math.floor(input.ageMs)),
  });
}

export function recordLiveResumeObservationV2(
  input: LiveLifecycleObservationBaseV2,
): LiveLifecycleObservationV2Result {
  const hook = requireHookState(input);
  return recordObservation(input, "session.resumed", {
    prior_generation_id: hook.generation_id,
    continuity: "native",
    evidence_reference: "heartbeat_recreated",
  });
}

function recordObservation<T extends "lifecycle.sweep_observed" | "session.resumed">(
  input: LiveLifecycleObservationBaseV2,
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
): LiveLifecycleObservationV2Result {
  const route = resolveLiveEventLedgerRouteV2(input.coordRoot);
  if (route.state === "v1") return { state: "v1" };
  if (route.state === "blocked") throw new LiveCoordinationAuthorityV2Error(route.reason);
  const control = readEventV2ControlState(input.coordRoot);
  if (control.state !== route.mode) {
    throw new LiveCoordinationAuthorityV2Error("control_state_changed");
  }
  const hook = requireHookState(input);
  if (!hook.last_event_id) throw new LiveCoordinationAuthorityV2Error("generation_has_no_event");
  const rootId = control.genesis.event.scope.root_id as `root_${string}`;
  const context = fingerprintContextV2(
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
      platform: livePlatformV2(),
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
      source_record_id: normalizeNativeIdV2(
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
  const event = buildEventV2(eventType, { ...common, payload } as never) as EventV2;
  writeEventV2(input.coordRoot, event);
  return { state: "recorded", event };
}

function requireHookState(input: LiveLifecycleObservationBaseV2) {
  const hook = readHookProducerStateV2(input.coordRoot, input.adapter, input.nativeSessionId);
  if (!hook || hook.instance_id !== liveInstanceIdV2(input.owner)) {
    throw new LiveCoordinationAuthorityV2Error("hook_generation_not_joinable");
  }
  return hook;
}
