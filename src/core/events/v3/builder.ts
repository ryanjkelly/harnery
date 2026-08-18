import type { EventOfTypeV3, EventPayloadV3, EventTypeV3 } from "./contract.ts";
import { EVENT_V3_CONTRACT_MAJOR, EVENT_V3_CONTRACT_NAME } from "./contract.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { clockIdV3, eventIdV3 } from "./ids.ts";

type EventWithoutDiscriminator<T extends EventTypeV3> = Omit<
  EventOfTypeV3<T>,
  "attestation_id" | "contract" | "event_id" | "event_type" | "payload" | "time"
>;

type RootEventTypeV3 =
  | "ledger.genesis"
  | "ledger.activated"
  | "ledger.schema_advanced"
  | "ledger.comparability_advanced";

type AttestationInputV3<T extends EventTypeV3> = T extends RootEventTypeV3
  ? { attestation_id?: never }
  : { attestation_id: `att_${string}` };

export type BuildEventV3Input<T extends EventTypeV3> = EventWithoutDiscriminator<T> &
  AttestationInputV3<T> & {
    payload: EventPayloadV3<T>;
    event_id?: `evt_${string}`;
    observed_at?: string;
    recorded_at?: string;
    monotonic_ns?: string;
    clock_id?: `clk_${string}`;
    skew?: "normal" | "regressed" | "unknown";
  };

export function buildEventV3<T extends EventTypeV3>(
  eventType: T,
  input: BuildEventV3Input<T>,
): EventOfTypeV3<T> {
  const now = input.recorded_at ?? new Date().toISOString();
  return {
    contract: {
      name: EVENT_V3_CONTRACT_NAME,
      major: EVENT_V3_CONTRACT_MAJOR,
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
  } as EventOfTypeV3<T>;
}
