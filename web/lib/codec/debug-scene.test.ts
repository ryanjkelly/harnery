import { expect, test } from "bun:test";

import {
  buildCodecDebugScene,
  type CodecDebugAgent,
  createDefaultCodecDebugState,
} from "./debug-scene";

const agents: CodecDebugAgent[] = [
  { id: "debug-a", name: "Anna", packId: "f01-a", packVersion: "2" },
  { id: "debug-b", name: "Bob", packId: "m02-b", packVersion: "2" },
  { id: "debug-c", name: "Carmen", packId: "f03-c", packVersion: "2" },
];

test("builds count-bounded cards with controlled per-card state", () => {
  const states = Object.fromEntries(
    agents.map((agent, index) => [agent.id, createDefaultCodecDebugState(index)]),
  );
  states["debug-b"] = {
    ...states["debug-b"]!,
    activity: "needs-input",
    lifecycle: "blocked",
    expression: "alert",
    telemetry: "degraded",
    contextUsedPercent: 92,
  };

  const scene = buildCodecDebugScene({
    agents: agents.slice(0, 2),
    states,
    ambience: "alert",
    showRelationships: true,
    showRemoteAgents: true,
  });

  expect(scene.panels).toHaveLength(2);
  expect(scene.team_ambience.value).toBe("alert");
  expect(scene.panels[1]).toMatchObject({
    activity: { value: "needs-input" },
    lifecycle: { value: "blocked" },
    expression: { value: "alert" },
    telemetry: { value: "degraded" },
    context_band: { value: "low" },
  });
  expect(scene.relationships[0]?.status).toBe("blocked");
});

test("emits only valid point-to-point ping cues", () => {
  const states = Object.fromEntries(
    agents.map((agent, index) => [agent.id, createDefaultCodecDebugState(index)]),
  );
  const base = {
    agents,
    states,
    ambience: "busy" as const,
    showRelationships: false,
    showRemoteAgents: false,
  };

  const scene = buildCodecDebugScene({
    ...base,
    ping: { sequence: 7, fromId: "debug-a", toId: "debug-c" },
  });
  const invalid = buildCodecDebugScene({
    ...base,
    ping: { sequence: 8, fromId: "debug-a", toId: "missing" },
  });

  expect(scene.transients).toEqual([
    expect.objectContaining({
      cue_id: "debug-ping-7",
      kind: "message",
      from_instance_id: "debug-a",
      to_instance_id: "debug-c",
    }),
  ]);
  expect(invalid.transients).toEqual([]);
});
