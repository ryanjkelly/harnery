import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CODEC_SCHEMA_VERSION, type CodecPanelScene, type CodecScene } from "./contracts";
import { applySuggestions } from "./suggestions";

const NOW = "2026-08-16T12:00:00.000Z";
const SOON = "2026-08-16T12:03:00.000Z";

let root: string;

function panel(overrides: Partial<CodecPanelScene> = {}): CodecPanelScene {
  return {
    instance_id: "inst-1",
    identity: { display_name: "Sara" },
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
      value: "unknown",
      provenance: "unknown",
      confidence: "low",
      observed_at: NOW,
    },
    recent_actions: [{ category: "edit", outcome: "ok", event_id: "ev-1", observed_at: NOW }],
    character: { pack_id: "fallback-neutral", pack_version: "0" },
    updated_at: NOW,
    ...overrides,
  };
}

function scene(panels: CodecPanelScene[]): CodecScene {
  return {
    schema_version: CODEC_SCHEMA_VERSION,
    freshness: { value: "live", provenance: "projection", confidence: "high", observed_at: NOW },
    panels,
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

function writeSuggestions(suggestions: unknown[]): void {
  const dir = path.join(root, "codec");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "suggestions.json"),
    JSON.stringify({ schema_version: 1, suggestions }),
  );
}

const GOOD = {
  schema_version: 1,
  instance_id: "inst-1",
  expression: "building",
  focus_bubble: { text: "polishing the panels", basis: "inferred" },
  confidence: "low",
  evidence_event_ids: ["ev-1"],
  expires_at: SOON,
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codec-sugg-"));
});

describe("applySuggestions", () => {
  test("fills neutral expression and missing bubble as inferred/low", () => {
    writeSuggestions([GOOD]);
    const s = scene([panel()]);
    const merged = applySuggestions(s, [], root);
    expect(merged).toBe(2);
    expect(s.panels[0]?.expression).toMatchObject({
      value: "building",
      provenance: "inferred",
      confidence: "low",
    });
    expect(s.panels[0]?.expression.expires_at).toBe(SOON);
    expect(s.panels[0]?.focus_bubble?.value).toMatchObject({
      text: "polishing the panels",
      basis: "inferred",
    });
  });

  test("never overwrites an event/projection-backed channel", () => {
    writeSuggestions([GOOD]);
    const s = scene([
      panel({
        expression: {
          value: "investigating",
          provenance: "event",
          confidence: "high",
          observed_at: NOW,
        },
        focus_bubble: {
          value: { text: "real declared intent", basis: "event-backed" },
          provenance: "event",
          confidence: "high",
          observed_at: NOW,
        },
      }),
    ]);
    expect(applySuggestions(s, [], root)).toBe(0);
    expect(s.panels[0]?.expression.value).toBe("investigating");
    expect(s.panels[0]?.focus_bubble?.value.basis).toBe("event-backed");
  });

  test("rejects forged citations, expiry problems, and wrong instances", () => {
    writeSuggestions([
      { ...GOOD, evidence_event_ids: ["forged"] },
      { ...GOOD, expires_at: "2026-08-16T11:00:00.000Z" },
      { ...GOOD, instance_id: "inst-2" },
    ]);
    const s = scene([panel()]);
    expect(applySuggestions(s, [], root)).toBe(0);
    expect(s.panels[0]?.expression.value).toBe("neutral");
  });

  test("missing or malformed file means no styling", () => {
    const s = scene([panel()]);
    expect(applySuggestions(s, [], root)).toBe(0);
    mkdirSync(path.join(root, "codec"), { recursive: true });
    writeFileSync(path.join(root, "codec", "suggestions.json"), "{not json");
    expect(applySuggestions(s, [], root)).toBe(0);
  });
});
