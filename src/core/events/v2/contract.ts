import { type Static, type TProperties, type TSchema, Type } from "@sinclair/typebox";

export const EVENT_V2_CONTRACT_NAME = "harnery.event" as const;
export const EVENT_V2_CONTRACT_MAJOR = 2 as const;
export const EVENT_V2_SCHEMA_ID = "https://harnery.com/schemas/event-v2.schema.json";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const SafeToken = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$" });
const ReasonCode = Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,79}$" });
const Timestamp = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
});
const Sha256 = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const uuidV7Pattern = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const EventId = Type.String({ pattern: `^evt_${uuidV7Pattern}$` });
const RootId = Type.String({ pattern: "^root_[a-zA-Z0-9._-]{1,128}$" });
const InstanceId = Type.String({ pattern: "^inst_[a-zA-Z0-9._-]{1,128}$" });
const GenerationId = Type.String({ pattern: `^gen_${uuidV7Pattern}$` });
const AttestationId = Type.String({ pattern: `^att_${uuidV7Pattern}$` });
const ClockId = Type.String({ pattern: `^clk_${uuidV7Pattern}$` });
const SpanId = Type.String({ pattern: `^span_${uuidV7Pattern}$` });
const OpaqueNativeId = Type.String({ pattern: "^(sid|tid|hid)_[a-f0-9]{64}$" });

export const OutcomeV2Schema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
  Type.Literal("denied"),
  Type.Literal("interrupted"),
  Type.Literal("unknown"),
]);

export const FingerprintV2Schema = StrictObject({
  algorithm: Type.Literal("hmac-sha256"),
  canonicalizer: Type.Literal("harnery-jcs-nfc-v1"),
  key_epoch: Type.String({ pattern: "^pep_[a-zA-Z0-9._-]{1,128}$" }),
  scope: Type.Union([Type.Literal("generation"), Type.Literal("root")]),
  digest: Sha256,
});

export const ContentDescriptorV2Schema = StrictObject({
  storage: Type.Union([Type.Literal("omitted"), Type.Literal("artifact_reference")]),
  media_type: Type.String({ pattern: "^[a-z0-9.+-]+/[a-z0-9.+-]+$", maxLength: 127 }),
  bytes: Type.Integer({ minimum: 0 }),
  lines: Type.Optional(Type.Integer({ minimum: 0 })),
  artifact_id: Type.Optional(Type.String({ pattern: "^art_[a-zA-Z0-9._-]{1,128}$" })),
  fingerprint: Type.Optional(FingerprintV2Schema),
});

export function ObservationV2Schema<T extends TSchema>(value: T) {
  return Type.Union([
    StrictObject({
      state: Type.Literal("observed"),
      value,
      attestation: Type.Union([
        Type.Literal("native"),
        Type.Literal("derived"),
        Type.Literal("inferred"),
      ]),
      confidence: Type.Union([
        Type.Literal("exact"),
        Type.Literal("high"),
        Type.Literal("medium"),
        Type.Literal("low"),
      ]),
    }),
    StrictObject({ state: Type.Literal("unsupported"), capability: SafeToken }),
    StrictObject({
      state: Type.Literal("expected_but_missing"),
      capability: SafeToken,
      reason: ReasonCode,
    }),
    StrictObject({ state: Type.Literal("redacted"), reason: ReasonCode }),
    StrictObject({ state: Type.Literal("unknown"), reason: ReasonCode }),
    StrictObject({ state: Type.Literal("not_applicable") }),
  ]);
}

export const RuntimeAttestationV2Schema = StrictObject({
  attestation_id: AttestationId,
  generation_id: GenerationId,
  adapter: ObservationV2Schema(StrictObject({ id: SafeToken, version: Type.Optional(SafeToken) })),
  harness: ObservationV2Schema(StrictObject({ id: SafeToken, version: Type.Optional(SafeToken) })),
  model: ObservationV2Schema(StrictObject({ provider: SafeToken, id: SafeToken })),
  capability_profile: Type.String({ pattern: "^cap_[a-f0-9]{64}$" }),
  declared_by_event_id: EventId,
});

const ContractSchema = StrictObject({
  name: Type.Literal(EVENT_V2_CONTRACT_NAME),
  major: Type.Literal(EVENT_V2_CONTRACT_MAJOR),
  schema_digest: Sha256,
});

const TimeSchema = StrictObject({
  observed_at: Timestamp,
  recorded_at: Timestamp,
  monotonic_ns: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
  clock_id: ClockId,
  skew: Type.Union([Type.Literal("normal"), Type.Literal("regressed"), Type.Literal("unknown")]),
});

