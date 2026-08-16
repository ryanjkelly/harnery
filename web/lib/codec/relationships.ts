/**
 * Sourced relationship edges (plan phase 3, final piece).
 *
 * Two provable edge kinds, both derived — never guessed:
 *
 * - `shared-coordination`: a panel whose event-backed parentage points at
 *   another rendered panel (subagent/workflow delegation, violet).
 * - `dependency`: durable work item A depends on item B, and BOTH items map
 *   to rendered panels through their latest run's child sessions. Edges flow
 *   prerequisite → dependent. Status comes from the dependent's projection:
 *   still waiting on the prerequisite → `waiting` (amber); the prerequisite
 *   failed/blocked → `blocked` (red); otherwise `active` (cyan).
 *
 * Pure function over injected data so the derivation is unit-testable; the
 * scene assembly supplies the real read models (work-reader +
 * workflow-reader, both pure-fs).
 */

import type { CodecPanelScene, CodecRelationship } from "./contracts";

export interface DependencySourceItem {
  id: string;
  state: string;
  dependencies: string[];
  unresolved_dependencies: string[];
  latest_run_id?: string;
}

export function deriveRelationships(
  panels: readonly CodecPanelScene[],
  workItems: readonly DependencySourceItem[],
  /** run id → that run's child session ids (= panel instance ids). */
  childSessionsOf: (runId: string) => string[],
): CodecRelationship[] {
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

  // Work dependencies: prove every leg before drawing.
  const panelsForItem = new Map<string, string[]>();
  const itemById = new Map(workItems.map((i) => [i.id, i]));
  const resolvePanels = (item: DependencySourceItem): string[] => {
    const cached = panelsForItem.get(item.id);
    if (cached) return cached;
    let ids: string[] = [];
    if (item.latest_run_id) {
      try {
        ids = childSessionsOf(item.latest_run_id).filter((sid) => panelIds.has(sid));
      } catch {
        ids = []; // unprovable = undrawn
      }
    }
    panelsForItem.set(item.id, ids);
    return ids;
  };

  for (const dependent of workItems) {
    for (const prerequisiteId of dependent.dependencies) {
      const prerequisite = itemById.get(prerequisiteId);
      if (!prerequisite) continue;
      const fromPanels = resolvePanels(prerequisite);
      const toPanels = resolvePanels(dependent);
      if (fromPanels.length === 0 || toPanels.length === 0) continue;
      const status: CodecRelationship["status"] =
        prerequisite.state === "blocked" || prerequisite.state === "cancelled"
          ? "blocked"
          : dependent.unresolved_dependencies.includes(prerequisiteId)
            ? "waiting"
            : "active";
      for (const from of fromPanels) {
        for (const to of toPanels) {
          if (from === to) continue;
          edges.push({
            relationship_id: `dep:${prerequisiteId}:${dependent.id}:${from}:${to}`,
            from_instance_id: from,
            to_instance_id: to,
            kind: "dependency",
            status,
            provenance: "projection",
          });
        }
      }
    }
  }

  return edges;
}
