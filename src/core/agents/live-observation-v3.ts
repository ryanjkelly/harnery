import { randomUUID } from "node:crypto";
import type { Adapter } from "../adapter.ts";
import { buildEventV3 } from "../events/v3/builder.ts";
import {
  canonicalJsonV3,
  fingerprintV3,
  normalizeNativeIdV3,
  sha256V3,
} from "../events/v3/canonical.ts";
import type { EventTypeV3, EventV3 } from "../events/v3/contract.ts";
import { readEventV3ControlState } from "../events/v3/control.ts";
import { readCoordinationViewV3 } from "../events/v3/coordination-view.ts";
import { fingerprintContextV3 } from "../events/v3/fingerprint-keys.ts";
import type { LiveCoordinationObservationV3 } from "../events/v3/live-observation.ts";
import {
  liveInstanceIdV3,
  livePlatformV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import { readJoinableHookProducerStateV3 } from "../events/v3/producers/recorder.ts";
import { writeEventV3 } from "../events/v3/writer.ts";
import { LiveCoordinationAuthorityV3Error } from "./live-authority-v3.ts";
import { liveCoordinationAdapterV3 } from "./state/live-coordination-view.ts";

export type { LiveCoordinationObservationV3 } from "../events/v3/live-observation.ts";

export interface RecordLiveCoordinationObservationV3Input {
  coordRoot: string;
  owner: string;
  nativeSessionId: string;
  adapter: Adapter;
  observation: LiveCoordinationObservationV3;
  observationId?: string;
  observedAt?: string;
}

export interface RecordLiveCoordinationObservationV3Result {
  state: "recorded";
  event: EventV3;
}

/**
 * Append a non-authority coordination observation against one attested live
 * generation. Raw message and record bodies are used only to derive keyed
 * fingerprints or content digests; they never enter the ledger payload.
 */
export function recordLiveCoordinationObservationV3(
  input: RecordLiveCoordinationObservationV3Input,
): RecordLiveCoordinationObservationV3Result {
  const route = resolveLiveEventLedgerRouteV3(input.coordRoot);
  if (route.state === "blocked") throw new LiveCoordinationAuthorityV3Error(route.reason);
  const control = readEventV3ControlState(input.coordRoot);
  if (control.state !== route.mode) {
    throw new LiveCoordinationAuthorityV3Error("control_state_changed");
  }
  const adapter = liveCoordinationAdapterV3(input.coordRoot, input.owner) ?? input.adapter;
  const hook = readJoinableHookProducerStateV3(
    input.coordRoot,
    adapter,
    input.nativeSessionId,
    liveInstanceIdV3(input.owner),
  );
  if (
    !hook ||
    hook.terminal ||
    !hook.last_event_id ||
    hook.instance_id !== liveInstanceIdV3(input.owner)
  ) {
    throw new LiveCoordinationAuthorityV3Error("hook_generation_not_joinable");
  }

  const rootId = control.genesis.event.scope.root_id as `root_${string}`;
  const fingerprintContext = fingerprintContextV3(
    input.coordRoot,
    rootId,
    hook.generation_id,
    control.genesis.profile.privacy_key_epoch,
  );
  const observationId = input.observationId ?? `${input.observation.event_type}-${randomUUID()}`;
  const subject =
    "subject" in input.observation && input.observation.subject
      ? liveInstanceIdV3(input.observation.subject)
      : hook.instance_id;
  const common = {
    producer: {
      producer_id: "prd_agent-coord-observation" as const,
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
      source_event: `agent-coord.${input.observation.event_type}`,
      attestation: "derived" as const,
      confidence: "exact" as const,
      source_record_id: normalizeNativeIdV3(
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
  let event: EventV3;
  switch (observation.event_type) {
    case "coord.status_observed":
      event = buildEventV3("coord.status_observed", {
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
      const projectedPrior = readCoordinationViewV3(input.coordRoot).instances[hook.instance_id]
        ?.presence_state;
      event = buildEventV3("coord.presence_changed", {
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
      event = buildEventV3("coord.message_observed", {
        ...common,
        payload: {
          message_id: safeToken(observation.message_id ?? `msg_${randomUUID()}`),
          direction: observation.direction,
          peer_instance_id: subject,
          body_length: Buffer.byteLength(observation.body, "utf8"),
          body_fingerprint: fingerprintV3(
            fingerprintContext,
            "coord.message.body",
            observation.body,
            "generation",
          ),
        },
      });
      break;
    case "council.state_changed":
      event = buildEventV3("council.state_changed", {
        ...common,
        payload: {
          council_id: safeToken(observation.council_id),
          ...(observation.prior_state ? { prior_state: safeToken(observation.prior_state) } : {}),
          new_state: safeToken(observation.new_state),
          record_digest: sha256V3(canonicalJsonV3(observation.record)),
        },
      });
      break;
    case "decision.state_changed": {
      const projectedDecisionPrior = readCoordinationViewV3(input.coordRoot).decisions[
        observation.decision_id
      ];
      event = buildEventV3("decision.state_changed", {
        ...common,
        payload: {
          decision_id: safeToken(observation.decision_id),
          ...(projectedDecisionPrior ? { prior_state: safeToken(projectedDecisionPrior) } : {}),
          new_state: safeToken(observation.new_state),
          record_digest: sha256V3(canonicalJsonV3(observation.record)),
          authority: { record_id: safeToken(observation.decision_id) },
        },
      });
      break;
    }
  }
  const durability = writeEventV3(input.coordRoot, event, {
    expectedGenesisId: control.genesis.event.payload.genesis_id as `gex_${string}`,
  });
  if (durability.state === "epoch_replaced") {
    throw new LiveCoordinationAuthorityV3Error("epoch_replaced");
  }
  return { state: "recorded", event };
}

function safeToken(value: string): string {
  const normalized = value.normalize("NFC");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(normalized)) {
    throw new LiveCoordinationAuthorityV3Error(`invalid_safe_token:${value}`);
  }
  return normalized;
}

function reasonCode(value: string): string {
  const normalized = value.normalize("NFC");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(normalized)) {
    throw new LiveCoordinationAuthorityV3Error(`invalid_reason_code:${value}`);
  }
  return normalized;
}

export type LiveCoordinationObservationEventTypeV3 = Extract<
  EventTypeV3,
  LiveCoordinationObservationV3["event_type"]
>;
