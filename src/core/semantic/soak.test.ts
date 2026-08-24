import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { SemanticAgentReadModelV2 } from "./contract.ts";
import { readSemanticSoakReport, semanticSoakReadings } from "./soak.ts";
import { semanticPaths, writeSemanticAgentDocument } from "./storage.ts";

const roots: string[] = [];
const generationId = "gen_01922e33-7abc-7def-8abc-0123456789ab";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("semantic soak", () => {
  test("projects accepted readings without stable ledger identifiers or prose", () => {
    const root = fixture();
    writeSemanticAgentDocument(root, acceptedDocument());

    const readings = semanticSoakReadings(root, [
      {
        generation_id: generationId,
        source_harness: "codex",
        configured_model: "gpt-5.6-luna",
        action: "accepted",
        model_call: true,
      },
    ]);

    expect(readings).toEqual([
      {
        subject_id: expect.stringMatching(/^subject_[a-f0-9]{16}$/),
        generated_at: "2026-08-24T10:00:00.000Z",
        source_harness: "codex",
        configured_model: "gpt-5.6-luna",
        resolved_model_id: "gpt-5.6-luna",
        model_attestation: "requested-only",
        origin: "model-call",
        phase: "verifying",
        phase_confidence: "high",
        expression_cue: "verifying",
        expression_confidence: "medium",
      },
    ]);
    expect(JSON.stringify(readings)).not.toContain(generationId);
    expect(JSON.stringify(readings)).not.toContain("Verify the semantic contract");
  });

  test("summarizes interval usage, cue frequency, and rapid reversals", () => {
    const root = fixture();
    const path = semanticPaths(root).log;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${[
        { schema_version: 1, ts: "2026-08-24T09:55:00.000Z", event: "service_started" },
        pass("2026-08-24T10:00:00.000Z", "verifying", "accepted", 100),
        pass("2026-08-24T10:04:00.000Z", "planning", "accepted", 100),
        pass("2026-08-24T10:08:00.000Z", "verifying", "accepted", 100),
        legacyPass("2026-08-24T10:09:00.000Z"),
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );

    const report = readSemanticSoakReport(root, {
      minutes: 10,
      now: new Date("2026-08-24T10:10:00.000Z"),
    });

    expect(report.window).toMatchObject({ window_complete: true });
    expect(report.coverage).toEqual({
      pass_count: 4,
      instrumented_pass_count: 3,
      legacy_pass_count: 1,
      accepted_reading_count: 3,
      cached_reading_count: 0,
    });
    expect(report.outcomes).toEqual({ accepted: 3, invalid: 1, unavailable: 0, deferred: 0 });
    expect(report.usage).toMatchObject({
      call_count: 4,
      native_tokens: { input_tokens: 350, output_tokens: 35 },
    });
    expect(report.readings).toMatchObject({
      phase_counts: { verifying: 2, planning: 1 },
      expression_counts: { verifying: 2, planning: 1 },
      expression_confidence_counts: { medium: 3 },
      by_harness: { codex: 3 },
    });
    expect(report.stability).toMatchObject({
      subject_count: 1,
      subjects_with_repeat_observations: 1,
      adjacent_comparisons: 2,
      unchanged_cues: 0,
      cue_changes: 2,
      rapid_reversals: 1,
      stable_repeat_rate: 0,
      transitions: [
        { from: "planning", to: "verifying", count: 1 },
        { from: "verifying", to: "planning", count: 1 },
      ],
    });
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-semantic-soak-"));
  roots.push(root);
  return root;
}

function acceptedDocument(): SemanticAgentReadModelV2 {
  const evidence = "evt_01922e33-7abc-7def-8abc-0123456789ab";
  const field = <T>(value: T, confidence: "high" | "medium") => ({
    value,
    basis: "model-synthesis" as const,
    confidence,
    evidence_event_ids: [evidence],
  });
  return {
    schema_version: 2,
    instance_id: "inst_fixture",
    generation_id: generationId,
    source: {
      ledger_genesis_id: "gex_fixture",
      evidence_digest: `sha256:${"a".repeat(64)}`,
      observed_through_event_id: evidence,
      observed_through_ts: "2026-08-24T09:59:59.000Z",
    },
    generated_at: "2026-08-24T10:00:00.000Z",
    reader_outcome: "accepted",
    reader: {
      harness: "codex",
      configured_model: "gpt-5.6-luna",
      resolved_model_id: "gpt-5.6-luna",
      model_attestation: "requested-only",
      prompt_contract_version: 4,
    },
    meaning: {
      headline: field("Verifying", "high"),
      summary: field("Verify the semantic contract", "high"),
      phase: field("verifying" as const, "high"),
      expression_cue: field("verifying" as const, "medium"),
    },
  };
}

function pass(ts: string, cue: "verifying" | "planning", outcome: "accepted", inputTokens: number) {
  return {
    schema_version: 1,
    ts,
    event: "pass",
    semantic_readings: [
      {
        subject_id: "subject_0123456789abcdef",
        generated_at: ts,
        source_harness: "codex",
        configured_model: "gpt-5.6-luna",
        origin: "model-call",
        phase: cue,
        phase_confidence: "high",
        expression_cue: cue,
        expression_confidence: "medium",
      },
    ],
    usage: usage(outcome, inputTokens, Math.floor(inputTokens / 10)),
  };
}

function legacyPass(ts: string) {
  return {
    schema_version: 1,
    ts,
    event: "pass",
    usage: usage("invalid", 50, 5),
  };
}

function usage(outcome: "accepted" | "invalid", input: number, output: number) {
  return {
    call_count: 1,
    outcomes: {
      accepted: outcome === "accepted" ? 1 : 0,
      invalid: outcome === "invalid" ? 1 : 0,
      unavailable: 0,
      deferred: 0,
    },
    invalid_reasons: outcome === "invalid" ? { schema: 1 } : {},
    native_tokens: { input_tokens: input, output_tokens: output },
    estimated_tokens: {},
    unreported_calls: 0,
    breakdowns: [],
  };
}
