import type { EventOfTypeV3Base, EventPayloadV3Base, EventTypeV3Base } from "./base-contract.ts";
import { EVENT_V3_BASE_CONTRACT_MAJOR, EVENT_V3_BASE_CONTRACT_NAME } from "./base-contract.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { clockIdV3, eventIdV3 } from "./ids.ts";

type EventWithoutDiscriminator<T extends EventTypeV3Base> = Omit<
  EventOfTypeV3Base<T>,
  "attestation_id" | "contract" | "event_id" | "event_type" | "payload" | "time"
>;

type RootEventTypeV3Base =
  | "ledger.genesis"
  | "ledger.activated"
  | "ledger.schema_advanced"
  | "ledger.comparability_advanced";

type AttestationInputV3Base<T extends EventTypeV3Base> = T extends RootEventTypeV3Base
  ? { attestation_id?: never }
  : { attestation_id: `att_${string}` };

export type BuildEventV3BaseInput<T extends EventTypeV3Base> = EventWithoutDiscriminator<T> &
  AttestationInputV3Base<T> & {
    payload: EventPayloadV3Base<T>;
    event_id?: `evt_${string}`;
    observed_at?: string;
    recorded_at?: string;
    monotonic_ns?: string;
    clock_id?: `clk_${string}`;
    skew?: "normal" | "regressed" | "unknown";
  };

export function buildEventV3Base<T extends EventTypeV3Base>(
  eventType: T,
  input: BuildEventV3BaseInput<T>,
): EventOfTypeV3Base<T> {
  const now = input.recorded_at ?? new Date().toISOString();
  const event = {
    contract: {
      name: EVENT_V3_BASE_CONTRACT_NAME,
      major: EVENT_V3_BASE_CONTRACT_MAJOR,
      schema_digest: EVENT_V3_SCHEMA_DIGEST,
    },
    event_id: input.event_id ?? eventIdV3(),
    event_type: eventType,
    time: {
      observed_at: input.observed_at ?? now,
      recorded_at: now,
      ...(input.monotonic_ns ? { monotonic_ns: input.monotonic_ns } : {}),
      clock_id: input.clock_id ?? clockIdV3(),
      skew: input.skew ?? "unknown",
    },
    producer: input.producer,
    scope: input.scope,
    ...(input.attestation_id ? { attestation_id: input.attestation_id } : {}),
    links: input.links,
    provenance: input.provenance,
    payload: input.payload,
  };
  return event as unknown as EventOfTypeV3Base<T>;
}
