import { describe, expect, test } from "bun:test";
import {
  CODEC_SCHEMA_VERSION,
  type CodecPanelScene,
  type CodecScene,
  type Presented,
} from "../contracts";
import { CodecEffectBudget } from "./budget";
import { deriveCodecEffects, effectForPreview } from "./derive";

const AT = "2026-08-30T20:00:00.000Z";

function shown<T>(value: T): Presented<T> {
  return { value, provenance: "projection", confidence: "high", observed_at: AT };
}

function panel(overrides: Partial<CodecPanelScene> = {}): CodecPanelScene {
  return {
    instance_id: "agent-a",
    identity: { display_name: "Aster" },
    presence: shown("online"),
    activity: shown("working"),
    lifecycle: shown("active"),
    expression: shown("focused"),
    attention: shown("none"),
    context_band: shown("ample"),
    progress_rhythm: shown("steady"),
    recent_actions: [],
    telemetry: shown("healthy"),
    character: { pack_id: "test", pack_version: "1" },
    updated_at: AT,
    ...overrides,
  };
}

function scene(panels: CodecPanelScene[], transients: CodecScene["transients"] = []): CodecScene {
  return {
    schema_version: CODEC_SCHEMA_VERSION,
    freshness: shown("live"),
    panels,
    remote_machines: [],
    relationships: [],
    transients,
    team_ambience: shown("busy"),
    generated_at: AT,
  };
}

describe("Codec effect derivation", () => {
  test("maps a new message transient to one point-to-point ping", () => {
    const next = scene(
      [panel(), panel({ instance_id: "agent-b" })],
      [
        {
          cue_id: "message-1",
          kind: "message",
          from_instance_id: "agent-a",
          to_instance_id: "agent-b",
          occurred_at: AT,
          expires_at: "2099-01-01T00:00:00.000Z",
          provenance: "event",
        },
      ],
    );
    expect(deriveCodecEffects(scene(next.panels), next)).toEqual([
      {
        id: "transient:message-1",
        kind: "ping",
        sourceInstanceId: "agent-a",
        targetInstanceId: "agent-b",
        priority: 3,
      },
    ]);
    expect(
      deriveCodecEffects(scene(next.panels), next, { seenTransientIds: new Set(["message-1"]) }),
    ).toEqual([]);
  });

  test("maps recovery, reconnection, and completed work to distinct effects", () => {
    const degraded = panel({ telemetry: shown("degraded") });
    expect(deriveCodecEffects(scene([degraded]), scene([panel()]))[0]?.kind).toBe("healing");

    const offline = panel({ presence: shown("offline") });
    expect(deriveCodecEffects(scene([offline]), scene([panel()]))[0]?.kind).toBe("power-up");

    const completed = panel({
      recent_actions: [{ category: "test", outcome: "ok", event_id: "action-2", observed_at: AT }],
    });
    expect(deriveCodecEffects(scene([panel()]), scene([completed]))).toMatchObject([
      { id: "energy:agent-a:action-2", kind: "energy", targetInstanceId: "agent-a" },
    ]);
  });

  test("recovery wins over lower-priority activity changes on one panel", () => {
    const previous = panel({ activity: shown("idle"), telemetry: shown("degraded") });
    expect(deriveCodecEffects(scene([previous]), scene([panel()]))).toHaveLength(1);
    expect(deriveCodecEffects(scene([previous]), scene([panel()]))[0]?.kind).toBe("healing");
  });

  test("preview cues use deterministic ids and priorities", () => {
    expect(
      effectForPreview({ sequence: 4, kind: "power-up", targetInstanceId: "agent-a" }),
    ).toEqual({
      id: "preview:power-up:4",
      kind: "power-up",
      targetInstanceId: "agent-a",
      priority: 2,
    });
  });
});

describe("Codec effect budget", () => {
  test("deduplicates ids, caps concurrency, and releases target slots", () => {
    const budget = new CodecEffectBudget({ maxConcurrent: 2, seenLimit: 4 });
    const one = effectForPreview({ sequence: 1, kind: "energy", targetInstanceId: "agent-a" });
    const sameTarget = effectForPreview({
      sequence: 2,
      kind: "healing",
      targetInstanceId: "agent-a",
    });
    const other = effectForPreview({ sequence: 3, kind: "energy", targetInstanceId: "agent-b" });
    const overflow = effectForPreview({
      sequence: 4,
      kind: "power-up",
      targetInstanceId: "agent-c",
    });

    expect(budget.start(one)).toBe(true);
    expect(budget.start(one)).toBe(false);
    expect(budget.start(sameTarget)).toBe(false);
    expect(budget.start(other)).toBe(true);
    expect(budget.start(overflow)).toBe(false);
    expect(budget.activeCount).toBe(2);
    budget.finish(one.id);
    expect(
      budget.start(effectForPreview({ sequence: 5, kind: "healing", targetInstanceId: "agent-a" })),
    ).toBe(true);
  });
});