const ProducerSchema = StrictObject({
  producer_id: Type.String({ pattern: "^prd_[a-zA-Z0-9._-]{1,128}$" }),
  boot_id: Type.String({ pattern: "^boot_[a-zA-Z0-9._-]{1,128}$" }),
  sequence: Type.Integer({ minimum: 1 }),
  component: Type.Union([
    Type.Literal("agent-hook"),
    Type.Literal("agent-coord"),
    Type.Literal("session-tee"),
    Type.Literal("projector"),
    Type.Literal("health"),
    Type.Literal("recovery"),
  ]),
  build_id: Type.String({ pattern: "^build_[a-zA-Z0-9._-]{1,128}$" }),
  platform: Type.Union([
    Type.Literal("linux"),
    Type.Literal("windows"),
    Type.Literal("macos"),
    Type.Literal("unknown"),
  ]),
  bridge: Type.Optional(Type.Literal("codex-wsl")),
});

const RootScopeSchema = StrictObject({
  root_id: RootId,
  instance_id: InstanceId,
  run_id: Type.Optional(Type.String({ pattern: "^run_[a-zA-Z0-9._-]{1,128}$" })),
  workflow_id: Type.Optional(Type.String({ pattern: "^wf_[a-zA-Z0-9._-]{1,128}$" })),
});

const GenerationScopeSchema = StrictObject({
  root_id: RootId,
  instance_id: InstanceId,
  run_id: Type.Optional(Type.String({ pattern: "^run_[a-zA-Z0-9._-]{1,128}$" })),
  workflow_id: Type.Optional(Type.String({ pattern: "^wf_[a-zA-Z0-9._-]{1,128}$" })),
  session_id: OpaqueNativeId,
  generation_id: GenerationId,
  turn_id: Type.Optional(OpaqueNativeId),
});

const TurnScopeSchema = StrictObject({
  root_id: RootId,
  instance_id: InstanceId,
  run_id: Type.Optional(Type.String({ pattern: "^run_[a-zA-Z0-9._-]{1,128}$" })),
  workflow_id: Type.Optional(Type.String({ pattern: "^wf_[a-zA-Z0-9._-]{1,128}$" })),
  session_id: OpaqueNativeId,
  generation_id: GenerationId,
  turn_id: OpaqueNativeId,
});

const LinksSchema = StrictObject({
  caused_by: Type.Array(EventId, { maxItems: 64, uniqueItems: true }),
  span_id: Type.Optional(SpanId),
  parent_span_id: Type.Optional(SpanId),
  parent_generation_id: Type.Optional(GenerationId),
  delegation_id: Type.Optional(Type.String({ pattern: "^del_[0-9a-f-]{36}$" })),
});

const ToolLinksSchema = StrictObject({
  caused_by: Type.Array(EventId, { maxItems: 64, uniqueItems: true }),
  span_id: SpanId,
  parent_span_id: Type.Optional(SpanId),
  parent_generation_id: Type.Optional(GenerationId),
  delegation_id: Type.Optional(Type.String({ pattern: `^del_${uuidV7Pattern}$` })),
});

const ProvenanceSchema = StrictObject({
  source_event: SafeToken,
  attestation: Type.Union([
    Type.Literal("native"),
    Type.Literal("derived"),
    Type.Literal("inferred"),
    Type.Literal("operator"),
  ]),
  confidence: Type.Union([
    Type.Literal("exact"),
    Type.Literal("high"),
    Type.Literal("medium"),
    Type.Literal("low"),
  ]),
  source_record_id: Type.Optional(OpaqueNativeId),
  attribution: StrictObject({
    method: Type.Union([
      Type.Literal("session_env"),
      Type.Literal("native_payload"),
      Type.Literal("heartbeat_match"),
      Type.Literal("explicit_argument"),
      Type.Literal("unattributed"),
    ]),
    state: Type.Union([
      Type.Literal("verified"),
      Type.Literal("unverified"),
      Type.Literal("conflict"),
    ]),
    observer_instance_id: Type.Optional(InstanceId),
    subject_instance_id: Type.Optional(InstanceId),
  }),
});

const eventSchema = <TType extends string, TPayload extends TSchema>(
  eventType: TType,
  payload: TPayload,
  scopeKind: "root" | "generation" | "turn" = "generation",
  links: TSchema = LinksSchema,
) =>
  StrictObject({
    contract: ContractSchema,
    event_id: EventId,
    event_type: Type.Literal(eventType),
    time: TimeSchema,
    producer: ProducerSchema,
    scope:
      scopeKind === "root"
        ? RootScopeSchema
        : scopeKind === "turn"
          ? TurnScopeSchema
          : GenerationScopeSchema,
    ...(scopeKind !== "root" ? { attestation_id: AttestationId } : {}),
    links,
    provenance: ProvenanceSchema,
    payload,
  });

