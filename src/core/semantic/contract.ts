import { type Static, type TProperties, type TSchema, Type } from "@sinclair/typebox";

export const SEMANTIC_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const SEMANTIC_READ_MODEL_SCHEMA_VERSION = 2 as const;
export const SEMANTIC_EVIDENCE_CONTRACT_VERSION = 1 as const;
export const SEMANTIC_PROMPT_CONTRACT_VERSION = 2 as const;

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Timestamp = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
});
const Sha256 = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const SafeToken = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,127}$" });
const uuidV7Pattern = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const EventId = Type.String({ pattern: `^evt_${uuidV7Pattern}$` });
const GenerationId = Type.String({ pattern: `^gen_${uuidV7Pattern}$` });
const InstanceId = Type.String({ pattern: "^inst_[a-zA-Z0-9._-]{1,128}$" });

export const SEMANTIC_HARNESSES = ["claude-code", "codex", "cursor"] as const;
export const SEMANTIC_CONFIGURED_MODELS = ["haiku-4.5", "gpt-5.6-luna", "composer-2.5"] as const;
export const SEMANTIC_PHASES = [
  "orienting",
  "researching",
  "planning",
  "implementing",
  "verifying",
  "coordinating",
  "waiting",
  "recovering",
  "wrapping-up",
  "unknown",
] as const;
/**
 * Model-synthesized presentation cues. Authoritative operational expressions
 * such as blocked, waiting, alert, recovering, compacting, observing, strained,
 * and conducting remain deterministic Codec projections and are excluded.
 */
export const SEMANTIC_EXPRESSION_CUES = [
  "focused",
  "curious",
  "deliberating",
  "investigating",
  "building",
  "coordinating",
  "planning",
  "verifying",
  "weighing",
  "wrapping-up",
] as const;
export const SEMANTIC_TAGS = [
  "research",
  "planning",
  "implementation",
  "verification",
  "coordination",
  "waiting",
  "recovery",
  "delivery",
  "documentation",
  "infrastructure",
] as const;
export const SEMANTIC_EVIDENCE_KINDS = [
  "task",
  "lifecycle",
  "intent",
  "operation",
  "wait",
  "progress",
  "artifact",
  "action",
  "terminal",
  "error",
  "recovery",
  "claim-conflict",
] as const;

export type SemanticHarness = (typeof SEMANTIC_HARNESSES)[number];
export type SemanticConfiguredModel = (typeof SEMANTIC_CONFIGURED_MODELS)[number];
export type SemanticPhase = (typeof SEMANTIC_PHASES)[number];
export type SemanticExpressionCue = (typeof SEMANTIC_EXPRESSION_CUES)[number];
export type SemanticTag = (typeof SEMANTIC_TAGS)[number];
export type SemanticEvidenceKind = (typeof SEMANTIC_EVIDENCE_KINDS)[number];
export type SemanticBasis =
  | "direct-fact"
  | "deterministic-projection"
  | "model-synthesis"
  | "prediction";
export type SemanticConfidence = "high" | "medium" | "low";

const HarnessSchema = Type.Union(SEMANTIC_HARNESSES.map((value) => Type.Literal(value)));
const ConfiguredModelSchema = Type.Union(
  SEMANTIC_CONFIGURED_MODELS.map((value) => Type.Literal(value)),
);
const PhaseSchema = Type.Union(SEMANTIC_PHASES.map((value) => Type.Literal(value)));
const ExpressionCueSchema = Type.Union(
  SEMANTIC_EXPRESSION_CUES.map((value) => Type.Literal(value)),
);
const TagSchema = Type.Union(SEMANTIC_TAGS.map((value) => Type.Literal(value)));
const EvidenceKindSchema = Type.Union(SEMANTIC_EVIDENCE_KINDS.map((value) => Type.Literal(value)));
const BasisSchema = Type.Union([
  Type.Literal("direct-fact"),
  Type.Literal("deterministic-projection"),
  Type.Literal("model-synthesis"),
  Type.Literal("prediction"),
]);
const ConfidenceSchema = Type.Union([
  Type.Literal("high"),
  Type.Literal("medium"),
  Type.Literal("low"),
]);

