import { Value } from "@sinclair/typebox/value";
import {
  SEMANTIC_TAGS,
  type SemanticAgentReadModelV1,
  SemanticAgentReadModelV1Schema,
  type SemanticEvidenceKind,
  type SemanticEvidenceV1,
  type SemanticField,
  type SemanticMeaningV1,
  type SemanticModelReplyV1,
  SemanticModelReplyV1Schema,
} from "./contract.ts";

export interface SemanticValidationSuccess<T> {
  ok: true;
  value: T;
}

export interface SemanticValidationFailure {
  ok: false;
  issues: string[];
}

export type SemanticValidationResult<T> = SemanticValidationSuccess<T> | SemanticValidationFailure;

const PRIVATE_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [
    /(?:^|\s)(?:[A-Za-z]:\\|\\\\|\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|\.\.\/|\.harnery\/)/i,
    "path",
  ],
  [/https?:\/\//i, "url"],
  [/(?:^|\s)--[a-z][a-z0-9-]*(?:\s|=|$)/i, "command_flag"],
  [/(?:^|\s)[A-Z][A-Z0-9_]{2,}=/, "environment_assignment"],
  [/`[^`]+`/, "command_or_code"],
  [/\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S+/i, "secret_shape"],
];

const FORBIDDEN_CLAIM_PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{1,3}\s*%(?=\s|$|[.,])/, "percent_complete"],
  [/\b(?:minutes?|hours?|days?)\s+(?:left|remaining)\b/i, "time_remaining"],
  [/\b(?:frustrated|confused|happy|sad|excited|anxious|angry)\b/i, "emotion"],
  [/\b(?:excellent|great|poor|bad)\s+(?:quality|work)\b/i, "quality"],
];

const RESULT_KINDS = new Set<SemanticEvidenceKind>(["progress", "artifact", "action", "terminal"]);
const ATTENTION_KINDS = new Set<SemanticEvidenceKind>([
  "wait",
  "lifecycle",
  "error",
  "claim-conflict",
]);
const COMPLETION_LANGUAGE =
  /\b(?:complete|completed|done|finished|shipped|passed|succeeded|deployed|published)\b/i;

export function semanticPrivacyIssue(value: string): string | undefined {
  for (const [pattern, issue] of PRIVATE_TEXT_PATTERNS) {
    if (pattern.test(value)) return issue;
  }
  return undefined;
}

export function isSemanticPrivacySafe(value: string): boolean {
  return semanticPrivacyIssue(value) === undefined;
}

export function validateSemanticEvidencePrivacy(
  evidence: SemanticEvidenceV1,
): SemanticValidationResult<SemanticEvidenceV1> {
  const text: Array<[string, string | undefined]> = [
    ["task", evidence.task?.value],
    ["operation", evidence.operation?.label],
    ["attention", evidence.attention?.label],
    ...evidence.recent.map(
      (item, index) => [`recent[${index}]`, item.label] as [string, string | undefined],
    ),
  ];
  const issues = text.flatMap(([field, value]) => {
    if (!value) return [];
    const issue = semanticPrivacyIssue(value);
    return issue ? [`${field}:${issue}`] : [];
  });
  return issues.length ? { ok: false, issues } : { ok: true, value: evidence };
}

export function validateSemanticModelReply(
  input: unknown,
  evidence: SemanticEvidenceV1,
): SemanticValidationResult<SemanticModelReplyV1> {
  if (!Value.Check(SemanticModelReplyV1Schema, input)) {
    return {
      ok: false,
      issues: [...Value.Errors(SemanticModelReplyV1Schema, input)]
        .slice(0, 12)
        .map((error) => `schema:${error.path || "/"}:${error.message}`),
    };
  }
  const reply = input as SemanticModelReplyV1;
  const issues: string[] = [];
  if (reply.generation_id !== evidence.generation_id) issues.push("generation_mismatch");
  if (reply.evidence_digest !== evidence.evidence_digest) issues.push("evidence_digest_mismatch");

  const knownIds = new Set(evidence.evidence_event_ids);
  const kindById = evidenceKindByEventId(evidence);
  for (const [name, field] of meaningFields(reply.meaning)) {
    if (name === "tags" && Array.isArray(field.value) && field.value.length === 0) {
      if (field.evidence_event_ids.length !== 0) issues.push("empty_tags_must_not_cite");
    } else if (field.evidence_event_ids.length === 0) {
      issues.push(`${name}:missing_citation`);
    }
    for (const eventId of field.evidence_event_ids) {
      if (!knownIds.has(eventId)) issues.push(`${name}:unknown_citation`);
    }
    if (name === "next_step") {
      if (field.basis !== "prediction" || field.confidence !== "low") {
        issues.push("next_step:must_be_low_confidence_prediction");
      }
    } else if (field.basis !== "model-synthesis") {
      issues.push(`${name}:must_be_model_synthesis`);
    }
    if (typeof field.value === "string") {
      const privacyIssue = semanticPrivacyIssue(field.value);
      if (privacyIssue) issues.push(`${name}:privacy_${privacyIssue}`);
      for (const [pattern, issue] of FORBIDDEN_CLAIM_PATTERNS) {
        if (pattern.test(field.value)) issues.push(`${name}:${issue}`);
      }
      if (/\bblocked\b/i.test(field.value) && name !== "attention") {
        issues.push(`${name}:unsupported_blocker_language`);
      }
      if (
        COMPLETION_LANGUAGE.test(field.value) &&
        !citationsSupport(field, kindById, RESULT_KINDS)
      ) {
        issues.push(`${name}:unsupported_completion_language`);
      }
    }
  }

  if (
    reply.meaning.recent_result &&
    !citationsSupport(reply.meaning.recent_result, kindById, RESULT_KINDS)
  ) {
    issues.push("recent_result:unsupported_evidence_kind");
  }
  if (
    reply.meaning.attention &&
    !citationsSupport(reply.meaning.attention, kindById, ATTENTION_KINDS)
  ) {
    issues.push("attention:unsupported_evidence_kind");
  }
  if (reply.meaning.tags) {
    for (const tag of reply.meaning.tags.value) {
      if (!(SEMANTIC_TAGS as readonly string[]).includes(tag)) issues.push("tags:unsupported_tag");
    }
  }
  return issues.length ? { ok: false, issues: [...new Set(issues)] } : { ok: true, value: reply };
}

export function validateSemanticReadModel(
  input: unknown,
  expected?: Pick<SemanticEvidenceV1, "instance_id" | "generation_id" | "evidence_digest">,
): SemanticValidationResult<SemanticAgentReadModelV1> {
  if (!Value.Check(SemanticAgentReadModelV1Schema, input)) {
    return {
      ok: false,
      issues: [...Value.Errors(SemanticAgentReadModelV1Schema, input)]
        .slice(0, 12)
        .map((error) => `schema:${error.path || "/"}:${error.message}`),
    };
  }
  const value = input as SemanticAgentReadModelV1;
  const issues: string[] = [];
  if (expected) {
    if (value.instance_id !== expected.instance_id) issues.push("instance_mismatch");
    if (value.generation_id !== expected.generation_id) issues.push("generation_mismatch");
    if (value.source.evidence_digest !== expected.evidence_digest) {
      issues.push("evidence_digest_mismatch");
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, value };
}

function meaningFields(meaning: SemanticMeaningV1): Array<[string, SemanticField<unknown>]> {
  return (Object.entries(meaning) as Array<[string, SemanticField<unknown>]>).filter(([, value]) =>
    Boolean(value && typeof value === "object" && Array.isArray(value.evidence_event_ids)),
  );
}

function evidenceKindByEventId(evidence: SemanticEvidenceV1): Map<string, SemanticEvidenceKind> {
  const map = new Map<string, SemanticEvidenceKind>();
  if (evidence.task) map.set(evidence.task.event_id, "task");
  if (evidence.lifecycle) map.set(evidence.lifecycle.event_id, "lifecycle");
  if (evidence.intent) map.set(evidence.intent.event_id, "intent");
  if (evidence.operation) map.set(evidence.operation.event_id, "operation");
  for (const wait of evidence.waits) map.set(wait.event_id, "wait");
  for (const recent of evidence.recent) map.set(recent.event_id, recent.kind);
  if (evidence.attention) map.set(evidence.attention.event_id, evidence.attention.kind);
  return map;
}

function citationsSupport(
  field: SemanticField<unknown>,
  kindById: Map<string, SemanticEvidenceKind>,
  allowed: Set<SemanticEvidenceKind>,
): boolean {
  return field.evidence_event_ids.some((eventId) => {
    const kind = kindById.get(eventId);
    return kind !== undefined && allowed.has(kind);
  });
}
