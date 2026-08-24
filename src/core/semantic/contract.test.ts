import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  SEMANTIC_PROMPT_CONTRACT_VERSION,
  SemanticAgentReadModelV2Schema,
  type SemanticEvidenceV1,
  SemanticEvidenceV1Schema,
  type SemanticModelReplyV2,
  semanticModelReplyV2SchemaFor,
} from "./contract.ts";
import {
  classifySemanticValidationIssues,
  isSemanticPrivacySafe,
  validateSemanticEvidencePrivacy,
  validateSemanticModelReply,
} from "./validate.ts";

const EVENT_ONE = "evt_01922e33-7abc-7def-8abc-0123456789ab";
const EVENT_TWO = "evt_01922e33-7abd-7def-8abc-0123456789ab";
const GENERATION = "gen_01922e33-7abc-7def-8abc-0123456789ab";
const DIGEST = `sha256:${"a".repeat(64)}` as const;

function evidence(): SemanticEvidenceV1 {
  return {
    schema_version: 1,
    evidence_contract_version: 1,
    instance_id: "inst_fixture",
    generation_id: GENERATION,
    source_harness: "codex",
    source: {
      ledger_genesis_id: "gex_fixture",
      observed_through_event_id: EVENT_TWO,
      observed_through_ts: "2026-08-22T20:00:00.000Z",
    },
    task: { value: "Implement semantic reading", event_id: EVENT_ONE },
    operation: { category: "test", label: "Testing", event_id: EVENT_TWO },
    waits: [],
    recent: [
      {
        kind: "progress",
        event_id: EVENT_TWO,
        observed_at: "2026-08-22T20:00:00.000Z",
        label: "Tests passed",
        outcome: "succeeded",
      },
    ],
    evidence_event_ids: [EVENT_ONE, EVENT_TWO],
    evidence_digest: DIGEST,
  };
}

function reply(): SemanticModelReplyV2 {
  return {
    schema_version: 2,
    generation_id: GENERATION,
    evidence_digest: DIGEST,
    meaning: {
      headline: {
        value: "Verifying semantic reading",
        basis: "model-synthesis",
        confidence: "high",
        evidence_event_ids: [EVENT_ONE, EVENT_TWO],
      },
      summary: {
        value: "The agent is testing the semantic read-model contract.",
        basis: "model-synthesis",
        confidence: "high",
        evidence_event_ids: [EVENT_ONE, EVENT_TWO],
      },
      phase: {
        value: "verifying",
        basis: "model-synthesis",
        confidence: "high",
        evidence_event_ids: [EVENT_TWO],
      },
      expression_cue: {
        value: "verifying",
        basis: "model-synthesis",
        confidence: "medium",
        evidence_event_ids: [EVENT_TWO],
      },
      recent_result: {
        value: "Contract tests passed.",
        basis: "model-synthesis",
        confidence: "high",
        evidence_event_ids: [EVENT_TWO],
      },
      next_step: {
        value: "Inspect the persisted document.",
        basis: "prediction",
        confidence: "low",
        evidence_event_ids: [EVENT_TWO],
      },
      tags: {
        value: ["verification"],
        basis: "model-synthesis",
        confidence: "medium",
        evidence_event_ids: [EVENT_TWO],
      },
    },
  };
}