export const LedgerGenesisV2Schema = eventSchema(
  "ledger.genesis",
  StrictObject({
    genesis_id: Type.String({ pattern: "^gex_[0-9a-f-]{36}$" }),
    contract_digest: Sha256,
    generated_schema_digest: Sha256,
    v1_terminal_segment_digest: Sha256,
    canonicalizer: Type.Literal("harnery-jcs-nfc-v1"),
    privacy_epoch_id: Type.String({ pattern: "^pep_[a-zA-Z0-9._-]{1,128}$" }),
    candidate_created_at: Timestamp,
  }),
  "root",
);

export const SessionStartedV2Schema = eventSchema(
  "session.started",
  StrictObject({
    runtime_attestation: RuntimeAttestationV2Schema,
    resume: ObservationV2Schema(
      StrictObject({ prior_generation_id: GenerationId, continuity: Type.Literal("native") }),
    ),
  }),
);

export const SessionEndedV2Schema = eventSchema(
  "session.ended",
  StrictObject({
    outcome: OutcomeV2Schema,
    authority: Type.Union([Type.Literal("native"), Type.Literal("approved")]),
    reason: ReasonCode,
    completeness: ObservationV2Schema(
      StrictObject({
        expected: Type.Array(SafeToken, { uniqueItems: true }),
        observed: Type.Array(SafeToken, { uniqueItems: true }),
        missing: Type.Array(SafeToken, { uniqueItems: true }),
      }),
    ),
  }),
);

export const TurnStartedV2Schema = eventSchema(
  "turn.started",
  StrictObject({
    input: ContentDescriptorV2Schema,
    intent_kind: Type.Union([
      Type.Literal("build"),
      Type.Literal("change"),
      Type.Literal("diagnose"),
      Type.Literal("review"),
      Type.Literal("explain"),
      Type.Literal("coordinate"),
      Type.Literal("unknown"),
    ]),
  }),
  "turn",
);

export const TurnCompletedV2Schema = eventSchema(
  "turn.completed",
  StrictObject({
    outcome: OutcomeV2Schema,
    duration_ms: Type.Integer({ minimum: 0 }),
    tool_call_count: Type.Integer({ minimum: 0 }),
    response: ContentDescriptorV2Schema,
  }),
  "turn",
);

export const ToolRequestedV2Schema = eventSchema(
  "tool.requested",
  StrictObject({
    tool: StrictObject({ namespace: SafeToken, name: SafeToken }),
    input: ContentDescriptorV2Schema,
    exact_input: FingerprintV2Schema,
    targets: Type.Array(
      StrictObject({
        kind: Type.Union([
          Type.Literal("workspace_path"),
          Type.Literal("external_path"),
          Type.Literal("url"),
          Type.Literal("query"),
          Type.Literal("pattern"),
          Type.Literal("artifact"),
          Type.Literal("service"),
          Type.Literal("resource"),
        ]),
        access: Type.Union([
          Type.Literal("read"),
          Type.Literal("write"),
          Type.Literal("execute"),
          Type.Literal("publish"),
          Type.Literal("delete"),
          Type.Literal("unknown"),
        ]),
        display: Type.Optional(Type.String({ maxLength: 240 })),
        fingerprint: FingerprintV2Schema,
        extractor_version: SafeToken,
      }),
      { maxItems: 64 },
    ),
  }),
  "turn",
  ToolLinksSchema,
);

export const ToolCompletedV2Schema = eventSchema(
  "tool.completed",
  StrictObject({
    tool: StrictObject({ namespace: SafeToken, name: SafeToken }),
    outcome: OutcomeV2Schema,
    duration_ms: Type.Integer({ minimum: 0 }),
    result: ContentDescriptorV2Schema,
    error: Type.Optional(StrictObject({ class: SafeToken, code: Type.Optional(SafeToken) })),
  }),
  "turn",
  ToolLinksSchema,
);

export const EventV2Schema = Type.Union(
  [
    LedgerGenesisV2Schema,
    SessionStartedV2Schema,
    SessionEndedV2Schema,
    TurnStartedV2Schema,
    TurnCompletedV2Schema,
    ToolRequestedV2Schema,
    ToolCompletedV2Schema,
  ],
  { $id: EVENT_V2_SCHEMA_ID },
);

export const EVENT_V2_CORE_EVENT_TYPES = [
  "ledger.genesis",
  "session.started",
  "session.ended",
  "turn.started",
  "turn.completed",
  "tool.requested",
  "tool.completed",
] as const;

export type EventV2 = Static<typeof EventV2Schema>;
export type EventTypeV2 = EventV2["event_type"];
export type EventOfTypeV2<T extends EventTypeV2> = Extract<EventV2, { event_type: T }>;
export type EventPayloadV2<T extends EventTypeV2> = EventOfTypeV2<T>["payload"];
export type RuntimeAttestationV2 = Static<typeof RuntimeAttestationV2Schema>;
export type ContentDescriptorV2 = Static<typeof ContentDescriptorV2Schema>;