function SemanticFieldSchema<T extends TSchema>(
  value: T,
  options: { allowEmptyCitations?: boolean } = {},
) {
  return StrictObject({
    value,
    basis: BasisSchema,
    confidence: ConfidenceSchema,
    evidence_event_ids: Type.Array(EventId, {
      minItems: options.allowEmptyCitations ? 0 : 1,
      maxItems: 16,
      uniqueItems: true,
    }),
  });
}

export const SemanticEvidenceObservationV1Schema = StrictObject({
  kind: EvidenceKindSchema,
  event_id: EventId,
  observed_at: Timestamp,
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  outcome: Type.Optional(SafeToken),
  error_class: Type.Optional(SafeToken),
});

export const SemanticEvidenceV1Schema = StrictObject({
  schema_version: Type.Literal(SEMANTIC_EVIDENCE_SCHEMA_VERSION),
  evidence_contract_version: Type.Literal(SEMANTIC_EVIDENCE_CONTRACT_VERSION),
  instance_id: InstanceId,
  generation_id: GenerationId,
  source_harness: HarnessSchema,
  source: StrictObject({
    ledger_genesis_id: Type.String({ pattern: "^gex_[a-zA-Z0-9._-]{1,128}$" }),
    observed_through_event_id: EventId,
    observed_through_ts: Timestamp,
  }),
  task: Type.Optional(
    StrictObject({ value: Type.String({ minLength: 1, maxLength: 200 }), event_id: EventId }),
  ),
  lifecycle: Type.Optional(StrictObject({ state: SafeToken, event_id: EventId })),
  intent: Type.Optional(StrictObject({ kind: SafeToken, event_id: EventId })),
  operation: Type.Optional(
    StrictObject({
      category: SafeToken,
      label: Type.String({ minLength: 1, maxLength: 80 }),
      event_id: EventId,
    }),
  ),
  waits: Type.Array(StrictObject({ kind: SafeToken, event_id: EventId, started_at: Timestamp }), {
    maxItems: 8,
  }),
  recent: Type.Array(SemanticEvidenceObservationV1Schema, { maxItems: 8 }),
  attention: Type.Optional(SemanticEvidenceObservationV1Schema),
  relationships: Type.Optional(
    StrictObject({
      parent_generation_id: Type.Optional(GenerationId),
      dependency_ids: Type.Array(SafeToken, { maxItems: 16, uniqueItems: true }),
    }),
  ),
  evidence_event_ids: Type.Array(EventId, { minItems: 1, maxItems: 64, uniqueItems: true }),
  evidence_digest: Sha256,
});

export const SemanticMeaningV2Schema = StrictObject({
  headline: SemanticFieldSchema(Type.String({ minLength: 1, maxLength: 60 })),
  summary: SemanticFieldSchema(Type.String({ minLength: 1, maxLength: 240 })),
  phase: SemanticFieldSchema(PhaseSchema),
  expression_cue: Type.Optional(SemanticFieldSchema(ExpressionCueSchema)),
  purpose: Type.Optional(SemanticFieldSchema(Type.String({ minLength: 1, maxLength: 180 }))),
  recent_result: Type.Optional(SemanticFieldSchema(Type.String({ minLength: 1, maxLength: 180 }))),
  attention: Type.Optional(SemanticFieldSchema(Type.String({ minLength: 1, maxLength: 180 }))),
  next_step: Type.Optional(SemanticFieldSchema(Type.String({ minLength: 1, maxLength: 180 }))),
  tags: Type.Optional(
    SemanticFieldSchema(Type.Array(TagSchema, { maxItems: 8, uniqueItems: true }), {
      allowEmptyCitations: true,
    }),
  ),
});

