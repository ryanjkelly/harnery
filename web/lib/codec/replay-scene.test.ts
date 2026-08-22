import { describe, expect, test } from "bun:test";

import { createCodecReplayPhases } from "./replay-scene";

describe("createCodecReplayPhases", () => {
  test("is deterministic and covers the full relationship vocabulary", () => {
    const first = createCodecReplayPhases();
    expect(createCodecReplayPhases()).toEqual(first);
    expect(first.map((phase) => phase.id)).toEqual(["dispatch", "converge", "release"]);
    expect(first.every((phase) => phase.scene.panels.length === 6)).toBe(true);
    expect(
      new Set(first.flatMap((phase) => phase.scene.relationships.map((r) => r.status))),
    ).toEqual(new Set(["active", "waiting", "blocked"]));
    expect(first.flatMap((phase) => phase.scene.transients).map((cue) => cue.kind)).toContain(
      "dependency-completed",
    );
    expect(
      first[0]?.scene.panels.find((panel) => panel.instance_id === "replay-atlas")?.semantic,
    ).toMatchObject({ state: "current", next_step: { basis: "prediction" } });
    expect(
      first[0]?.scene.panels.find((panel) => panel.instance_id === "replay-ember")?.semantic,
    ).toMatchObject({ state: "unavailable", receipt: { reason_code: "model_unavailable" } });
  });

  test("keeps every endpoint paneled and clearly synthetic", () => {
    for (const phase of createCodecReplayPhases()) {
      const ids = new Set(phase.scene.panels.map((panel) => panel.instance_id));
      expect(phase.scene.panels.every((panel) => panel.instance_id.startsWith("replay-"))).toBe(
        true,
      );
      for (const relationship of phase.scene.relationships) {
        expect(ids.has(relationship.from_instance_id)).toBe(true);
        expect(ids.has(relationship.to_instance_id)).toBe(true);
      }
      for (const cue of phase.scene.transients) {
        if (cue.from_instance_id) expect(ids.has(cue.from_instance_id)).toBe(true);
        if (cue.to_instance_id) expect(ids.has(cue.to_instance_id)).toBe(true);
      }
    }
  });
});
