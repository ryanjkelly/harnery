import { describe, expect, test } from "bun:test";

import type { CodecSemanticChannel, CodecSemanticPresented } from "./contracts";
import { codecSemanticBriefLines } from "./semantic-brief";

const NOW = "2026-08-24T10:00:00.000Z";

describe("Codec semantic brief", () => {
  test("keeps current work, recent result, and prediction visible", () => {
    const semantic = channel({
      headline: field("Repair the scene projector"),
      summary: field("A longer summary that remains in expanded detail"),
      recent_result: field("The failing projector test now passes"),
      next_step: prediction("Run the focused typecheck"),
    });

    expect(
      codecSemanticBriefLines(semantic).map(({ label, text, missing }) => ({
        label,
        text,
        missing,
      })),
    ).toEqual([
      { label: "Now", text: "Repair the scene projector", missing: false },
      { label: "Result", text: "The failing projector test now passes", missing: false },
      { label: "Predicted", text: "Run the focused typecheck", missing: false },
    ]);
  });

  test("falls back to summary and keeps all three rows stable when optional meaning is absent", () => {
    const lines = codecSemanticBriefLines(
      channel({ summary: field("Reviewing current evidence") }),
    );

    expect(lines[0].text).toBe("Reviewing current evidence");
    expect(lines[1]).toMatchObject({ missing: true, text: "No recent semantic result available" });
    expect(lines[2]).toMatchObject({ missing: true, text: "No next-step prediction available" });
  });

  test("states why meaning is unavailable without reviving stale prose", () => {
    const semantic = channel({});
    semantic.state = "deferred";
    semantic.reader_outcome = "deferred";
    semantic.receipt = { reason_code: "rate_cap", eligible_after: NOW };

    expect(codecSemanticBriefLines(semantic).map((line) => line.text)).toEqual([
      "Semantic reader deferred · rate cap",
      "No recent semantic result available",
      "No next-step prediction available",
    ]);
  });
});

function channel(
  fields: Partial<
    Pick<CodecSemanticChannel, "headline" | "summary" | "recent_result" | "next_step">
  >,
): CodecSemanticChannel {
  return {
    state: "current",
    reader_outcome: "accepted",
    reader: {
      harness: "codex",
      configured_model: "gpt-5.6-luna",
      resolved_model_id: "gpt-5.6-luna",
      model_attestation: "requested-only",
    },
    evidence_digest: `sha256:${"a".repeat(64)}`,
    observed_through_event_id: "evt_test",
    observed_through_ts: NOW,
    generated_at: NOW,
    expires_at: "2026-08-24T10:05:00.000Z",
    ...fields,
  };
}

function field(value: string): CodecSemanticPresented<string> {
  return {
    value,
    basis: "model-synthesis",
    provenance: "inferred",
    confidence: "high",
    observed_at: NOW,
    evidence_event_ids: ["evt_test"],
  };
}

function prediction(value: string): CodecSemanticPresented<string> {
  return { ...field(value), basis: "prediction", confidence: "low" };
}
