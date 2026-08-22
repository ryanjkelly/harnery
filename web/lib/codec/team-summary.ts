import type { CodecPanelScene, CodecRelationship, CodecScene } from "./contracts";

export interface CodecMachineGroup {
  key: string;
  label: string;
  remote: boolean;
  panels: CodecPanelScene[];
}

export interface CodecTeamSummary {
  machines: CodecMachineGroup[];
  local_agents: number;
  remote_agents: number;
  relationships: CodecRelationship[];
  delegated: number;
  dependencies: {
    active: number;
    waiting: number;
    blocked: number;
  };
}

/**
 * Compact, presentation-only rollup of the evidence already in a Codec scene.
 * Relationships with an endpoint outside the rendered panel set are excluded,
 * so the map never describes an invisible or expired agent.
 */
export function summarizeCodecTeam(
  scene: Pick<CodecScene, "panels" | "relationships">,
): CodecTeamSummary {
  const panelIds = new Set(scene.panels.map((panel) => panel.instance_id));
  const relationships = scene.relationships.filter(
    (relationship) =>
      panelIds.has(relationship.from_instance_id) && panelIds.has(relationship.to_instance_id),
  );
  const machines = new Map<string, CodecMachineGroup>();

  for (const panel of scene.panels) {
    const remote = Boolean(panel.machine);
    const key = remote ? `remote:${panel.machine}` : "local";
    const existing = machines.get(key);
    if (existing) {
      existing.panels.push(panel);
      continue;
    }
    machines.set(key, {
      key,
      label: panel.machine ?? "this machine",
      remote,
      panels: [panel],
    });
  }

  const orderedMachines = [...machines.values()]
    .map((machine) => ({
      ...machine,
      panels: [...machine.panels].sort((a, b) =>
        a.identity.display_name.localeCompare(b.identity.display_name),
      ),
    }))
    .sort((a, b) => Number(a.remote) - Number(b.remote) || a.label.localeCompare(b.label));

  const dependencies = relationships.filter((relationship) => relationship.kind === "dependency");
  return {
    machines: orderedMachines,
    local_agents: scene.panels.filter((panel) => !panel.machine).length,
    remote_agents: scene.panels.filter((panel) => panel.machine).length,
    relationships,
    delegated: relationships.filter((relationship) => relationship.kind === "shared-coordination")
      .length,
    dependencies: {
      active: dependencies.filter((relationship) => relationship.status === "active").length,
      waiting: dependencies.filter((relationship) => relationship.status === "waiting").length,
      blocked: dependencies.filter((relationship) => relationship.status === "blocked").length,
    },
  };
}
