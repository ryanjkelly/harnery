import { describe, expect, test } from "bun:test";

import type { CodecPanelScene, CodecRelationship } from "./contracts";
import { summarizeCodecTeam } from "./team-summary";

function panel(instanceId: string, name: string, machine?: string): CodecPanelScene {
  return {
    instance_id: instanceId,
    identity: { display_name: name },
    ...(machine ? { machine } : {}),
  } as CodecPanelScene;
}

describe("summarizeCodecTeam", () => {
  test("groups local and remote panels while preserving evidence-backed relationship states", () => {
    const panels = [
      panel("l-1", "Patty"),
      panel("r-2", "Kelly", "studio-mac"),
      panel("r-1", "Joe", "studio-mac"),
    ];
    const relationships: CodecRelationship[] = [
      {
        relationship_id: "delegation",
        from_instance_id: "l-1",
        to_instance_id: "r-1",
        kind: "shared-coordination",
        status: "active",
        provenance: "event",
      },
      {
        relationship_id: "wait",
        from_instance_id: "r-1",
        to_instance_id: "r-2",
        kind: "dependency",
        status: "waiting",
        provenance: "projection",
      },
    ];

    const summary = summarizeCodecTeam({ panels, relationships });
    expect(summary.local_agents).toBe(1);
    expect(summary.remote_agents).toBe(2);
    expect(summary.machines.map((machine) => machine.label)).toEqual([
      "this machine",
      "studio-mac",
    ]);
    expect(summary.machines[1]?.panels.map((candidate) => candidate.identity.display_name)).toEqual(
      ["Joe", "Kelly"],
    );
    expect(summary.delegated).toBe(1);
    expect(summary.dependencies).toEqual({ active: 0, waiting: 1, blocked: 0 });
  });

  test("drops relationships whose endpoint is not visible", () => {
    const summary = summarizeCodecTeam({
      panels: [panel("visible", "Patty")],
      relationships: [
        {
          relationship_id: "expired",
          from_instance_id: "visible",
          to_instance_id: "gone",
          kind: "dependency",
          status: "blocked",
          provenance: "event",
        },
      ],
    });

    expect(summary.relationships).toEqual([]);
    expect(summary.dependencies.blocked).toBe(0);
  });
});
