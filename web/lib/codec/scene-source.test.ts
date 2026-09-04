import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEventV3 } from "../../../src/core/events/v3/builder";
import { attestationIdV3, eventIdV3, generationIdV3 } from "../../../src/core/events/v3/ids";
import { type LiveDisplayRowV3, writeLiveDisplayV3 } from "../../../src/core/events/v3/live-feed";
import { eventV3Fixture } from "../../../tests/helpers/event-v3";
import {
  CODEC_SCHEMA_VERSION,
  type CodecScene,
  type CodecSourceEvidence,
  FALLBACK_PACK,
} from "./contracts";
import {
  applyLiveFeedOverlay,
  listCachedLiveDisplayForCodec,
  mergeRemotePanels,
  readIncrementalSanitizedTail,
  readSanitizedTails,
  stripLiveFeedOverlay,
} from "./scene-source";
import { codecSemantic, setCodecSemantic } from "./semantic-contract";

const roots: string[] = [];

function fixtureLine(eventType: string, sequence: number): { eventId: string; line: string } {
  const event = eventV3Fixture(eventType, sequence);
  return {
    eventId: String(event.event_id),
    line: `${JSON.stringify(event)}\n`,
  };
}

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
          tuning: { state: "unsupported", capability: "effort_selection" },
          telemetry: {
            context_usage: { state: "unsupported", capability: "context_usage" },
            wait_spans: { state: "unsupported", capability: "wait_spans" },
            wait_completeness: { state: "unsupported", capability: "wait_completeness" },
            response_latency: { state: "unsupported", capability: "response_latency" },
            inference_timing: { state: "unsupported", capability: "inference_timing" },
          },
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

    const firstIncremental = await readIncrementalSanitizedTail(v3Path);
    expect(firstIncremental.map((row) => row.event_id)).toEqual([eventId]);
    const secondEventId = eventIdV3();
    const second = structuredClone(v3);
    second.event_id = secondEventId;
    second.producer.sequence = 2;
    second.payload.runtime_attestation.declared_by_event_id = secondEventId;
    appendFileSync(v3Path, `${JSON.stringify(second)}\n`);
    const appended = await readIncrementalSanitizedTail(v3Path);
    expect(appended.map((row) => row.event_id)).toEqual([eventId, secondEventId]);
  });

  test("retains an evicted session boundary outside the byte window", async () => {
    const root = mkdtempSync(join(tmpdir(), "codec-v3-lifecycle-boundary-"));
    roots.push(root);
    const v3Path = join(root, "v3.ndjson");
    const started = fixtureLine("session.started", 1);
    const progress = fixtureLine("progress.observed", 2);
    writeFileSync(v3Path, "");

    await readIncrementalSanitizedTail(v3Path, 1);
    appendFileSync(v3Path, started.line);
    await readIncrementalSanitizedTail(v3Path, 1);
    appendFileSync(v3Path, progress.line);

    const rows = await readIncrementalSanitizedTail(v3Path, 1);
    expect(rows.map((row) => row.event_id)).toEqual([started.eventId, progress.eventId]);
  });

  test("keeps terminal session, turn, and wait rows with the earlier boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "codec-v3-lifecycle-terminal-"));
    roots.push(root);
    const v3Path = join(root, "v3.ndjson");
    const started = fixtureLine("session.started", 1);
    const turnStarted = fixtureLine("turn.started", 2);
    const waitStarted = fixtureLine("wait.started", 3);
    const waitEnded = fixtureLine("wait.ended", 4);
    const turnCompleted = fixtureLine("turn.completed", 5);
    const ended = fixtureLine("session.ended", 6);
    const progress = fixtureLine("progress.observed", 7);
    writeFileSync(v3Path, "");

    await readIncrementalSanitizedTail(v3Path, 1);
    appendFileSync(v3Path, started.line);
    await readIncrementalSanitizedTail(v3Path, 1);
    appendFileSync(
      v3Path,
      turnStarted.line +
        waitStarted.line +
        waitEnded.line +
        turnCompleted.line +
        ended.line +
        progress.line,
    );

    const rows = await readIncrementalSanitizedTail(v3Path, 1);
    expect(rows.map((row) => row.event_id)).toEqual([
      started.eventId,
      turnStarted.eventId,
      waitStarted.eventId,
      waitEnded.eventId,
      turnCompleted.eventId,
      ended.eventId,
      progress.eventId,
    ]);
  });

  test("deduplicates retained lifecycle rows against the byte window", async () => {
    const root = mkdtempSync(join(tmpdir(), "codec-v3-lifecycle-dedupe-"));
    roots.push(root);
    const v3Path = join(root, "v3.ndjson");
    const started = fixtureLine("session.started", 1);
    const progress = fixtureLine("progress.observed", 2);
    writeFileSync(v3Path, "");

    await readIncrementalSanitizedTail(v3Path, 1);
    appendFileSync(v3Path, started.line);
    await readIncrementalSanitizedTail(v3Path, 1);
    appendFileSync(v3Path, started.line + progress.line);

    const rows = await readIncrementalSanitizedTail(v3Path, 1);
    expect(rows.map((row) => row.event_id)).toEqual([started.eventId, progress.eventId]);
  });

  test("drops retained lifecycle rows when the active file is replaced", async () => {
    const root = mkdtempSync(join(tmpdir(), "codec-v3-lifecycle-replace-"));
    roots.push(root);
    const v3Path = join(root, "v3.ndjson");
    const replacementPath = join(root, "replacement.ndjson");
    const started = fixtureLine("session.started", 1);
    const filler = Array.from({ length: 20 }, (_, index) =>
      fixtureLine("progress.observed", index + 2),
    );
    const replacement = fixtureLine("progress.observed", 100);
    const byteLimit = 4_096;
    writeFileSync(v3Path, "");

    await readIncrementalSanitizedTail(v3Path, byteLimit);
    appendFileSync(v3Path, started.line);
    await readIncrementalSanitizedTail(v3Path, byteLimit);
    appendFileSync(v3Path, filler.map(({ line }) => line).join(""));
    const beforeReplacement = await readIncrementalSanitizedTail(v3Path, byteLimit);
    expect(beforeReplacement.some((row) => row.event_id === started.eventId)).toBe(true);

    writeFileSync(replacementPath, replacement.line);
    renameSync(replacementPath, v3Path);

    const afterReplacement = await readIncrementalSanitizedTail(v3Path, byteLimit);
    expect(afterReplacement.map((row) => row.event_id)).toEqual([replacement.eventId]);
  });
});

