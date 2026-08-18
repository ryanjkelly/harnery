import { type Static, type TObject, type TProperties, type TSchema, Type } from "@sinclair/typebox";
import {
  EVENT_V2_CORE_EVENT_TYPES,
  type EventOfTypeV2,
  type EventTypeV2,
  EventV2Schema,
  ObservationV2Schema,
  OutcomeV2Schema,
  RecoveryV2Schema,
} from "../v2/contract.ts";

export const EVENT_V3_CONTRACT_NAME = "harnery.event" as const;
export const EVENT_V3_CONTRACT_MAJOR = 3 as const;
export const EVENT_V3_SCHEMA_ID = "https://harnery.com/schemas/event-v3.schema.json";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const SafeToken = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$" });
const Timestamp = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
});
const Sha256 = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const uuidV7Pattern = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const EventId = Type.String({ pattern: `^evt_${uuidV7Pattern}$` });
const SpanId = Type.String({ pattern: `^span_${uuidV7Pattern}$` });

export const ObservationV3Schema = ObservationV2Schema;
export const OutcomeV3Schema = OutcomeV2Schema;
export const RecoveryV3Schema = RecoveryV2Schema;

const ContractV3Schema = StrictObject({
  name: Type.Literal(EVENT_V3_CONTRACT_NAME),
  major: Type.Literal(EVENT_V3_CONTRACT_MAJOR),
  schema_digest: Sha256,
});

export const SpanSummaryV3Schema = StrictObject({
  span_id: SpanId,
  parent_span_id: Type.Optional(SpanId),
  opened_at: Timestamp,
  duration_ms: ObservationV3Schema(Type.Integer({ minimum: 0 })),
  open_event_id: Type.Optional(EventId),
});

export const TurnUsageV3Schema = StrictObject({
  input_tokens: Type.Integer({ minimum: 0 }),
  output_tokens: Type.Integer({ minimum: 0 }),
  cache_read_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cache_write_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
  method: SafeToken,
});

export const TurnInferenceV3Schema = StrictObject({
  api_time_ms: Type.Integer({ minimum: 0 }),
  request_count: Type.Integer({ minimum: 0 }),
});

export const TurnHarnessV3Schema = StrictObject({
  hook_time_ms: Type.Integer({ minimum: 0 }),
  hook_count: Type.Integer({ minimum: 0 }),
  slowest_hook: Type.Optional(SafeToken),
});

export const WaitKindV3Schema = Type.Union([
  Type.Literal("permission"),
  Type.Literal("needs_input"),
  Type.Literal("decision"),
  Type.Literal("approval"),
  Type.Literal("scheduled"),
  Type.Literal("rate_limit"),
  Type.Literal("unknown"),
]);

const v2Branches = (EventV2Schema as unknown as { anyOf: TObject[] }).anyOf;

function v2Branch(eventType: string): TObject {
  const branch = v2Branches.find(
    ({ properties }) => (properties.event_type as { const?: string }).const === eventType,
  );
  if (!branch) throw new Error(`V2 event schema missing: ${eventType}`);
  return branch;
}

function v2Payload(eventType: string): TObject {
  return v2Branch(eventType).properties.payload as TObject;
}

function eventV3(
  priorEventType: string,
  options: { eventType?: string; payload?: TSchema; links?: TSchema } = {},
): TObject {
  const prior = v2Branch(priorEventType);
  const eventType = options.eventType ?? priorEventType;
  return StrictObject({
    ...prior.properties,
    contract: ContractV3Schema,
    event_type: Type.Literal(eventType),
    links: options.links ?? prior.properties.links,
    payload: options.payload ?? prior.properties.payload,
  });
}

function terminalPayloadV3(eventType: string, additions: TProperties = {}): TObject {
  const prior = v2Payload(eventType);
  return StrictObject({
    ...prior.properties,
    ...additions,
    span: SpanSummaryV3Schema,
  });
}

export const SessionEndedV3Schema = eventV3("session.ended", {
  payload: terminalPayloadV3("session.ended"),
});

export const TurnCompletedV3Schema = eventV3("turn.completed", {
  payload: terminalPayloadV3("turn.completed", {
    usage: ObservationV3Schema(TurnUsageV3Schema),
    inference: ObservationV3Schema(TurnInferenceV3Schema),
    harness: ObservationV3Schema(TurnHarnessV3Schema),
  }),
});

export const ToolCompletedV3Schema = eventV3("tool.completed", {
  payload: terminalPayloadV3("tool.completed"),
});

export const CommandCompletedV3Schema = eventV3("command.completed", {
  payload: terminalPayloadV3("command.completed", {
    duration_ms: ObservationV3Schema(Type.Integer({ minimum: 0 })),
  }),
});

