import { describe, expect, test } from "bun:test";
import { selectAgentSceneDetail } from "./agent-detail";
import type { CodecScene } from "./codec/contracts";

function scene(): CodecScene {
  const presented = <T>(value: T) => ({
    value,
    provenance: "event" as const,
    confidence: "high" as const,
    observed_at: "2026-08-24T12:00:00.000Z",
  });
  return {
    schema_version: 2,
    freshness: presented("live"),
    panels: [
      {
        instance_id: "inst_agent",
        identity: { display_name: "Talia" },
        presence: presented("online"),
        activity: presented("working"),
        lifecycle: presented("active"),
        expression: presented("focused"),
        attention: presented("none"),
        context_band: presented("ample"),
        progress_rhythm: presented("steady"),
        recent_actions: [],
        character: { pack_id: "pack", pack_version: "1" },
        updated_at: "2026-08-24T12:00:00.000Z",
      },
      {
        instance_id: "inst_peer",
        identity: { display_name: "Peer" },
        presence: presented("online"),
        activity: presented("idle"),
        lifecycle: presented("active"),
        expression: presented("neutral"),
        attention: presented("none"),
        context_band: presented("unknown"),
        progress_rhythm: presented("unknown"),
        recent_actions: [],
        character: { pack_id: "pack", pack_version: "1" },
        updated_at: "2026-08-24T12:00:00.000Z",
      },
    ],
    remote_machines: [],
    relationships: [
      {
        relationship_id: "rel_match",
        from_instance_id: "inst_peer",
        to_instance_id: "inst_agent",
        kind: "shared-coordination",
        status: "active",
        provenance: "event",
      },
      {
        relationship_id: "rel_other",
        from_instance_id: "inst_peer",
        to_instance_id: "inst_else",
        kind: "dependency",
        status: "waiting",
        provenance: "projection",
      },
    ],
    transients: [
      {
        cue_id: "cue_match",
        kind: "message",
        to_instance_id: "inst_agent",
        occurred_at: "2026-08-24T12:00:00.000Z",
        expires_at: "2026-08-24T12:01:00.000Z",
        provenance: "event",
      },
      {
        cue_id: "cue_other",
        kind: "message",
        to_instance_id: "inst_else",
        occurred_at: "2026-08-24T12:00:00.000Z",
        expires_at: "2026-08-24T12:01:00.000Z",
        provenance: "event",
      },
    ],
    team_ambience: presented("busy"),
    generated_at: "2026-08-24T12:00:00.000Z",
  };
}

describe("selectAgentSceneDetail", () => {
  test("selects the matching panel and only its scene-level evidence", () => {
    const detail = selectAgentSceneDetail(scene(), ["native-id", "inst_agent"]);
    expect(detail.panel?.instance_id).toBe("inst_agent");
    expect(detail.relationships.map((row) => row.relationship_id)).toEqual(["rel_match"]);
    expect(detail.transients.map((row) => row.cue_id)).toEqual(["cue_match"]);
  });

  test("retains related evidence for a known id when no recent panel survives", () => {
    const detail = selectAgentSceneDetail(scene(), ["inst_else"]);
    expect(detail.panel).toBeUndefined();
    expect(detail.relationships.map((row) => row.relationship_id)).toEqual(["rel_other"]);
    expect(detail.transients.map((row) => row.cue_id)).toEqual(["cue_other"]);
  });
});
