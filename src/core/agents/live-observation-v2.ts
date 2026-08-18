import { randomUUID } from "node:crypto";
import type { Adapter } from "../adapter.ts";
import { buildEventV2 } from "../events/v2/builder.ts";
import {
  canonicalJsonV2,
  fingerprintV2,
  normalizeNativeIdV2,
  sha256V2,
} from "../events/v2/canonical.ts";
import type { EventTypeV2, EventV2 } from "../events/v2/contract.ts";
import { readEventV2ControlState } from "../events/v2/control.ts";
import { readCoordinationViewV2 } from "../events/v2/coordination-view.ts";
import { fingerprintContextV2 } from "../events/v2/fingerprint-keys.ts";
import type { LiveCoordinationObservationV2 } from "../events/v2/live-observation.ts";
import {
  liveInstanceIdV2,
  livePlatformV2,
  resolveLiveEventLedgerRouteV2,
} from "../events/v2/live-routing.ts";
import { readHookProducerStateV2 } from "../events/v2/producers/recorder.ts";
import { writeEventV2 } from "../events/v2/writer.ts";
import { LiveCoordinationAuthorityV2Error } from "./live-authority-v2.ts";
import { liveCoordinationAdapterV2 } from "./state/live-coordination-view.ts";

export type { LiveCoordinationObservationV2 } from "../events/v2/live-observation.ts";

export interface RecordLiveCoordinationObservationV2Input {
  coordRoot: string;
  owner: string;
  nativeSessionId: string;
  adapter: Adapter;
  observation: LiveCoordinationObservationV2;
  observationId?: string;
  observedAt?: string;
}

export interface RecordLiveCoordinationObservationV2Result {
  state: "recorded";
  event: EventV2;
}

/**
 * Append a non-authority coordination observation against one attested live
 * generation. Raw message and record bodies are used only to derive keyed
 * fingerprints or content digests; they never enter the ledger payload.
 */
export function recordLiveCoordinationObservationV2(
  input: RecordLiveCoordinationObservationV2Input,
): RecordLiveCoordinationObservationV2Result {
  const route = resolveLiveEventLedgerRouteV2(input.coordRoot);
  if (route.state === "blocked") throw new LiveCoordinationAuthorityV2Error(route.reason);
  const control = readEventV2ControlState(input.coordRoot);
  if (control.state !== route.mode) {
    throw new LiveCoordinationAuthorityV2Error("control_state_changed");
  }
  const adapter = liveCoordinationAdapterV2(input.coordRoot, input.owner) ?? input.adapter;
  const hook = readHookProducerStateV2(input.coordRoot, adapter, input.nativeSessionId);
  if (
    !hook ||
    hook.terminal ||
    !hook.last_event_id ||
    hook.instance_id !== liveInstanceIdV2(input.owner)
  ) {
    throw new LiveCoordinationAuthorityV2Error("hook_generation_not_joinable");
  }

  const rootId = control.genesis.event.scope.root_id as `root_${string}`;
  const fingerprintContext = fingerprintContextV2(
    input.coordRoot,
    rootId,
    hook.generation_id,
    control.genesis.profile.privacy_key_epoch,
  );
  const observationId = input.observationId ?? `${input.observation.event_type}-${randomUUID()}`;
  const subject =
    "subject" in input.observation && input.observation.subject
      ? liveInstanceIdV2(input.observation.subject)
      : hook.instance_id;
  const common = {
    producer: {
      producer_id: "prd_agent-coord-observation" as const,
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
      source_event: `agent-coord.${input.observation.event_type}`,
      attestation: "derived" as const,
      confidence: "exact" as const,
      source_record_id: normalizeNativeIdV2(
        fingerprintContext,
        "agent-coord.observation",
        observationId,
      ),
      attribution: {
        method: "session_env" as const,
        state: "verified" as const,
        observer_instance_id: hook.instance_id,
        subject_instance_id: subject,
      },
    },
    observed_at: input.observedAt,
    monotonic_ns: process.hrtime.bigint().toString(),
  };

  const observation = input.observation;
  let event: EventV2;
  switch (observation.event_type) {
    case "coord.status_observed":
      event = buildEventV2("coord.status_observed", {
        ...common,
        payload: {
          observer_instance_id: hook.instance_id,
          subject_instance_id: subject,
          status: safeToken(observation.status),
        },
      });
      break;
    case "coord.presence_changed": {
      // The ledger projection, not the independently versioned presence file,
      // owns the canonical prior state. Omitting an unknown first prior keeps
      // the transition honest and avoids manufacturing a history.
      const projectedPrior = readCoordinationViewV2(input.coordRoot).instances[hook.instance_id]
        ?.presence_state;
      event = buildEventV2("coord.presence_changed", {
        ...common,
        payload: {
          actor_instance_id: hook.instance_id,
          subject_instance_id: hook.instance_id,
          ...(projectedPrior ? { prior_state: safeToken(projectedPrior) } : {}),
          new_state: safeToken(observation.new_state),
          reason: reasonCode(observation.reason),
          authority: {},
        },
      });
      break;
    }
    case "coord.message_observed":
      event = buildEventV2("coord.message_observed", {
        ...common,
        payload: {
          message_id: safeToken(observation.message_id ?? `msg_${randomUUID()}`),
          direction: observation.direction,
          peer_instance_id: subject,
          body_length: Buffer.byteLength(observation.body, "utf8"),
          body_fingerprint: fingerprintV2(
            fingerprintContext,
            "coord.message.body",
            observation.body,
            "generation",
          ),
        },
      });
      break;
    case "council.state_changed":
      event = buildEventV2("council.state_changed", {
        ...common,
        payload: {
          council_id: safeToken(observation.council_id),
          ...(observation.prior_state ? { prior_state: safeToken(observation.prior_state) } : {}),
          new_state: safeToken(observation.new_state),
          record_digest: sha256V2(canonicalJsonV2(observation.record)),
        },
      });
      break;
    case "decision.state_changed": {
      const projectedDecisionPrior = readCoordinationViewV2(input.coordRoot).decisions[
        observation.decision_id
      ];
      event = buildEventV2("decision.state_changed", {
        ...common,
        payload: {
          decision_id: safeToken(observation.decision_id),
          ...(projectedDecisionPrior ? { prior_state: safeToken(projectedDecisionPrior) } : {}),
          new_state: safeToken(observation.new_state),
          record_digest: sha256V2(canonicalJsonV2(observation.record)),
          authority: { record_id: safeToken(observation.decision_id) },
        },
      });
      break;
    }
  }
  writeEventV2(input.coordRoot, event);
  return { state: "recorded", event };
}

function safeToken(value: string): string {
  const normalized = value.normalize("NFC");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(normalized)) {
    throw new LiveCoordinationAuthorityV2Error(`invalid_safe_token:${value}`);
  }
  return normalized;
}

function reasonCode(value: string): string {
  const normalized = value.normalize("NFC");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(normalized)) {
    throw new LiveCoordinationAuthorityV2Error(`invalid_reason_code:${value}`);
  }
  return normalized;
}

export type LiveCoordinationObservationEventTypeV2 = Extract<
  EventTypeV2,
  LiveCoordinationObservationV2["event_type"]
>;
