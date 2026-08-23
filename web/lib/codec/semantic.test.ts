import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  SemanticAcceptedReadModelV2,
  SemanticAgentReadModelV2,
} from "../../../src/core/semantic/contract";
import { writeSemanticAgentDocument } from "../../../src/core/semantic/storage";
import {
  CODEC_SCHEMA_VERSION,
  type CodecPanelScene,
  type CodecScene,
  type CodecSourceEvidence,
} from "./contracts";
import { codecEvidenceReceiptRows } from "./evidence-receipt";
import { applySemanticReadModel, codecSemantic } from "./semantic";

const NOW = "2026-08-22T20:00:00.000Z";
const EVENT = "evt_01922e33-7abc-7def-8abc-0123456789ab";
const GENERATION = "gen_01922e33-7abc-7def-8abc-0123456789ab";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codec-semantic-"));
  roots.push(root);
  return root;
}

function panel(overrides: Partial<CodecPanelScene> = {}): CodecPanelScene {
  return {
    instance_id: "inst_fixture",
    identity: { display_name: "Carmen" },
    presence: { value: "online", provenance: "projection", confidence: "high", observed_at: NOW },
    activity: { value: "working", provenance: "projection", confidence: "high", observed_at: NOW },
    lifecycle: { value: "active", provenance: "projection", confidence: "high", observed_at: NOW },
    expression: {
      value: "neutral",
      provenance: "projection",
      confidence: "high",
      observed_at: NOW,
    },
    attention: { value: "none", provenance: "projection", confidence: "high", observed_at: NOW },
    context_band: { value: "unknown", provenance: "unknown", confidence: "low", observed_at: NOW },
    progress_rhythm: {
      value: "steady",
      provenance: "projection",
      confidence: "high",
      observed_at: NOW,
    },
    recent_actions: [],
    ledger_state: { value: "live", provenance: "event", confidence: "high", observed_at: NOW },
    character: { pack_id: "fallback-neutral", pack_version: "0" },
    updated_at: NOW,
    ...overrides,
  };
}

function scene(one: CodecPanelScene): CodecScene {
  return {
    schema_version: CODEC_SCHEMA_VERSION,
    freshness: { value: "live", provenance: "projection", confidence: "high", observed_at: NOW },
    panels: [one],
    remote_machines: [],
    relationships: [],
    transients: [],
    team_ambience: {
      value: "calm",
      provenance: "projection",
      confidence: "high",
      observed_at: NOW,
    },
    generated_at: NOW,
  };
}

function source(generationId = GENERATION): CodecSourceEvidence[] {
  return [
    {
      schema_version: 2,
      event_id: EVENT,
      event_type: "session.started",
      ts: "2026-08-22T19:59:00.000Z",
      instance_id: "inst_fixture",
      generation_id: generationId,
    },
  ];
}

function accepted(observedThrough = "2026-08-22T19:59:00.000Z"): SemanticAcceptedReadModelV2 {
  const cited = [EVENT];
  return {
    schema_version: 2,
    instance_id: "inst_fixture",
    generation_id: GENERATION,
    reader_outcome: "accepted",
    source: {
      ledger_genesis_id: "gex_fixture",
      evidence_digest: `sha256:${"a".repeat(64)}`,
      observed_through_event_id: EVENT,
      observed_through_ts: observedThrough,
    },
    reader: {
      harness: "codex",
      configured_model: "gpt-5.6-luna",
      resolved_model_id: "gpt-5.6-luna",
      model_attestation: "requested-only",
      prompt_contract_version: 3,
    },
    meaning: {
      headline: {
        value: "Building the semantic reader",
        basis: "model-synthesis",
        confidence: "high",
        evidence_event_ids: cited,
      },
      summary: {
        value: "The agent is wiring validated semantic meaning into Codec.",
        basis: "model-synthesis",
        confidence: "high",
        evidence_event_ids: cited,
      },
      phase: {
        value: "implementing",
        basis: "model-synthesis",
        confidence: "high",
        evidence_event_ids: cited,
      },
      expression_cue: {
        value: "weighing",
        basis: "model-synthesis",
        confidence: "medium",
        evidence_event_ids: cited,
      },
      next_step: {
        value: "Verify the merged scene.",
        basis: "prediction",
        confidence: "low",
        evidence_event_ids: cited,
      },
    },
    generated_at: "2026-08-22T19:59:05.000Z",
  };
}

function unavailable(): SemanticAgentReadModelV2 {
  return {
    schema_version: 2,
    instance_id: "inst_fixture",
    generation_id: GENERATION,
    reader_outcome: "unavailable",
    source: {
      ledger_genesis_id: "gex_fixture",
      evidence_digest: `sha256:${"b".repeat(64)}`,
      observed_through_event_id: EVENT,
      observed_through_ts: "2026-08-22T19:59:00.000Z",
    },
    reader: {
      harness: "codex",
      configured_model: "gpt-5.6-luna",
      prompt_contract_version: 3,
    },
    receipt: { reason_code: "authentication_unavailable" },
    generated_at: "2026-08-22T19:59:05.000Z",
  };
}

