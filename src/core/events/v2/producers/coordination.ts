import type { AuthorityMutationV2 } from "../authority-outbox.ts";
import { buildEventV2 } from "../builder.ts";
import { type FingerprintContextV2, fingerprintV2, normalizeNativeIdV2 } from "../canonical.ts";
import type { EventV2 } from "../contract.ts";
import { eventIdV2 } from "../ids.ts";

export type CoordinationAuthoritySignalV2 =
  | "task-changed"
  | "lifecycle-changed"
  | "claim-changed"
  | "identity-attested"
  | "decision-state-changed"
  | "wait-started"
  | "wait-ended";

export interface CoordinationProducerContextV2 {
  root_id: `root_${string}`;
  instance_id: `inst_${string}`;
  session_id: `sid_${string}`;
  generation_id: `gen_${string}`;
  attestation_id: `att_${string}`;
  producer_id: `prd_${string}`;
  boot_id: `boot_${string}`;
  sequence: number;
  build_id: `build_${string}`;
  platform: "linux" | "windows" | "macos" | "unknown";
  bridge?: "codex-wsl";
  actor_instance_id: `inst_${string}`;
  subject_instance_id: `inst_${string}`;
  transaction_id: `txn_${string}`;
  caused_by?: `evt_${string}`[];
  event_id?: `evt_${string}`;
  observed_at?: string;
  recorded_at?: string;
  monotonic_ns?: string;
  clock_id?: `clk_${string}`;
  fingerprintContext: FingerprintContextV2;
  attribution_method: "session_env" | "heartbeat_match" | "explicit_argument";
}

interface CoordinationObservationBaseV2 {
  native_observation_id: string;
}

export interface TaskChangedObservationV2 extends CoordinationObservationBaseV2 {
  state: "set" | "cleared";
  prior_state?: string;
  task?: string;
}

export interface LifecycleChangedObservationV2 extends CoordinationObservationBaseV2 {
  state: "active" | "blocked" | "done";
  prior_state?: string;
  reason_code?: string;
}

export interface ClaimChangedObservationV2 extends CoordinationObservationBaseV2 {
  operation: "acquired" | "released";
  target: unknown;
  access: "read" | "write";
}

export interface IdentityAttestedObservationV2 extends CoordinationObservationBaseV2 {
  identity_id: string;
  method: string;
}

export interface DecisionStateChangedObservationV2 extends CoordinationObservationBaseV2 {
  decision_id: string;
  prior_state?: string;
  outcome: "approved" | "denied" | "deferred";
  record_digest: `sha256:${string}`;
}

export interface WaitStartedObservationV2 extends CoordinationObservationBaseV2 {
  wait_id: string;
  kind: "permission" | "approval" | "decision" | "operator_input" | "dependency" | "scheduled";
  wake_at?: string;
}

export interface WaitEndedObservationV2 extends CoordinationObservationBaseV2 {
  wait_id: string;
  outcome:
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "denied"
    | "interrupted"
    | "unknown";
}

export interface CoordinationObservationBySignalV2 {
  "task-changed": TaskChangedObservationV2;
  "lifecycle-changed": LifecycleChangedObservationV2;
  "claim-changed": ClaimChangedObservationV2;
  "identity-attested": IdentityAttestedObservationV2;
  "decision-state-changed": DecisionStateChangedObservationV2;
  "wait-started": WaitStartedObservationV2;
  "wait-ended": WaitEndedObservationV2;
}

export interface NormalizedCoordinationAuthorityV2 {
  event: EventV2;
  mutation: AuthorityMutationV2;
}

/**
 * Translate one authority-bearing coordination observation without retaining
 * raw task text or claim targets. The event and mutation are returned as one
 * unit so callers cannot independently construct contradictory records.
 */
