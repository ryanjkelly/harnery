import { type Static, type TProperties, type TSchema, Type } from "@sinclair/typebox";

export const EVENT_V3_BASE_CONTRACT_NAME = "harnery.event" as const;
export const EVENT_V3_BASE_CONTRACT_MAJOR = 3 as const;
export const EVENT_V3_BASE_SCHEMA_ID = "https://harnery.com/schemas/event-v3-base.schema.json";

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

export const OutcomeV3BaseSchema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
  Type.Literal("denied"),
  Type.Literal("interrupted"),
  Type.Literal("unknown"),
]);

export const RecoveryReasonV3BaseSchema = Type.Union([
  Type.Literal("request_not_observed"),
  Type.Literal("completion_not_observed_before_turn_end"),
  Type.Literal("completion_not_observed_before_next_turn"),
  Type.Literal("span_cap_pressure"),
  Type.Literal("explicit_end_salvage"),
  Type.Literal("command_completion_not_observed"),
]);

/**
 * Marker of a machinery-minted recovery event (ADR 0078). Presence requires
 * derived attestation; on completions it also requires an unknown outcome.
 * `requested_event_id` links a derived terminal to the span's original
 * request event when producer state still holds it.
 */
export const RecoveryV3BaseSchema = StrictObject({
  reason: RecoveryReasonV3BaseSchema,
  requested_event_id: Type.Optional(EventId),
  elapsed_upper_bound_ms: Type.Optional(ObservationV3BaseSchema(Type.Integer({ minimum: 0 }))),
});

export const FingerprintV3BaseSchema = StrictObject({
  algorithm: Type.Literal("hmac-sha256"),
  canonicalizer: Type.Literal("harnery-jcs-nfc-v1"),
  key_epoch: Type.String({ pattern: "^pep_[a-zA-Z0-9._-]{1,128}$" }),
  scope: Type.Union([Type.Literal("generation"), Type.Literal("root")]),
  digest: Sha256,
});

export const ContentDescriptorV3BaseSchema = StrictObject({
  storage: Type.Union([Type.Literal("omitted"), Type.Literal("artifact_reference")]),
  media_type: Type.String({ pattern: "^[a-z0-9.+-]+/[a-z0-9.+-]+$", maxLength: 127 }),
  bytes: Type.Integer({ minimum: 0 }),
  lines: Type.Optional(Type.Integer({ minimum: 0 })),
  artifact_id: Type.Optional(Type.String({ pattern: "^art_[a-zA-Z0-9._-]{1,128}$" })),
  fingerprint: Type.Optional(FingerprintV3BaseSchema),
});