describe("Codec semantic read model", () => {
  test("fills only low-information presentation channels and exposes provenance", () => {
    const root = fixtureRoot();
    writeSemanticAgentDocument(root, accepted());
    const projected = scene(panel());
    expect(applySemanticReadModel(projected, source(), root, new Date(NOW))).toBe(1);
    expect(projected.panels[0]?.focus_bubble).toMatchObject({
      value: { text: "Building the semantic reader", basis: "inferred" },
      provenance: "inferred",
      confidence: "high",
    });
    expect(projected.panels[0]?.expression).toMatchObject({
      value: "weighing",
      provenance: "inferred",
      confidence: "medium",
      evidence_event_ids: [EVENT],
    });
    expect(codecSemantic(projected.panels[0]!)).toMatchObject({
      state: "current",
      reader: { configured_model: "gpt-5.6-luna", model_attestation: "requested-only" },
      summary: { basis: "model-synthesis" },
      expression_cue: { value: "weighing", basis: "model-synthesis" },
      next_step: { basis: "prediction", confidence: "low" },
    });
    expect(codecEvidenceReceiptRows(projected.panels[0]!)).toContainEqual(
      expect.objectContaining({
        channel: "expression cue",
        value: "weighing",
        provenance: "inferred",
        confidence: "medium",
        evidence_event_ids: [EVENT],
      }),
    );
  });

  test("falls back to semantic phase when the reader abstains from an expression cue", () => {
    const root = fixtureRoot();
    const document = accepted();
    delete (document.meaning as { expression_cue?: unknown }).expression_cue;
    writeSemanticAgentDocument(root, document);
    const projected = scene(panel());
    expect(applySemanticReadModel(projected, source(), root, new Date(NOW))).toBe(1);
    expect(projected.panels[0]?.expression.value).toBe("building");
  });

  test("never overwrites an event-backed focus bubble or expression", () => {
    const root = fixtureRoot();
    writeSemanticAgentDocument(root, accepted());
    const projected = scene(
      panel({
        expression: {
          value: "investigating",
          provenance: "event",
          confidence: "high",
          observed_at: NOW,
        },
        focus_bubble: {
          value: { text: "Inspect the live event", basis: "event-backed" },
          provenance: "event",
          confidence: "high",
          observed_at: NOW,
        },
      }),
    );
    expect(applySemanticReadModel(projected, source(), root, new Date(NOW))).toBe(1);
    expect(projected.panels[0]?.focus_bubble?.value.text).toBe("Inspect the live event");
    expect(projected.panels[0]?.expression.value).toBe("investigating");
  });

  test("removes expired meaning while keeping a visible stale reader receipt", () => {
    const root = fixtureRoot();
    writeSemanticAgentDocument(root, accepted("2026-08-22T19:00:00.000Z"));
    const projected = scene(panel());
    expect(applySemanticReadModel(projected, source(), root, new Date(NOW))).toBe(1);
    expect(projected.panels[0]?.focus_bubble).toBeUndefined();
    expect(projected.panels[0]?.expression.value).toBe("neutral");
    expect(codecSemantic(projected.panels[0]!)).toMatchObject({ state: "stale" });
    expect(codecSemantic(projected.panels[0]!)?.headline).toBeUndefined();
  });

  test("shows an unavailable reader receipt without fabricating meaning", () => {
    const root = fixtureRoot();
    writeSemanticAgentDocument(root, unavailable());
    const projected = scene(panel());
    expect(applySemanticReadModel(projected, source(), root, new Date(NOW))).toBe(1);
    expect(projected.panels[0]?.focus_bubble).toBeUndefined();
    expect(codecSemantic(projected.panels[0]!)).toMatchObject({
      state: "unavailable",
      reader_outcome: "unavailable",
      reader: { configured_model: "gpt-5.6-luna" },
      receipt: { reason_code: "authentication_unavailable" },
    });
    expect(codecSemantic(projected.panels[0]!)?.summary).toBeUndefined();
  });

  test("ignores a semantic document from a different generation", () => {
    const root = fixtureRoot();
    writeSemanticAgentDocument(root, accepted());
    const projected = scene(panel());
    expect(
      applySemanticReadModel(
        projected,
        source("gen_01922e33-7abd-7def-8abc-0123456789ab"),
        root,
        new Date(NOW),
      ),
    ).toBe(0);
    expect(codecSemantic(projected.panels[0]!)).toBeUndefined();
  });
});