export function normalizeCoordinationAuthorityV2<S extends CoordinationAuthoritySignalV2>(
  signal: S,
  observation: CoordinationObservationBySignalV2[S],
  context: CoordinationProducerContextV2,
): NormalizedCoordinationAuthorityV2 {
  if (context.instance_id !== context.actor_instance_id) {
    throw new Error("coordination producer instance must be the authority actor");
  }
  const sourceRecordId = normalizeNativeIdV2(
    context.fingerprintContext,
    "agent-coord.authority-source",
    observation.native_observation_id,
  );
  const common = {
    event_id: context.event_id ?? eventIdV2(),
    producer: {
      producer_id: context.producer_id,
      boot_id: context.boot_id,
      sequence: context.sequence,
      component: "agent-coord" as const,
      build_id: context.build_id,
      platform: context.platform,
      ...(context.bridge ? { bridge: context.bridge } : {}),
    },
    scope: {
      root_id: context.root_id,
      instance_id: context.instance_id,
      session_id: context.session_id,
      generation_id: context.generation_id,
    },
    attestation_id: context.attestation_id,
    links: { caused_by: context.caused_by ?? [] },
    provenance: {
      source_event: `agent-coord.${signal}`,
      attestation: "derived" as const,
      confidence: "exact" as const,
      source_record_id: sourceRecordId,
      attribution: {
        method: context.attribution_method,
        state: "verified" as const,
        observer_instance_id: context.actor_instance_id,
        subject_instance_id: context.subject_instance_id,
      },
    },
    observed_at: context.observed_at,
    recorded_at: context.recorded_at,
    monotonic_ns: context.monotonic_ns,
    clock_id: context.clock_id,
  };
  const authority = { transaction_id: context.transaction_id };

  switch (signal) {
    case "task-changed": {
      const input = observation as TaskChangedObservationV2;
      if (input.state === "set" && !input.task) {
        throw new Error("task transition to set requires task text for fingerprinting");
      }
      if (input.state === "cleared" && input.task !== undefined) {
        throw new Error("task transition to cleared must not include task text");
      }
      const taskFingerprint =
        input.state === "set"
          ? fingerprintV2(context.fingerprintContext, "coord.task", input.task, "root")
          : undefined;
      return {
        event: buildEventV2("coord.task_changed", {
          ...common,
          payload: {
            actor_instance_id: context.actor_instance_id,
            subject_instance_id: context.subject_instance_id,
            ...(input.prior_state ? { prior_state: safeToken(input.prior_state) } : {}),
            new_state: input.state,
            reason: "task_transition",
            ...(taskFingerprint ? { reason_fingerprint: taskFingerprint } : {}),
            authority,
          },
        }) as EventV2,
        mutation: {
          kind: "task.transition",
          state: input.state,
          ...(taskFingerprint ? { task_fingerprint: taskFingerprint.digest } : {}),
        },
      };
    }
    case "lifecycle-changed": {
      const input = observation as LifecycleChangedObservationV2;
      const reason = input.reason_code ? reasonCode(input.reason_code) : "lifecycle_transition";
      return {
        event: buildEventV2("coord.lifecycle_changed", {
          ...common,
          payload: {
            actor_instance_id: context.actor_instance_id,
            subject_instance_id: context.subject_instance_id,
            ...(input.prior_state ? { prior_state: safeToken(input.prior_state) } : {}),
            new_state: input.state,
            reason,
            authority,
          },
        }) as EventV2,
        mutation: { kind: "lifecycle.transition", state: input.state, reason_code: reason },
      };
    }
    case "claim-changed": {
      const input = observation as ClaimChangedObservationV2;
      const target = fingerprintV2(
        context.fingerprintContext,
        "coord.claim-target",
        input.target,
        "root",
      );
      return {
        event: buildEventV2("coord.claim_changed", {
          ...common,
          payload: {
            actor_instance_id: context.actor_instance_id,
            subject_instance_id: context.subject_instance_id,
            operation: input.operation,
            target,
            access: input.access,
            authority,
          },
        }) as EventV2,
        mutation: {
          kind: input.operation === "acquired" ? "claim.acquire" : "claim.release",
          target_fingerprint: target.digest,
          access: input.access,
        },
      };
    }
    case "identity-attested": {
      const input = observation as IdentityAttestedObservationV2;
      const identityId = safeToken(input.identity_id);
      return {
        event: buildEventV2("coord.identity_attested", {
          ...common,
          payload: {
            actor_instance_id: context.actor_instance_id,
            subject_instance_id: context.subject_instance_id,
            identity_id: identityId,
            method: safeToken(input.method),
            authority,
          },
        }) as EventV2,
        mutation: { kind: "identity.assume", identity_id: identityId },
      };
    }
    case "decision-state-changed": {
      const input = observation as DecisionStateChangedObservationV2;
      const decisionId = safeToken(input.decision_id);
      return {
        event: buildEventV2("decision.state_changed", {
          ...common,
          payload: {
            decision_id: decisionId,
            ...(input.prior_state ? { prior_state: safeToken(input.prior_state) } : {}),
            new_state: input.outcome,
            record_digest: input.record_digest,
            authority,
          },
        }) as EventV2,
        mutation: { kind: "decision.resolve", decision_id: decisionId, outcome: input.outcome },
      };
    }
    case "wait-started": {
      const input = observation as WaitStartedObservationV2;
      const waitId = safeToken(input.wait_id);
      return {
        event: buildEventV2("interaction.wait_started", {
          ...common,
          payload: {
            wait_id: waitId,
            kind: input.kind,
            authority_reference: context.transaction_id,
            ...(input.wake_at ? { wake_at: input.wake_at } : {}),
          },
        }) as EventV2,
        mutation: { kind: "wait.start", wait_id: waitId, wait_kind: input.kind },
      };
    }
    case "wait-ended": {
      const input = observation as WaitEndedObservationV2;
      const waitId = safeToken(input.wait_id);
      return {
        event: buildEventV2("interaction.wait_ended", {
          ...common,
          payload: {
            wait_id: waitId,
            outcome: input.outcome,
            resolution_reference: context.transaction_id,
          },
        }) as EventV2,
        mutation: { kind: "wait.end", wait_id: waitId, outcome: input.outcome },
      };
    }
  }
}

function safeToken(value: string): string {
  const normalized = value.normalize("NFC");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(normalized)) {
    throw new Error("coordination token is invalid");
  }
  return normalized;
}

function reasonCode(value: string): string {
  const normalized = value.normalize("NFC");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(normalized)) {
    throw new Error("coordination reason code is invalid");
  }
  return normalized;
}
