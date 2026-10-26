import { expect, test } from "bun:test";

import {
  buildCodecDebugScene,
  canPreviewCodecDebugEffect,
  type CodecDebugAgent,
  createDefaultCodecDebugState,
} from "./debug-scene";

const agents: CodecDebugAgent[] = [
  { id: "debug-a", name: "Anna", packId: "f01-a", packVersion: "2" },
  { id: "debug-b", name: "Bob", packId: "m02-b", packVersion: "2" },
  { id: "debug-c", name: "Carmen", packId: "f03-c", packVersion: "2" },
];

test("effect previews stop when their endpoints are hidden and allow solo non-ping effects", () => {
  const visible = new Set(["debug-a", "debug-b"]);
  expect(canPreviewCodecDebugEffect("ping", visible, "debug-a", "debug-b")).toBe(true);
  expect(canPreviewCodecDebugEffect("ping", visible, "debug-a", "debug-a")).toBe(false);
  expect(canPreviewCodecDebugEffect("ping", visible, "debug-c", "debug-b")).toBe(false);
  expect(canPreviewCodecDebugEffect("ping", visible, "debug-a", "debug-c")).toBe(false);

  visible.delete("debug-b");
  expect(canPreviewCodecDebugEffect("ping", visible, "debug-a", "debug-b")).toBe(false);
  expect(canPreviewCodecDebugEffect("ping", visible, "debug-a", "debug-a")).toBe(false);
  for (const kind of ["energy", "power-up", "healing"] as const) {
    expect(canPreviewCodecDebugEffect(kind, visible, "", "debug-a")).toBe(true);
    expect(canPreviewCodecDebugEffect(kind, visible, "", "debug-b")).toBe(false);
  }
  expect(canPreviewCodecDebugEffect("healing", new Set(), "", "debug-a")).toBe(false);
});

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

test("an empty or reduced roster cannot retain hidden relationship or ping endpoints", () => {
  const base = {
    states: {},
    ambience: "calm" as const,
    showRelationships: true,
    showRemoteAgents: true,
    ping: { sequence: 2, fromId: "debug-a", toId: "debug-c" },
  };
  const empty = buildCodecDebugScene({ ...base, agents: [] });
  expect(empty.panels).toEqual([]);
  expect(empty.relationships).toEqual([]);
  expect(empty.transients).toEqual([]);
  expect(empty.remote_machines).toEqual([]);

  const reduced = buildCodecDebugScene({ ...base, agents: agents.slice(0, 2) });
  expect(reduced.transients).toEqual([]);
  expect(reduced.relationships).toEqual([
    expect.objectContaining({ from_instance_id: "debug-a", to_instance_id: "debug-b" }),
  ]);
  const self = buildCodecDebugScene({
    ...base,
    agents: agents.slice(0, 1),
    ping: { sequence: 3, fromId: "debug-a", toId: "debug-a" },
  });
  expect(self.transients).toEqual([]);
  expect(self.relationships).toEqual([]);
});

test("remote summaries follow visible remote cards and disappear when remote mode is disabled", () => {
  const roster = Array.from({ length: 11 }, (_, index) => ({
    id: `debug-${index}`,
    name: `Character ${index}`,
    packId: "f01-a",
    packVersion: "2",
  }));
  const base = {
    states: {},
    ambience: "busy" as const,
    showRelationships: false,
    showRemoteAgents: true,
  };
  const full = buildCodecDebugScene({ ...base, agents: roster });
  expect(full.remote_machines).toEqual([
    expect.objectContaining({ machine: "debug-relay", visible_agent_count: 2 }),
  ]);
  expect(full.panels.filter((panel) => panel.machine)).toHaveLength(2);

  const reduced = buildCodecDebugScene({ ...base, agents: roster.slice(0, 6) });
  expect(reduced.remote_machines[0]?.visible_agent_count).toBe(1);
  const local = buildCodecDebugScene({ ...base, agents: roster, showRemoteAgents: false });
  expect(local.remote_machines).toEqual([]);
  expect(local.panels.every((panel) => !panel.machine && !panel.remote_source)).toBe(true);
});