describe("semantic read-model contract", () => {
  test("accepts one evidence-cited model reply", () => {
    const source = evidence();
    expect(Value.Check(SemanticEvidenceV1Schema, source)).toBe(true);
    expect(Value.Check(semanticModelReplyV2SchemaFor(source), reply())).toBe(true);
    expect(
      Value.Check(semanticModelReplyV2SchemaFor(source), {
        ...reply(),
        generation_id: "gen_01922e33-7abe-7def-8abc-0123456789ab",
      }),
    ).toBe(false);
    expect(
      Value.Check(semanticModelReplyV2SchemaFor(source), {
        ...reply(),
        meaning: {
          ...reply().meaning,
          phase: {
            ...reply().meaning.phase,
            evidence_event_ids: ["evt_01922e33-7abe-7def-8abc-0123456789ab"],
          },
        },
      }),
    ).toBe(false);
    expect(validateSemanticModelReply(reply(), source)).toEqual({ ok: true, value: reply() });
  });

  test("rejects unsupported or overconfident expression cues", () => {
    const source = evidence();
    const overconfident = reply();
    overconfident.meaning.expression_cue!.confidence = "high";
    const confidence = validateSemanticModelReply(overconfident, source);
    expect(confidence.ok).toBe(false);
    if (!confidence.ok) {
      expect(confidence.issues.some((issue) => issue.startsWith("schema:"))).toBe(true);
    }

    const authoritative = reply() as unknown as {
      meaning: { expression_cue: { value: string } };
    };
    authoritative.meaning.expression_cue.value = "blocked";
    const cue = validateSemanticModelReply(authoritative, source);
    expect(cue.ok).toBe(false);
    if (!cue.ok) expect(cue.issues.some((issue) => issue.startsWith("schema:"))).toBe(true);
  });

  test("allows unavailable readers to omit unresolved model attestation", () => {
    const document = {
      schema_version: 2,
      instance_id: "inst_fixture",
      generation_id: GENERATION,
      reader_outcome: "unavailable",
      source: {
        ledger_genesis_id: "gex_fixture",
        evidence_digest: DIGEST,
        observed_through_event_id: EVENT_TWO,
        observed_through_ts: "2026-08-22T20:00:00.000Z",
      },
      reader: {
        harness: "claude-code",
        configured_model: "haiku-4.5",
        prompt_contract_version: SEMANTIC_PROMPT_CONTRACT_VERSION,
      },
      receipt: { reason_code: "authentication_unavailable" },
      generated_at: "2026-08-22T20:00:01.000Z",
    };
    expect(Value.Check(SemanticAgentReadModelV2Schema, document)).toBe(true);
    expect(Value.Check(SemanticAgentReadModelV2Schema, { ...document, schema_version: 1 })).toBe(
      false,
    );
  });

  test("requires resolved reader identity for accepted output", () => {
    const document = {
      schema_version: 2,
      instance_id: "inst_fixture",
      generation_id: GENERATION,
      reader_outcome: "accepted",
      source: {
        ledger_genesis_id: "gex_fixture",
        evidence_digest: DIGEST,
        observed_through_event_id: EVENT_TWO,
        observed_through_ts: "2026-08-22T20:00:00.000Z",
      },
      reader: {
        harness: "codex",
        configured_model: "gpt-5.6-luna",
        prompt_contract_version: SEMANTIC_PROMPT_CONTRACT_VERSION,
      },
      meaning: reply().meaning,
      generated_at: "2026-08-22T20:00:01.000Z",
    };
    expect(Value.Check(SemanticAgentReadModelV2Schema, document)).toBe(false);
  });

  test("rejects private path, command, environment, URL, and secret sentinels", () => {
    const sentinels = [
      "Inspect /home/person/private/file.ts",
      "Open C:\\Users\\person\\secret.txt",
      "Run `git status --short`",
      "Use --dangerously-skip-permissions",
      "Read API_TOKEN=super-secret",
      "Fetch https://private.example.test/path",
      "password: hunter2",
    ];
    for (const sentinel of sentinels) expect(isSemanticPrivacySafe(sentinel)).toBe(false);
    const source = evidence();
    source.operation = { ...source.operation!, label: sentinels[0]! };
    expect(validateSemanticEvidencePrivacy(source).ok).toBe(false);
  });

  test("rejects adversarial reducer labels before they reach a model", () => {
    const source = evidence();
    source.operation = {
      ...source.operation!,
      label: "Testing /private/reducer-leak --token=abc",
    };
    expect(validateSemanticEvidencePrivacy(source)).toEqual({
      ok: false,
      issues: ["operation:path"],
    });
  });

  test("rejects private sentinels in model meaning before local persistence", () => {
    const source = evidence();
    const invalid = reply();
    invalid.meaning.summary.value = "Inspect /private/model-output before continuing.";
    invalid.meaning.next_step!.value = "Open https://private.example.test/review.";
    const result = validateSemanticModelReply(invalid, source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContain("summary:privacy_path");
      expect(result.issues).toContain("next_step:privacy_url");
    }
  });

  test("permits absent or empty tags without fabricated citations", () => {
    const source = evidence();
    const withoutTags = reply();
    delete (withoutTags.meaning as { tags?: unknown }).tags;
    expect(validateSemanticModelReply(withoutTags, source).ok).toBe(true);

    const emptyTags = reply();
    emptyTags.meaning.tags = {
      value: [],
      basis: "model-synthesis",
      confidence: "medium",
      evidence_event_ids: [],
    };
    expect(validateSemanticModelReply(emptyTags, source).ok).toBe(true);
  });

  test("rejects unknown citations and unsupported completion or attention claims", () => {
    const source = evidence();
    const invalid = reply();
    invalid.meaning.summary.evidence_event_ids = ["evt_01922e33-7abe-7def-8abc-0123456789ab"];
    invalid.meaning.summary.value = "Work is 80% complete.";
    invalid.meaning.attention = {
      value: "The agent is blocked.",
      basis: "model-synthesis",
      confidence: "high",
      evidence_event_ids: [EVENT_ONE],
    };
    const result = validateSemanticModelReply(invalid, source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContain("summary:unknown_citation");
      expect(result.issues).toContain("summary:percent_complete");
      expect(result.issues).toContain("attention:unsupported_evidence_kind");
      expect(classifySemanticValidationIssues(result.issues)).toEqual([
        "citation",
        "unsupported_claim",
      ]);
    }
  });

  test("rejects stale output for an earlier evidence digest", () => {
    const source = evidence();
    source.evidence_digest = `sha256:${"b".repeat(64)}`;
    expect(validateSemanticModelReply(reply(), source)).toEqual({
      ok: false,
      issues: ["evidence_digest_mismatch"],
    });
  });
});