export const AgentCompletedV3Schema = eventV3("agent.completed", {
  payload: terminalPayloadV3("agent.completed"),
});

const AgentStartedLinksV3Schema = (() => {
  const prior = v2Branch("agent.started").properties.links as TObject;
  return StrictObject({
    ...prior.properties,
    span_id: SpanId,
    parent_span_id: SpanId,
  });
})();

export const AgentStartedV3Schema = eventV3("agent.started", {
  links: AgentStartedLinksV3Schema,
});

export const WaitStartedV3Schema = eventV3("interaction.wait_started", {
  eventType: "wait.started",
  payload: StrictObject({
    wait_id: SafeToken,
    kind: WaitKindV3Schema,
    authority_reference: Type.Optional(SafeToken),
    wake_at: Type.Optional(Timestamp),
  }),
});

export const WaitEndedV3Schema = eventV3("interaction.wait_ended", {
  eventType: "wait.ended",
  payload: terminalPayloadV3("interaction.wait_ended"),
});

export const HealthCapabilityDriftV3Schema = eventV3("health.observed", {
  eventType: "health.capability_drift",
  payload: StrictObject({
    signal: SafeToken,
    promised: Type.Union([
      Type.Literal("native"),
      Type.Literal("derived"),
      Type.Literal("conditional"),
    ]),
    expected_count: Type.Integer({ minimum: 0 }),
    observed_count: Type.Integer({ minimum: 0 }),
    generation_ended: Type.Boolean(),
  }),
});

const replacedV2Types = new Set([
  "session.ended",
  "turn.completed",
  "tool.completed",
  "command.completed",
  "agent.completed",
  "interaction.wait_started",
  "interaction.wait_ended",
]);
const unchangedV3Schemas = v2Branches
  .filter(
    ({ properties }) =>
      !replacedV2Types.has((properties.event_type as unknown as { const: string }).const),
  )
  .map(({ properties }) => {
    const eventType = (properties.event_type as unknown as { const: string }).const;
    return eventType === "agent.started"
      ? AgentStartedV3Schema
      : StrictObject({
          ...properties,
          contract: ContractV3Schema,
        });
  });

export const EventV3Schema = Type.Union(
  [
    ...unchangedV3Schemas,
    SessionEndedV3Schema,
    TurnCompletedV3Schema,
    ToolCompletedV3Schema,
    CommandCompletedV3Schema,
    AgentCompletedV3Schema,
    WaitStartedV3Schema,
    WaitEndedV3Schema,
    HealthCapabilityDriftV3Schema,
  ],
  { $id: EVENT_V3_SCHEMA_ID },
);

export const EVENT_V3_CORE_EVENT_TYPES = [
  ...EVENT_V2_CORE_EVENT_TYPES.filter(
    (eventType) =>
      eventType !== "interaction.wait_started" && eventType !== "interaction.wait_ended",
  ),
  "wait.started",
  "wait.ended",
  "health.capability_drift",
] as const;

export type EventV3 = Static<typeof EventV3Schema>;
export type EventTypeV3 = (typeof EVENT_V3_CORE_EVENT_TYPES)[number];
type ContractV3 = Static<typeof ContractV3Schema>;
type WithContractV3<T> = T extends object ? Omit<T, "contract"> & { contract: ContractV3 } : never;
export type EventOfTypeV3<T extends EventTypeV3> = T extends "session.ended"
  ? Static<typeof SessionEndedV3Schema>
  : T extends "turn.completed"
    ? Static<typeof TurnCompletedV3Schema>
    : T extends "tool.completed"
      ? Static<typeof ToolCompletedV3Schema>
      : T extends "command.completed"
        ? Static<typeof CommandCompletedV3Schema>
        : T extends "agent.started"
          ? Static<typeof AgentStartedV3Schema>
          : T extends "agent.completed"
            ? Static<typeof AgentCompletedV3Schema>
            : T extends "wait.started"
              ? Static<typeof WaitStartedV3Schema>
              : T extends "wait.ended"
                ? Static<typeof WaitEndedV3Schema>
                : T extends "health.capability_drift"
                  ? Static<typeof HealthCapabilityDriftV3Schema>
                  : T extends EventTypeV2
                    ? WithContractV3<EventOfTypeV2<T>>
                    : never;
export type EventPayloadV3<T extends EventTypeV3> = EventOfTypeV3<T>["payload"];
export type SpanSummaryV3 = Static<typeof SpanSummaryV3Schema>;
export type TurnUsageV3 = Static<typeof TurnUsageV3Schema>;
export type TurnInferenceV3 = Static<typeof TurnInferenceV3Schema>;
export type TurnHarnessV3 = Static<typeof TurnHarnessV3Schema>;
export type WaitKindV3 = Static<typeof WaitKindV3Schema>;