export function ObservationV3BaseSchema<T extends TSchema>(value: T) {
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

export const RuntimeAttestationV3BaseSchema = StrictObject({
  attestation_id: AttestationId,
  generation_id: GenerationId,
  adapter: ObservationV3BaseSchema(
    StrictObject({ id: SafeToken, version: Type.Optional(SafeToken) }),
  ),
  harness: ObservationV3BaseSchema(
    StrictObject({ id: SafeToken, version: Type.Optional(SafeToken) }),
  ),
  model: ObservationV3BaseSchema(StrictObject({ provider: SafeToken, id: SafeToken })),
  /** Runtime tuning identity: the effort dial (and speed tier where the
   * runtime reports one). `observed` with a missing `effort` never occurs —
   * a runtime that proved the model has no dial attests `unsupported` with
   * capability `effort_selection` instead. Values pass through verbatim
   * (`low`…`max`, `standard`/`fast`); display labels are a renderer concern. */
  tuning: ObservationV3BaseSchema(
    StrictObject({
      effort: Type.Optional(SafeToken),
      speed: Type.Optional(SafeToken),
    }),
  ),
  capability_profile: Type.String({ pattern: "^cap_[a-f0-9]{64}$" }),
  declared_by_event_id: EventId,
});

const ContractSchema = StrictObject({
  name: Type.Literal(EVENT_V3_BASE_CONTRACT_NAME),
  major: Type.Literal(EVENT_V3_BASE_CONTRACT_MAJOR),
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
  workflow_agent_id: Type.Optional(SafeToken),
});

const GenerationScopeSchema = StrictObject({
  root_id: RootId,
  instance_id: InstanceId,
  run_id: Type.Optional(Type.String({ pattern: "^run_[a-zA-Z0-9._-]{1,128}$" })),
  workflow_id: Type.Optional(Type.String({ pattern: "^wf_[a-zA-Z0-9._-]{1,128}$" })),
  workflow_agent_id: Type.Optional(SafeToken),
  session_id: OpaqueNativeId,
  generation_id: GenerationId,
  turn_id: Type.Optional(OpaqueNativeId),
});

const TurnScopeSchema = StrictObject({
  root_id: RootId,
  instance_id: InstanceId,
  run_id: Type.Optional(Type.String({ pattern: "^run_[a-zA-Z0-9._-]{1,128}$" })),
  workflow_id: Type.Optional(Type.String({ pattern: "^wf_[a-zA-Z0-9._-]{1,128}$" })),
  workflow_agent_id: Type.Optional(SafeToken),
  session_id: OpaqueNativeId,
  generation_id: GenerationId,
  turn_id: OpaqueNativeId,
});

const LinksSchema = StrictObject({
  caused_by: Type.Array(EventId, { maxItems: 64, uniqueItems: true }),
  span_id: Type.Optional(SpanId),
  parent_span_id: Type.Optional(SpanId),
  parent_generation_id: Type.Optional(GenerationId),
  delegation_id: Type.Optional(Type.String({ pattern: `^del_${uuidV7Pattern}$` })),
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

export const LedgerGenesisV3BaseSchema = eventSchema(
  "ledger.genesis",
  StrictObject({
    genesis_id: Type.String({ pattern: "^gex_[0-9a-f-]{36}$" }),
    genesis_profile_digest: Sha256,
    contract_digest: Sha256,
    generated_schema_digest: Sha256,
    canonicalizer: Type.Literal("harnery-jcs-nfc-v1"),
    privacy_epoch_id: Type.String({ pattern: "^pep_[a-zA-Z0-9._-]{1,128}$" }),
    candidate_created_at: Timestamp,
  }),
  "root",
);

export const SessionStartedV3BaseSchema = eventSchema(
  "session.started",
  StrictObject({
    runtime_attestation: RuntimeAttestationV3BaseSchema,
    resume: ObservationV3BaseSchema(
      StrictObject({ prior_generation_id: GenerationId, continuity: Type.Literal("native") }),
    ),
  }),
);

export const SessionEndedV3BaseSchema = eventSchema(
  "session.ended",
  StrictObject({
    outcome: OutcomeV3BaseSchema,
    authority: Type.Union([Type.Literal("native"), Type.Literal("approved")]),
    reason: ReasonCode,
    completeness: ObservationV3BaseSchema(
      StrictObject({
        expected: Type.Array(SafeToken, { uniqueItems: true }),
        observed: Type.Array(SafeToken, { uniqueItems: true }),
        missing: Type.Array(SafeToken, { uniqueItems: true }),
      }),
    ),
  }),
);

export const TurnStartedV3BaseSchema = eventSchema(
  "turn.started",
  StrictObject({
    input: ContentDescriptorV3BaseSchema,
    intent_kind: Type.Union([
      Type.Literal("build"),
      Type.Literal("change"),
      Type.Literal("diagnose"),
      Type.Literal("review"),
      Type.Literal("explain"),
      Type.Literal("coordinate"),
      Type.Literal("unknown"),
    ]),
    stop_remediation: Type.Optional(Type.Boolean()),
  }),
  "turn",
);

export const TurnRitualV3BaseSchema = StrictObject({
  status_box_present: ObservationV3BaseSchema(Type.Boolean()),
  status_box_present_strict: ObservationV3BaseSchema(Type.Boolean()),
  session_name: ObservationV3BaseSchema(
    StrictObject({
      required: Type.Boolean(),
      present: Type.Boolean(),
    }),
  ),
});

export const TurnCompletedV3BaseSchema = eventSchema(
  "turn.completed",
  StrictObject({
    outcome: OutcomeV3BaseSchema,
    duration_ms: ObservationV3BaseSchema(Type.Integer({ minimum: 0 })),
    tool_call_count: ObservationV3BaseSchema(Type.Integer({ minimum: 0 })),
    wait_count: Type.Optional(ObservationV3BaseSchema(Type.Integer({ minimum: 0 }))),
    response: ObservationV3BaseSchema(ContentDescriptorV3BaseSchema),
    ritual: Type.Optional(TurnRitualV3BaseSchema),
  }),
  "turn",
);

export const TargetDescriptorV3BaseSchema = StrictObject({
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
  fingerprint: FingerprintV3BaseSchema,
  extractor_version: SafeToken,
});

export const ToolRequestedV3BaseSchema = eventSchema(
  "tool.requested",
  StrictObject({
    tool: StrictObject({ namespace: SafeToken, name: SafeToken }),
    input: ContentDescriptorV3BaseSchema,
    exact_input: FingerprintV3BaseSchema,
    targets: Type.Array(TargetDescriptorV3BaseSchema, { maxItems: 64 }),
    recovery: Type.Optional(RecoveryV3BaseSchema),
  }),
  "turn",
  ToolLinksSchema,
);

export const ToolCompletedV3BaseSchema = eventSchema(
  "tool.completed",
  StrictObject({
    tool: StrictObject({ namespace: SafeToken, name: SafeToken }),
    outcome: OutcomeV3BaseSchema,
    duration_ms: ObservationV3BaseSchema(Type.Integer({ minimum: 0 })),
    result: ContentDescriptorV3BaseSchema,
    error: Type.Optional(StrictObject({ class: SafeToken, code: Type.Optional(SafeToken) })),
    recovery: Type.Optional(RecoveryV3BaseSchema),
  }),
  "turn",
  ToolLinksSchema,
);

const AuthorityReferenceSchema = StrictObject({
  transaction_id: Type.Optional(Type.String({ pattern: "^txn_[0-9a-f-]{36}$" })),
  record_id: Type.Optional(SafeToken),
});

const MeasurementSchema = StrictObject({
  used_tokens: Type.Integer({ minimum: 0 }),
  limit_tokens: Type.Integer({ minimum: 1 }),
  remaining_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
  measured_at: Timestamp,
  method: SafeToken,
});

const ArtifactReferenceSchema = StrictObject({
  artifact_id: Type.String({ pattern: "^art_[a-zA-Z0-9._-]{1,128}$" }),
  kind: SafeToken,
  media_type: Type.String({ pattern: "^[a-z0-9.+-]+/[a-z0-9.+-]+$", maxLength: 127 }),
  bytes: Type.Integer({ minimum: 0 }),
  retention_class: SafeToken,
  integrity: Type.Optional(FingerprintV3BaseSchema),
  workspace_path: Type.Optional(
    Type.String({ pattern: "^(?!.*(?:^|/)\\.\\.(?:/|$))[^/\\\\][^\\\\]{0,239}$" }),
  ),
});

const StateTransitionSchema = StrictObject({
  actor_instance_id: InstanceId,
  subject_instance_id: InstanceId,
  prior_state: Type.Optional(SafeToken),
  new_state: SafeToken,
  reason: ReasonCode,
  reason_fingerprint: Type.Optional(FingerprintV3BaseSchema),
  authority: AuthorityReferenceSchema,
});

export const LedgerActivatedV3BaseSchema = eventSchema(
  "ledger.activated",
  StrictObject({
    activation_id: Type.String({ pattern: "^act_[0-9a-f-]{36}$" }),
    genesis_id: Type.String({ pattern: "^gex_[0-9a-f-]{36}$" }),
    candidate_digest: Sha256,
    approval_record_id: SafeToken,
    eligible_after_event_id: EventId,
    activated_at: Timestamp,
  }),
  "root",
);

export const LedgerSchemaAdvancedV3BaseSchema = eventSchema(
  "ledger.schema_advanced",
  StrictObject({
    prior_schema_digest: Sha256,
    next_schema_digest: Sha256,
    generated_artifact_digest: Sha256,
    compatible_reader_builds: Type.Array(SafeToken, {
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
    }),
    release_reference: SafeToken,
    effective_segment_ordinal: Type.Integer({ minimum: 0 }),
    effective_byte_offset: Type.Integer({ minimum: 0 }),
  }),
  "root",
);

export const LedgerComparabilityAdvancedV3BaseSchema = eventSchema(
  "ledger.comparability_advanced",
  StrictObject({
    prior_group_id: SafeToken,
    next_group_id: SafeToken,
    canonicalizer: Type.Literal("harnery-jcs-nfc-v1"),
    fingerprint_version: SafeToken,
    privacy_epoch_id: Type.String({ pattern: "^pep_[a-zA-Z0-9._-]{1,128}$" }),
    approval_record_id: SafeToken,
    reason: ReasonCode,
  }),
  "root",
);

export const SessionAttestationChangedV3BaseSchema = eventSchema(
  "session.attestation_changed",
  StrictObject({
    prior_attestation_id: AttestationId,
    runtime_attestation: RuntimeAttestationV3BaseSchema,
    reason: ReasonCode,
  }),
);

export const SessionResumedV3BaseSchema = eventSchema(
  "session.resumed",
  StrictObject({
    prior_generation_id: GenerationId,
    continuity: Type.Union([Type.Literal("native"), Type.Literal("derived")]),
    evidence_reference: SafeToken,
  }),
);

export const SessionTerminationObservedV3BaseSchema = eventSchema(
  "session.termination_observed",
  StrictObject({
    observation: Type.Union([
      Type.Literal("stale"),
      Type.Literal("killed"),
      Type.Literal("disappeared"),
      Type.Literal("hook_silent"),
    ]),
    observer_instance_id: InstanceId,
    subject_instance_id: InstanceId,
    provisional: Type.Literal(true),
    reason: ReasonCode,
  }),
);

export const RunStartedV3BaseSchema = eventSchema(
  "run.started",
  StrictObject({ run_kind: SafeToken, policy_digest: Type.Optional(Sha256) }),
);

export const RunCompletedV3BaseSchema = eventSchema(
  "run.completed",
  StrictObject({
    outcome: OutcomeV3BaseSchema,
    duration_ms: Type.Integer({ minimum: 0 }),
    evidence_reference: Type.Optional(SafeToken),
  }),
);

export const CommandStartedV3BaseSchema = eventSchema(
  "command.started",
  StrictObject({
    executable: SafeToken,
    executable_class: SafeToken,
    exact_command: FingerprintV3BaseSchema,
    intent_kind: SafeToken,
    intent_length: Type.Integer({ minimum: 0 }),
    intent_fingerprint: Type.Optional(FingerprintV3BaseSchema),
    sensitive_argument_count: Type.Integer({ minimum: 0 }),
  }),
  "turn",
  ToolLinksSchema,
);

export const CommandOutputObservedV3BaseSchema = eventSchema(
  "command.output_observed",
  StrictObject({
    stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("combined")]),
    bytes: Type.Integer({ minimum: 0 }),
    lines: Type.Optional(Type.Integer({ minimum: 0 })),
    content_fingerprint: Type.Optional(FingerprintV3BaseSchema),
  }),
  "turn",
  ToolLinksSchema,
);

export const CommandCompletedV3BaseSchema = eventSchema(
  "command.completed",
  StrictObject({
    outcome: OutcomeV3BaseSchema,
    exit_code: Type.Optional(Type.Integer()),
    signal: Type.Optional(SafeToken),
    duration_ms: Type.Integer({ minimum: 0 }),
    error_class: Type.Optional(SafeToken),
    recovery: Type.Optional(RecoveryV3BaseSchema),
  }),
  "turn",
  ToolLinksSchema,
);

export const ContextObservedV3BaseSchema = eventSchema(
  "context.observed",
  StrictObject({ measurement: ObservationV3BaseSchema(MeasurementSchema) }),
);

export const ContextCompactionStartedV3BaseSchema = eventSchema(
  "context.compaction_started",
  StrictObject({ before: ObservationV3BaseSchema(MeasurementSchema), method: SafeToken }),
);

export const ContextCompactionCompletedV3BaseSchema = eventSchema(
  "context.compaction_completed",
  StrictObject({
    outcome: OutcomeV3BaseSchema,
    before: ObservationV3BaseSchema(MeasurementSchema),
    after: ObservationV3BaseSchema(MeasurementSchema),
  }),
);

export const ContextCheckpointedV3BaseSchema = eventSchema(
  "context.checkpointed",
  StrictObject({ checkpoint_id: SafeToken, artifact: ArtifactReferenceSchema }),
);

export const ContextRecoveryInjectedV3BaseSchema = eventSchema(
  "context.recovery_injected",
  StrictObject({ checkpoint_id: SafeToken, outcome: OutcomeV3BaseSchema, artifact_id: SafeToken }),
);

export const AgentDelegatedV3BaseSchema = eventSchema(
  "agent.delegated",
  StrictObject({
    delegation_id: Type.String({ pattern: `^del_${uuidV7Pattern}$` }),
    child_generation_id: GenerationId,
    role: SafeToken,
    ownership_fingerprint: FingerprintV3BaseSchema,
  }),
);

export const AgentStartedV3BaseSchema = eventSchema(
  "agent.started",
  StrictObject({
    delegation_id: Type.String({ pattern: `^del_${uuidV7Pattern}$` }),
    child_generation_id: GenerationId,
    role: SafeToken,
  }),
);

export const AgentCompletedV3BaseSchema = eventSchema(
  "agent.completed",
  StrictObject({
    delegation_id: Type.String({ pattern: `^del_${uuidV7Pattern}$` }),
    child_generation_id: GenerationId,
    outcome: OutcomeV3BaseSchema,
  }),
);

export const WaitStartedV3BaseSchema = eventSchema(
  "wait.started",
  StrictObject({
    wait_id: SafeToken,
    kind: Type.Union([
      Type.Literal("permission"),
      Type.Literal("approval"),
      Type.Literal("decision"),
      Type.Literal("operator_input"),
      Type.Literal("dependency"),
      Type.Literal("scheduled"),
    ]),
    authority_reference: Type.Optional(SafeToken),
    wake_at: Type.Optional(Timestamp),
  }),
);

export const WaitEndedV3BaseSchema = eventSchema(
  "wait.ended",
  StrictObject({
    wait_id: SafeToken,
    outcome: OutcomeV3BaseSchema,
    resolution_reference: Type.Optional(SafeToken),
  }),
);

export const ArtifactObservedV3BaseSchema = eventSchema(
  "artifact.observed",
  StrictObject({
    artifact: ArtifactReferenceSchema,
    operation: Type.Union([
      Type.Literal("created"),
      Type.Literal("updated"),
      Type.Literal("viewed"),
      Type.Literal("published"),
    ]),
  }),
);

export const ProgressObservedV3BaseSchema = eventSchema(
  "progress.observed",
  StrictObject({
    kind: Type.Union([
      Type.Literal("write"),
      Type.Literal("test"),
      Type.Literal("commit"),
      Type.Literal("deploy"),
      Type.Literal("publication"),
      Type.Literal("review"),
      Type.Literal("artifact"),
    ]),
    evidence_event_ids: Type.Array(EventId, { minItems: 1, maxItems: 64, uniqueItems: true }),
    reducer_build_id: SafeToken,
  }),
);

export const CoordTaskChangedV3BaseSchema = eventSchema(
  "coord.task_changed",
  StateTransitionSchema,
);
export const CoordLifecycleChangedV3BaseSchema = eventSchema(
  "coord.lifecycle_changed",
  StateTransitionSchema,
);
export const CoordStatusObservedV3BaseSchema = eventSchema(
  "coord.status_observed",
  StrictObject({
    observer_instance_id: InstanceId,
    subject_instance_id: InstanceId,
    status: SafeToken,
  }),
);
export const CoordClaimChangedV3BaseSchema = eventSchema(
  "coord.claim_changed",
  StrictObject({
    actor_instance_id: InstanceId,
    subject_instance_id: InstanceId,
    operation: Type.Union([
      Type.Literal("acquired"),
      Type.Literal("released"),
      Type.Literal("denied"),
    ]),
    target: TargetDescriptorV3BaseSchema,
    access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
    authority: AuthorityReferenceSchema,
  }),
);
export const CoordPresenceChangedV3BaseSchema = eventSchema(
  "coord.presence_changed",
  StateTransitionSchema,
);
export const CoordMessageObservedV3BaseSchema = eventSchema(
  "coord.message_observed",
  StrictObject({
    message_id: SafeToken,
    direction: Type.Union([Type.Literal("sent"), Type.Literal("received")]),
    peer_instance_id: InstanceId,
    body_length: Type.Integer({ minimum: 0 }),
    body_fingerprint: FingerprintV3BaseSchema,
  }),
);
export const CoordIdentityAttestedV3BaseSchema = eventSchema(
  "coord.identity_attested",
  StrictObject({
    actor_instance_id: InstanceId,
    subject_instance_id: InstanceId,
    identity_id: SafeToken,
    method: SafeToken,
    authority: AuthorityReferenceSchema,
  }),
);

export const CouncilStateChangedV3BaseSchema = eventSchema(
  "council.state_changed",
  StrictObject({
    council_id: SafeToken,
    prior_state: Type.Optional(SafeToken),
    new_state: SafeToken,
    record_digest: Sha256,
  }),
);
export const DecisionStateChangedV3BaseSchema = eventSchema(
  "decision.state_changed",
  StrictObject({
    decision_id: SafeToken,
    prior_state: Type.Optional(SafeToken),
    new_state: SafeToken,
    record_digest: Sha256,
    authority: AuthorityReferenceSchema,
  }),
);
export const LifecycleRecoveredV3BaseSchema = eventSchema(
  "lifecycle.recovered",
  StrictObject({
    subject_instance_id: InstanceId,
    recovery_kind: SafeToken,
    prior_digest: Type.Optional(Sha256),
    new_digest: Sha256,
  }),
);
export const LifecycleSweepObservedV3BaseSchema = eventSchema(
  "lifecycle.sweep_observed",
  StrictObject({
    subject_instance_id: InstanceId,
    observation: SafeToken,
    provisional: Type.Literal(true),
    age_ms: Type.Integer({ minimum: 0 }),
  }),
);
export const HealthObservedV3BaseSchema = eventSchema(
  "health.observed",
  StrictObject({
    subsystem: SafeToken,
    severity: Type.Union([
      Type.Literal("unknown"),
      Type.Literal("healthy"),
      Type.Literal("attention"),
      Type.Literal("critical"),
    ]),
    condition: ReasonCode,
    action: Type.Literal("none"),
    evidence_reference: Type.Optional(SafeToken),
    recovered: Type.Boolean(),
  }),
);

export const EventV3BaseSchema = Type.Union(
  [
    LedgerGenesisV3BaseSchema,
    LedgerActivatedV3BaseSchema,
    LedgerSchemaAdvancedV3BaseSchema,
    LedgerComparabilityAdvancedV3BaseSchema,
    SessionStartedV3BaseSchema,
    SessionAttestationChangedV3BaseSchema,
    SessionResumedV3BaseSchema,
    SessionEndedV3BaseSchema,
    SessionTerminationObservedV3BaseSchema,
    RunStartedV3BaseSchema,
    RunCompletedV3BaseSchema,
    TurnStartedV3BaseSchema,
    TurnCompletedV3BaseSchema,
    ToolRequestedV3BaseSchema,
    ToolCompletedV3BaseSchema,
    CommandStartedV3BaseSchema,
    CommandOutputObservedV3BaseSchema,
    CommandCompletedV3BaseSchema,
    ContextObservedV3BaseSchema,
    ContextCompactionStartedV3BaseSchema,
    ContextCompactionCompletedV3BaseSchema,
    ContextCheckpointedV3BaseSchema,
    ContextRecoveryInjectedV3BaseSchema,
    AgentDelegatedV3BaseSchema,
    AgentStartedV3BaseSchema,
    AgentCompletedV3BaseSchema,
    WaitStartedV3BaseSchema,
    WaitEndedV3BaseSchema,
    ArtifactObservedV3BaseSchema,
    ProgressObservedV3BaseSchema,
    CoordTaskChangedV3BaseSchema,
    CoordLifecycleChangedV3BaseSchema,
    CoordStatusObservedV3BaseSchema,
    CoordClaimChangedV3BaseSchema,
    CoordPresenceChangedV3BaseSchema,
    CoordMessageObservedV3BaseSchema,
    CoordIdentityAttestedV3BaseSchema,
    CouncilStateChangedV3BaseSchema,
    DecisionStateChangedV3BaseSchema,
    LifecycleRecoveredV3BaseSchema,
    LifecycleSweepObservedV3BaseSchema,
    HealthObservedV3BaseSchema,
  ],
  { $id: EVENT_V3_BASE_SCHEMA_ID },
);

export const EVENT_V3_BASE_CORE_EVENT_TYPES = [
  "ledger.genesis",
  "ledger.activated",
  "ledger.schema_advanced",
  "ledger.comparability_advanced",
  "session.started",
  "session.attestation_changed",
  "session.resumed",
  "session.ended",
  "session.termination_observed",
  "run.started",
  "run.completed",
  "turn.started",
  "turn.completed",
  "tool.requested",
  "tool.completed",
  "command.started",
  "command.output_observed",
  "command.completed",
  "context.observed",
  "context.compaction_started",
  "context.compaction_completed",
  "context.checkpointed",
  "context.recovery_injected",
  "agent.delegated",
  "agent.started",
  "agent.completed",
  "wait.started",
  "wait.ended",
  "artifact.observed",
  "progress.observed",
  "coord.task_changed",
  "coord.lifecycle_changed",
  "coord.status_observed",
  "coord.claim_changed",
  "coord.presence_changed",
  "coord.message_observed",
  "coord.identity_attested",
  "council.state_changed",
  "decision.state_changed",
  "lifecycle.recovered",
  "lifecycle.sweep_observed",
  "health.observed",
] as const;

export type EventV3Base = Static<typeof EventV3BaseSchema>;
export type EventTypeV3Base = EventV3Base["event_type"];
export type EventOfTypeV3Base<T extends EventTypeV3Base> = Extract<EventV3Base, { event_type: T }>;
export type EventPayloadV3Base<T extends EventTypeV3Base> = EventOfTypeV3Base<T>["payload"];
export type RuntimeAttestationV3Base = Static<typeof RuntimeAttestationV3BaseSchema>;
export type RecoveryV3Base = Static<typeof RecoveryV3BaseSchema>;
export type RecoveryReasonV3Base = Static<typeof RecoveryReasonV3BaseSchema>;
export type ContentDescriptorV3Base = Static<typeof ContentDescriptorV3BaseSchema>;
export type TargetDescriptorV3Base = Static<typeof TargetDescriptorV3BaseSchema>;
