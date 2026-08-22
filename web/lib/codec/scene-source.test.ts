import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEventV3 } from "../../../src/core/events/v3/builder";
import { attestationIdV3, eventIdV3, generationIdV3 } from "../../../src/core/events/v3/ids";
import type { LiveDisplayRowV3 } from "../../../src/core/events/v3/live-feed";
import {
  CODEC_SCHEMA_VERSION,
  type CodecScene,
  type CodecSourceEvidence,
  FALLBACK_PACK,
} from "./contracts";
import {
  applyLiveFeedOverlay,
  mergeRemotePanels,
  readSanitizedTails,
  stripLiveFeedOverlay,
} from "./scene-source";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codec V3 ledger tail", () => {
  test("reads and sanitizes validated V3 rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "codec-v3-ledger-"));
    roots.push(root);
    const v3Path = join(root, "v3.ndjson");
    const eventId = eventIdV3();
    const generationId = generationIdV3();
    const attestationId = attestationIdV3();
    const v3 = buildEventV3("session.started", {
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
    writeFileSync(v3Path, `${JSON.stringify(v3)}\n`);

    const rows = await readSanitizedTails([v3Path]);
    expect(rows.map((row) => row.event_id)).toEqual([eventId]);
    expect(rows.map((row) => row.event_type)).toEqual(["session.started"]);
  });
});

describe("Codec live-display overlay", () => {
  test("merges unexpired intent onto matching event ids and strips it for remote", () => {
    const eventId = eventIdV3();
    const generationId = generationIdV3();
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
    const overlay: LiveDisplayRowV3 = {
      format: "harnery-event-v3-live-display",
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
          intent_history: [
            {
              text: "Inspect the adapter matrix",
              event_id: eventId,
              observed_at: overlay.written_at,
              event_type: "command.started",
              category: "diagnostic",
              live_overlay: true,
            },
          ],
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
      remote_machines: [],
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
    const stripped = stripLiveFeedOverlay(scene).panels[0];
    expect(stripped?.focus_bubble).toBeUndefined();
    expect(stripped?.intent_history).toBeUndefined();
    expect(scene.panels[0]?.focus_bubble).toBeDefined();
    expect(scene.panels[0]?.intent_history).toHaveLength(1);

    const localPanel = scene.panels[0];
    if (!localPanel) throw new Error("local panel missing");
    const remoteDuplicate = {
      ...localPanel,
      identity: { display_name: "Remote duplicate" },
      machine: "peer-a",
    };
    const remoteUnique = {
      ...remoteDuplicate,
      instance_id: "inst-remote",
      identity: { display_name: "Remote unique" },
    };
    const withRemote = mergeRemotePanels(scene, [
      remoteDuplicate,
      remoteUnique,
      { ...remoteUnique, machine: "peer-b" },
    ]);
    expect(withRemote.panels.map((panel) => panel.identity.display_name)).toEqual([
      "Sara",
      "Remote unique",
    ]);
    expect(withRemote.team_ambience).toEqual(scene.team_ambience);
    expect(scene.panels).toHaveLength(1);
  });

  test("ignores overlays that do not match an evidence event id", () => {
    const events: CodecSourceEvidence[] = [
      {
        schema_version: 2,
        event_id: eventIdV3(),
        event_type: "command.started",
        ts: "2026-08-16T10:00:00.000Z",
        instance_id: "inst-1",
      },
    ];
    const overlay: LiveDisplayRowV3 = {
      format: "harnery-event-v3-live-display",
      format_version: 1,
      row_id: "live_11111111-1111-4111-8111-111111111111",
      generation_id: generationIdV3(),
      event_id: eventIdV3(),
      written_at: "2026-08-16T10:00:00.000Z",
      expires_at: "2026-08-16T10:15:00.000Z",
      intent_display: "Should not attach",
    };
    expect(applyLiveFeedOverlay(events, [overlay])[0]?.intent).toBeUndefined();
  });
});