describe("Codec live-display overlay", () => {
  test("rereads changed generation files and expires cached rows", () => {
    const root = mkdtempSync(join(tmpdir(), "codec-live-cache-"));
    roots.push(root);
    const generationId = generationIdV3();
    const firstEventId = eventIdV3();
    const startedAt = new Date("2026-08-16T10:00:00.000Z");
    writeLiveDisplayV3(
      root,
      {
        generation_id: generationId,
        event_id: firstEventId,
        intent_display: "Inspect the first boundary",
        ttl_ms: 60_000,
      },
      () => startedAt,
    );

    expect(listCachedLiveDisplayForCodec(root, new Date(startedAt.getTime() + 1_000))).toHaveLength(
      1,
    );
    writeLiveDisplayV3(
      root,
      {
        generation_id: generationId,
        event_id: eventIdV3(),
        intent_display: "Inspect the second boundary",
        ttl_ms: 60_000,
      },
      () => new Date(startedAt.getTime() + 2_000),
    );
    expect(listCachedLiveDisplayForCodec(root, new Date(startedAt.getTime() + 3_000))).toHaveLength(
      2,
    );
    expect(
      listCachedLiveDisplayForCodec(root, new Date(startedAt.getTime() + 63_000)),
    ).toHaveLength(0);
  });

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
    const longIntent =
      "Inspect every adapter boundary without adding a visible truncation marker. ".repeat(5);
    const bounded = applyLiveFeedOverlay(events, [{ ...overlay, intent_display: longIntent }]);
    expect(bounded[0]?.intent).toBe(longIntent.trim().slice(0, 240));
    expect(bounded[0]?.intent?.endsWith("…")).toBe(false);

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
          context_usage: {
            value: {
              used_percent: 75,
              remaining_percent: 25,
              used_tokens: 150_000,
              limit_tokens: 200_000,
              remaining_tokens: 50_000,
            },
            provenance: "event",
            confidence: "high",
            observed_at: overlay.written_at,
          },
          progress_rhythm: {
            value: "unknown",
            provenance: "unknown",
            confidence: "low",
            observed_at: overlay.written_at,
          },
          recent_actions: [],
          has_artifact_workspace: true,
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
          artifact_cue: {
            value: {
              kind: "image",
              operation: "created",
              image_hash: "a".repeat(64),
              image_media_type: "image/png",
              image_bytes: 4096,
            },
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
      semantic_service: {
        running: true,
        stale: false,
        state: "running",
        pending_count: 1,
        model_calls: 2,
        rolling_calls: { used: 2, limit: 60, available: 58 },
        routes: [],
        rolling_usage: {
          call_count: 2,
          outcomes: { accepted: 2, invalid: 0, unavailable: 0, deferred: 0 },
          native_tokens: {},
          estimated_tokens: {},
          invalid_reasons: {},
          unreported_calls: 2,
          breakdowns: [],
        },
        process_usage: {
          call_count: 2,
          outcomes: { accepted: 2, invalid: 0, unavailable: 0, deferred: 0 },
          native_tokens: {},
          estimated_tokens: {},
          invalid_reasons: {},
          unreported_calls: 2,
          breakdowns: [],
        },
      },
      generated_at: overlay.written_at,
    };
    const localSemanticPanel = scene.panels[0];
    if (!localSemanticPanel) throw new Error("local semantic panel missing");
    setCodecSemantic(localSemanticPanel, {
      state: "current",
      reader_outcome: "accepted",
      reader: { harness: "codex", configured_model: "gpt-5.6-luna" },
      evidence_digest: `sha256:${"a".repeat(64)}`,
      observed_through_event_id: eventId,
      observed_through_ts: overlay.written_at,
      generated_at: overlay.written_at,
      expires_at: overlay.expires_at,
    });
    const relayScene = stripLiveFeedOverlay(scene);
    const stripped = relayScene.panels[0];
    expect(relayScene.semantic_service).toBeUndefined();
    expect(stripped?.focus_bubble).toBeUndefined();
    expect(stripped?.intent_history).toBeUndefined();
    expect(stripped?.has_artifact_workspace).toBeUndefined();
    expect(stripped?.context_usage?.value).toEqual({
      used_percent: 75,
      remaining_percent: 25,
    });
    expect(stripped?.artifact_cue?.value).toEqual({ kind: "image", operation: "created" });
    expect(stripped && codecSemantic(stripped)).toBeUndefined();
    expect(scene.panels[0]?.focus_bubble).toBeDefined();
    expect(scene.panels[0]?.intent_history).toHaveLength(1);
    expect(scene.panels[0]?.has_artifact_workspace).toBe(true);
    expect(scene.panels[0]?.context_usage?.value.used_tokens).toBe(150_000);
    expect(scene.panels[0]?.artifact_cue?.value.image_hash).toBe("a".repeat(64));

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
