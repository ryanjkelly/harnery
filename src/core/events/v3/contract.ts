import { type Static, type TObject, type TProperties, type TSchema, Type } from "@sinclair/typebox";
import {
  EVENT_V3_BASE_CORE_EVENT_TYPES,
  type EventOfTypeV3Base,
  type EventTypeV3Base,
  type EventV3Base,
  EventV3BaseSchema,
  ObservationV3BaseSchema,
  OutcomeV3BaseSchema,
  RecoveryV3BaseSchema,
} from "./base-contract.ts";

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

export const ObservationV3Schema = ObservationV3BaseSchema;
export const OutcomeV3Schema = OutcomeV3BaseSchema;
export const RecoveryV3Schema = RecoveryV3BaseSchema;

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

const baseBranches = (EventV3BaseSchema as unknown as { anyOf: TObject[] }).anyOf;

function baseBranch(eventType: string): TObject {
  const branch = baseBranches.find(
    ({ properties }) => (properties.event_type as { const?: string }).const === eventType,
  );
  if (!branch) throw new Error(`V3Base event schema missing: ${eventType}`);
  return branch;
}

function basePayload(eventType: string): TObject {
  return baseBranch(eventType).properties.payload as TObject;
}

function eventV3(
  priorEventType: string,
  options: { eventType?: string; payload?: TSchema; links?: TSchema } = {},
): TObject {
  const prior = baseBranch(priorEventType);
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
  const prior = basePayload(eventType);
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
  const prior = baseBranch("agent.started").properties.links as TObject;
  return StrictObject({
    ...prior.properties,
    span_id: SpanId,
    parent_span_id: SpanId,
  });
})();

export const AgentStartedV3Schema = eventV3("agent.started", {
  links: AgentStartedLinksV3Schema,
});

export const WaitStartedV3Schema = eventV3("wait.started", {
  eventType: "wait.started",
  payload: StrictObject({
    wait_id: SafeToken,
    kind: WaitKindV3Schema,
    authority_reference: Type.Optional(SafeToken),
    wake_at: Type.Optional(Timestamp),
  }),
});

