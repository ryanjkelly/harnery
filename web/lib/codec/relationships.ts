/**
 * Sourced relationship edges.
 *
 * One provable edge kind, derived and never guessed:
 *
 * - `shared-coordination`: a panel whose event-backed parentage points at
 *   another rendered panel (subagent/workflow delegation, violet).
 *
 * Pure function over the rendered panels so the derivation is unit-testable.
 */

import type { CodecPanelScene, CodecRelationship } from "./contracts";

export function deriveRelationships(panels: readonly CodecPanelScene[]): CodecRelationship[] {
  const panelIds = new Set(panels.map((p) => p.instance_id));
  const edges: CodecRelationship[] = [];

  // Parentage: already proved by the projector (both panels rendered).
  for (const panel of panels) {
    const parent = panel.parent_instance_id?.value;
    if (parent && panelIds.has(parent)) {
      edges.push({
        relationship_id: `parent:${parent}:${panel.instance_id}`,
        from_instance_id: parent,
        to_instance_id: panel.instance_id,
        kind: "shared-coordination",
        status: "active",
        provenance: "event",
      });
    }
  }

  return edges;
}
