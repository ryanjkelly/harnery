import type { EventOfTypeV2, EventPayloadV2, EventTypeV2 } from "./contract.ts";
import { EVENT_V2_CONTRACT_MAJOR, EVENT_V2_CONTRACT_NAME } from "./contract.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "./generated.ts";
import { clockIdV2, eventIdV2 } from "./ids.ts";

type EventWithoutDiscriminator<T extends EventTypeV2> = Omit<
  EventOfTypeV2<T>,
  "contract" | "event_id" | "event_type" | "payload" | "time"
>;

export type BuildEventV2Input<T extends EventTypeV2> = EventWithoutDiscriminator<T> & {
  payload: EventPayloadV2<T>;
  event_id?: `evt_${string}`;
  observed_at?: string;
  recorded_at?: string;
  monotonic_ns?: string;
  clock_id?: `clk_${string}`;
  skew?: "normal" | "regressed" | "unknown";
};

export function buildEventV2<T extends EventTypeV2>(
  eventType: T,
  input: BuildEventV2Input<T>,
): EventOfTypeV2<T> {
  const now = input.recorded_at ?? new Date().toISOString();
  const event = {
    contract: {
      name: EVENT_V2_CONTRACT_NAME,
      major: EVENT_V2_CONTRACT_MAJOR,
      schema_digest: EVENT_V2_SCHEMA_DIGEST,
    },
    event_id: input.event_id ?? eventIdV2(),
    event_type: eventType,
    time: {
      observed_at: input.observed_at ?? now,
      recorded_at: now,
      ...(input.monotonic_ns ? { monotonic_ns: input.monotonic_ns } : {}),
      clock_id: input.clock_id ?? clockIdV2(),
      skew: input.skew ?? "unknown",
    },
    producer: input.producer,
    scope: input.scope,
    ...(input.attestation_id ? { attestation_id: input.attestation_id } : {}),
    links: input.links,
    provenance: input.provenance,
    payload: input.payload,
  };
  return event as unknown as EventOfTypeV2<T>;
}
