import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEventV2 } from "../../../src/core/events/v2/builder";
import { attestationIdV2, eventIdV2, generationIdV2 } from "../../../src/core/events/v2/ids";
import type { LiveDisplayRowV2 } from "../../../src/core/events/v2/live-feed";
import {
  CODEC_SCHEMA_VERSION,
  type CodecScene,
  type CodecSourceEvidence,
  FALLBACK_PACK,
} from "./contracts";
import { applyLiveFeedOverlay, readSanitizedTails, stripLiveFeedOverlay } from "./scene-source";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codec V2 ledger tail", () => {
  test("reads and sanitizes validated V2 rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "codec-v2-ledger-"));
    roots.push(root);
    const v2Path = join(root, "v2.ndjson");
    const eventId = eventIdV2();
    const generationId = generationIdV2();
    const attestationId = attestationIdV2();
    const v2 = buildEventV2("session.started", {
      event_id: eventId,
      producer: {
        producer_id: "prd_codec-fixture",
        boot_id: "boot_fixture",
        sequence: 1,
        component: "agent-hook",
        build_id: "build_fixture",
        platform: "linux",
      },
      scope: {
        root_id: "root_fixture",
        instance_id: "inst_fixture",
        session_id: `sid_${"a".repeat(64)}`,
        generation_id: generationId,
      },
      attestation_id: attestationId,
      links: { caused_by: [] },
      provenance: {
        source_event: "fixture.codec",
        attestation: "derived",
        confidence: "exact",
        attribution: {
          method: "explicit_argument",
          state: "verified",
          observer_instance_id: "inst_fixture",
          subject_instance_id: "inst_fixture",
        },
      },
      observed_at: "2026-08-16T10:00:01.000Z",
      recorded_at: "2026-08-16T10:00:01.000Z",
      payload: {
        runtime_attestation: {
          attestation_id: attestationId,
          generation_id: generationId,
          adapter: {
            state: "observed",
            value: { id: "claude-code" },
            attestation: "native",
            confidence: "exact",
          },
          harness: {
            state: "observed",
            value: { id: "fixture" },
            attestation: "native",
            confidence: "exact",
          },
          model: { state: "unsupported", capability: "model_identity" },
          capability_profile: `cap_${"b".repeat(64)}`,
          declared_by_event_id: eventId,
        },
        resume: { state: "not_applicable" },
      },
    });
    writeFileSync(v2Path, `${JSON.stringify(v2)}\n`);

    const rows = await readSanitizedTails([v2Path]);
    expect(rows.map((row) => row.event_id)).toEqual([eventId]);
    expect(rows.map((row) => row.event_type)).toEqual(["session.started"]);
  });
});

describe("Codec live-display overlay", () => {
  test("merges unexpired intent onto matching event ids and strips it for remote", () => {
    const eventId = eventIdV2();
    const generationId = generationIdV2();
    const events: CodecSourceEvidence[] = [
      {
        schema_version: 2,
        event_id: eventId,
        event_type: "command.started",
        ts: "2026-08-16T10:00:00.000Z",
        instance_id: "inst-1",
        generation_id: generationId,
        category: "diagnostic",
        outcome: "started",
      },
    ];
    const overlay: LiveDisplayRowV2 = {
      format: "harnery-event-v2-live-display",
      format_version: 1,
      row_id: "live_11111111-1111-4111-8111-111111111111",
      generation_id: generationId,
      event_id: eventId,
      written_at: "2026-08-16T10:00:00.000Z",
      expires_at: "2026-08-16T10:15:00.000Z",
      intent_display: "Inspect the adapter matrix",
    };
    const merged = applyLiveFeedOverlay(events, [overlay]);
    expect(merged[0]).toMatchObject({
      intent: "Inspect the adapter matrix",
      live_overlay: true,
    });

    const scene: CodecScene = {
      schema_version: CODEC_SCHEMA_VERSION,
      freshness: {
        value: "live",
        provenance: "projection",
        confidence: "high",
        observed_at: overlay.written_at,
      },
      panels: [
        {
          instance_id: "inst-1",
          identity: { display_name: "Sara" },
          presence: {
            value: "online",
            provenance: "projection",
            confidence: "high",
            observed_at: overlay.written_at,
          },
          activity: {
            value: "working",
            provenance: "projection",
            confidence: "high",
            observed_at: overlay.written_at,
          },
          lifecycle: {
            value: "active",
            provenance: "projection",
            confidence: "high",
            observed_at: overlay.written_at,
          },
          expression: {
            value: "focused",
            provenance: "projection",
            confidence: "high",
            observed_at: overlay.written_at,
          },
          attention: {
            value: "none",
            provenance: "projection",
            confidence: "high",
            observed_at: overlay.written_at,
          },
          context_band: {
            value: "unknown",
            provenance: "unknown",
            confidence: "low",
            observed_at: overlay.written_at,
          },
          progress_rhythm: {
            value: "unknown",
            provenance: "unknown",
            confidence: "low",
            observed_at: overlay.written_at,
          },
          recent_actions: [],
          focus_bubble: {
            value: { text: "Inspect the adapter", basis: "event-backed", live_overlay: true },
            provenance: "event",
            confidence: "high",
            observed_at: overlay.written_at,
          },
          character: { ...FALLBACK_PACK },
          updated_at: overlay.written_at,
        },
      ],
      relationships: [],
      transients: [],
      team_ambience: {
        value: "calm",
        provenance: "projection",
        confidence: "high",
        observed_at: overlay.written_at,
      },
      generated_at: overlay.written_at,
    };
    expect(stripLiveFeedOverlay(scene).panels[0]?.focus_bubble).toBeUndefined();
    expect(scene.panels[0]?.focus_bubble).toBeDefined();
  });

  test("ignores overlays that do not match an evidence event id", () => {
    const events: CodecSourceEvidence[] = [
      {
        schema_version: 2,
        event_id: eventIdV2(),
        event_type: "command.started",
        ts: "2026-08-16T10:00:00.000Z",
        instance_id: "inst-1",
      },
    ];
    const overlay: LiveDisplayRowV2 = {
      format: "harnery-event-v2-live-display",
      format_version: 1,
      row_id: "live_11111111-1111-4111-8111-111111111111",
      generation_id: generationIdV2(),
      event_id: eventIdV2(),
      written_at: "2026-08-16T10:00:00.000Z",
      expires_at: "2026-08-16T10:15:00.000Z",
      intent_display: "Should not attach",
    };
    expect(applyLiveFeedOverlay(events, [overlay])[0]?.intent).toBeUndefined();
  });
});
