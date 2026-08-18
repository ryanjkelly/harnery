import { describe, expect, test } from "bun:test";

import type { CodecPanelScene, CodecSourceEvidence } from "./contracts";
import { buildCodecEvidence, evidenceEventIds, validateSuggestion } from "./validator";

const NOW = "2026-08-16T12:00:00.000Z";
const SOON = "2026-08-16T12:03:00.000Z";

function panel(): CodecPanelScene {
  return {
    instance_id: "inst-1",
    identity: {
      display_name: "Sara",
      task: { value: "Ship codec", provenance: "projection", confidence: "high", observed_at: NOW },
    },
    presence: { value: "online", provenance: "projection", confidence: "high", observed_at: NOW },
    activity: { value: "working", provenance: "projection", confidence: "high", observed_at: NOW },
    lifecycle: { value: "active", provenance: "projection", confidence: "high", observed_at: NOW },
    expression: {
      value: "focused",
      provenance: "projection",
      confidence: "high",
      observed_at: NOW,
    },
    attention: { value: "none", provenance: "projection", confidence: "high", observed_at: NOW },
    context_band: {
      value: "ample",
      provenance: "event",
      confidence: "high",
      observed_at: NOW,
      evidence_event_ids: ["ev-ctx"],
    },
    progress_rhythm: {
      value: "in-motion",
      provenance: "event",
      confidence: "high",
      observed_at: NOW,
    },
    recent_actions: [
      { category: "edit", outcome: "ok", event_id: "ev-1", observed_at: NOW },
      { category: "research", outcome: "ok", event_id: "ev-2", observed_at: NOW },
    ],
    character: { pack_id: "fallback-neutral", pack_version: "0" },
    updated_at: NOW,
  };
}

function sourceEvents(): CodecSourceEvidence[] {
  return [
    {
      schema_version: 2,
      event_id: "ev-3",
      event_type: "tool.requested",
      ts: NOW,
      instance_id: "inst-1",
      intent: "wire the validator",
    },
  ];
}

describe("buildCodecEvidence", () => {
  test("selects only bounded fields and caps the trail at three", () => {
    const evidence = buildCodecEvidence(panel(), sourceEvents(), NOW);
    expect(evidence.instance_id).toBe("inst-1");
    expect(evidence.current_intent).toMatchObject({ text: "wire the validator", event_id: "ev-3" });
    expect(evidence.recent_actions.length).toBeLessThanOrEqual(3);
    const ids = evidenceEventIds(evidence);
    expect(ids.has("ev-1")).toBe(true);
    expect(ids.has("ev-3")).toBe(true);
    expect(ids.has("ev-ctx")).toBe(true);
  });
});

describe("validateSuggestion", () => {
  const evidence = buildCodecEvidence(panel(), sourceEvents(), NOW);

  const base = {
    schema_version: 1,
    instance_id: "inst-1",
    expression: "building",
    confidence: "medium",
    evidence_event_ids: ["ev-1"],
    expires_at: SOON,
  };

  test("accepts a well-formed suggestion", () => {
    const verdict = validateSuggestion(base, evidence, NOW);
    expect(verdict.ok).toBe(true);
  });

  test("rejects citations outside the supplied evidence", () => {
    const verdict = validateSuggestion(
      { ...base, evidence_event_ids: ["ev-1", "forged-id"] },
      evidence,
      NOW,
    );
    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.reason).toContain("unknown evidence");
  });

  test("rejects missing, past, or far-future expiry", () => {
    expect(validateSuggestion({ ...base, expires_at: undefined }, evidence, NOW).ok).toBe(false);
    expect(
      validateSuggestion({ ...base, expires_at: "2026-08-16T11:00:00.000Z" }, evidence, NOW).ok,
    ).toBe(false);
    expect(
      validateSuggestion({ ...base, expires_at: "2026-08-17T12:00:00.000Z" }, evidence, NOW).ok,
    ).toBe(false);
  });

  test("caps inferred bubbles at low confidence and four words", () => {
    const inferredHigh = validateSuggestion(
      {
        ...base,
        expression: undefined,
        focus_bubble: { text: "sweeping the repo", basis: "inferred" },
        confidence: "high",
      },
      evidence,
      NOW,
    );
    expect(inferredHigh.ok).toBe(false);

    const tooLong = validateSuggestion(
      {
        ...base,
        expression: undefined,
        focus_bubble: { text: "one two three four five", basis: "event-backed" },
      },
      evidence,
      NOW,
    );
    expect(tooLong.ok).toBe(false);

    const good = validateSuggestion(
      {
        ...base,
        expression: undefined,
        focus_bubble: { text: "sweeping the repo", basis: "inferred" },
        confidence: "low",
      },
      evidence,
      NOW,
    );
    expect(good.ok).toBe(true);
  });

  test("rejects unknown expressions, schema versions, instances, and empty suggestions", () => {
    expect(validateSuggestion({ ...base, expression: "smug" }, evidence, NOW).ok).toBe(false);
    expect(validateSuggestion({ ...base, schema_version: 2 }, evidence, NOW).ok).toBe(false);
    expect(validateSuggestion({ ...base, instance_id: "inst-2" }, evidence, NOW).ok).toBe(false);
    expect(validateSuggestion({ ...base, expression: undefined }, evidence, NOW).ok).toBe(false);
  });
});