export const WaitEndedV3Schema = eventV3("wait.ended", {
  eventType: "wait.ended",
  payload: terminalPayloadV3("wait.ended"),
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

const replacedBaseTypes = new Set([
  "session.ended",
  "turn.completed",
  "tool.completed",
  "command.completed",
  "agent.completed",
  "wait.started",
  "wait.ended",
]);
const unchangedV3Schemas = baseBranches
  .filter(
    ({ properties }) =>
      !replacedBaseTypes.has((properties.event_type as unknown as { const: string }).const),
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
  ...EVENT_V3_BASE_CORE_EVENT_TYPES.filter(
    (eventType) => eventType !== "wait.started" && eventType !== "wait.ended",
  ),
  "wait.started",
  "wait.ended",
  "health.capability_drift",
] as const;

export type EventTypeV3 = (typeof EVENT_V3_CORE_EVENT_TYPES)[number];
type ContractV3 = Static<typeof ContractV3Schema>;
type WithContractV3<T> = T extends object ? Omit<T, "contract"> & { contract: ContractV3 } : never;
type ReplaceEventV3<T extends EventTypeV3Base, U extends EventTypeV3, P> = Omit<
  WithContractV3<EventOfTypeV3Base<T>>,
  "event_type" | "payload"
> & {
  event_type: U;
  payload: P;
};
type SpanSummaryValueV3 = Static<typeof SpanSummaryV3Schema>;
type SessionEndedEventV3 = ReplaceEventV3<
  "session.ended",
  "session.ended",
  EventOfTypeV3Base<"session.ended">["payload"] & { span: SpanSummaryValueV3 }
>;
type TurnCompletedEventV3 = ReplaceEventV3<
  "turn.completed",
  "turn.completed",
  EventOfTypeV3Base<"turn.completed">["payload"] & {
    span: SpanSummaryValueV3;
    usage: Static<ReturnType<typeof ObservationV3Schema<typeof TurnUsageV3Schema>>>;
    inference: Static<ReturnType<typeof ObservationV3Schema<typeof TurnInferenceV3Schema>>>;
    harness: Static<ReturnType<typeof ObservationV3Schema<typeof TurnHarnessV3Schema>>>;
  }
>;
type ToolCompletedEventV3 = ReplaceEventV3<
  "tool.completed",
  "tool.completed",
  Omit<EventOfTypeV3Base<"tool.completed">["payload"], "duration_ms"> & {
    duration_ms: SpanSummaryValueV3["duration_ms"];
    span: SpanSummaryValueV3;
  }
>;
type CommandCompletedEventV3 = ReplaceEventV3<
  "command.completed",
  "command.completed",
  Omit<EventOfTypeV3Base<"command.completed">["payload"], "duration_ms"> & {
    duration_ms: SpanSummaryValueV3["duration_ms"];
    span: SpanSummaryValueV3;
  }
>;
type AgentStartedEventV3 = Omit<WithContractV3<EventOfTypeV3Base<"agent.started">>, "links"> & {
  links: EventOfTypeV3Base<"agent.started">["links"] & {
    span_id: `span_${string}`;
    parent_span_id: `span_${string}`;
  };
};
type AgentCompletedEventV3 = ReplaceEventV3<
  "agent.completed",
  "agent.completed",
  EventOfTypeV3Base<"agent.completed">["payload"] & { span: SpanSummaryValueV3 }
>;
type WaitStartedEventV3 = ReplaceEventV3<
  "wait.started",
  "wait.started",
  {
    wait_id: string;
    kind: Static<typeof WaitKindV3Schema>;
    authority_reference?: string;
    wake_at?: string;
  }
>;
type WaitEndedEventV3 = ReplaceEventV3<
  "wait.ended",
  "wait.ended",
  EventOfTypeV3Base<"wait.ended">["payload"] & { span: SpanSummaryValueV3 }
>;
type HealthCapabilityDriftEventV3 = ReplaceEventV3<
  "health.observed",
  "health.capability_drift",
  {
    signal: string;
    promised: "native" | "derived" | "conditional";
    expected_count: number;
    observed_count: number;
    generation_ended: boolean;
  }
>;
export type EventOfTypeV3<T extends EventTypeV3> = T extends "session.ended"
  ? SessionEndedEventV3
  : T extends "turn.completed"
    ? TurnCompletedEventV3
    : T extends "tool.completed"
      ? ToolCompletedEventV3
      : T extends "command.completed"
        ? CommandCompletedEventV3
        : T extends "agent.started"
          ? AgentStartedEventV3
          : T extends "agent.completed"
            ? AgentCompletedEventV3
            : T extends "wait.started"
              ? WaitStartedEventV3
              : T extends "wait.ended"
                ? WaitEndedEventV3
                : T extends "health.capability_drift"
                  ? HealthCapabilityDriftEventV3
                  : T extends EventTypeV3Base
                    ? WithContractV3<EventOfTypeV3Base<T>>
                    : never;
/**
 * TypeBox cannot preserve the discriminated union through the generated
 * schema-branch spread above. Rebuild the static union from the authoritative
 * event-type map so producer and projection code retains event narrowing.
 */
type ReplacedEventTypeV3Base =
  | "session.ended"
  | "turn.completed"
  | "tool.completed"
  | "command.completed"
  | "agent.started"
  | "agent.completed"
  | "wait.started"
  | "wait.ended";
type UnchangedEventV3 = WithContractV3<
  Exclude<EventV3Base, { event_type: ReplacedEventTypeV3Base }>
>;
export type EventV3 =
  | UnchangedEventV3
  | SessionEndedEventV3
  | TurnCompletedEventV3
  | ToolCompletedEventV3
  | CommandCompletedEventV3
  | AgentStartedEventV3
  | AgentCompletedEventV3
  | WaitStartedEventV3
  | WaitEndedEventV3
  | HealthCapabilityDriftEventV3;
export type EventPayloadV3<T extends EventTypeV3> = EventOfTypeV3<T>["payload"];
export type SpanSummaryV3 = Static<typeof SpanSummaryV3Schema>;
export type TurnUsageV3 = Static<typeof TurnUsageV3Schema>;
export type TurnInferenceV3 = Static<typeof TurnInferenceV3Schema>;
export type TurnHarnessV3 = Static<typeof TurnHarnessV3Schema>;
export type WaitKindV3 = Static<typeof WaitKindV3Schema>;
export type RuntimeAttestationV3 = EventPayloadV3<"session.started">["runtime_attestation"];