export const SemanticModelReplyV2Schema = StrictObject({
  schema_version: Type.Literal(SEMANTIC_READ_MODEL_SCHEMA_VERSION),
  generation_id: GenerationId,
  evidence_digest: Sha256,
  meaning: SemanticMeaningV2Schema,
});

const ReaderCommon = {
  harness: HarnessSchema,
  configured_model: ConfiguredModelSchema,
  prompt_contract_version: Type.Literal(SEMANTIC_PROMPT_CONTRACT_VERSION),
};
const UnresolvedReaderSchema = StrictObject(ReaderCommon);
const ResolvedReaderSchema = StrictObject({
  ...ReaderCommon,
  resolved_model_id: Type.String({ minLength: 1, maxLength: 160 }),
  model_attestation: Type.Union([Type.Literal("verified"), Type.Literal("requested-only")]),
});
const ReaderSchema = Type.Union([UnresolvedReaderSchema, ResolvedReaderSchema]);

const ReadModelBase = {
  schema_version: Type.Literal(SEMANTIC_READ_MODEL_SCHEMA_VERSION),
  instance_id: InstanceId,
  generation_id: GenerationId,
  source: StrictObject({
    ledger_genesis_id: Type.String({ pattern: "^gex_[a-zA-Z0-9._-]{1,128}$" }),
    evidence_digest: Sha256,
    observed_through_event_id: EventId,
    observed_through_ts: Timestamp,
  }),
  generated_at: Timestamp,
};

export const SemanticAcceptedReadModelV2Schema = StrictObject({
  ...ReadModelBase,
  reader_outcome: Type.Literal("accepted"),
  reader: ResolvedReaderSchema,
  meaning: SemanticMeaningV2Schema,
});

export const SemanticUnavailableReadModelV2Schema = StrictObject({
  ...ReadModelBase,
  reader_outcome: Type.Literal("unavailable"),
  reader: ReaderSchema,
  receipt: StrictObject({
    reason_code: Type.Union([
      Type.Literal("harness_unavailable"),
      Type.Literal("authentication_unavailable"),
      Type.Literal("model_unavailable"),
      Type.Literal("model_mismatch"),
    ]),
  }),
});

export const SemanticInvalidReadModelV2Schema = StrictObject({
  ...ReadModelBase,
  reader_outcome: Type.Literal("invalid"),
  reader: ResolvedReaderSchema,
  receipt: StrictObject({ reason_code: Type.Literal("invalid_output") }),
});

export const SemanticDeferredReadModelV2Schema = StrictObject({
  ...ReadModelBase,
  reader_outcome: Type.Literal("deferred"),
  reader: ReaderSchema,
  receipt: StrictObject({ reason_code: Type.Literal("rate_cap"), eligible_after: Timestamp }),
});

export const SemanticAgentReadModelV2Schema = Type.Union([
  SemanticAcceptedReadModelV2Schema,
  SemanticUnavailableReadModelV2Schema,
  SemanticInvalidReadModelV2Schema,
  SemanticDeferredReadModelV2Schema,
]);

export type SemanticEvidenceObservationV1 = Static<typeof SemanticEvidenceObservationV1Schema>;
export type SemanticEvidenceV1 = Static<typeof SemanticEvidenceV1Schema>;
export type SemanticField<T> = {
  value: T;
  basis: SemanticBasis;
  confidence: SemanticConfidence;
  evidence_event_ids: string[];
};
export type SemanticMeaningV2 = Static<typeof SemanticMeaningV2Schema>;
export type SemanticModelReplyV2 = Static<typeof SemanticModelReplyV2Schema>;
export type SemanticAcceptedReadModelV2 = Static<typeof SemanticAcceptedReadModelV2Schema>;
export type SemanticAgentReadModelV2 = Static<typeof SemanticAgentReadModelV2Schema>;
