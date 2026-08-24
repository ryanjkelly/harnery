import type { CodecRelationship, CodecScene, CodecTransient } from "./codec/contracts";

export interface AgentSceneDetail {
  panel: CodecScene["panels"][number] | undefined;
  relationships: CodecRelationship[];
  transients: CodecTransient[];
}

/** Select one agent's complete Codec projection without creating a second
 * projector. Callers may supply native, canonical, and route identifiers; the
 * exact panel id wins and becomes the key for related scene-level evidence. */
export function selectAgentSceneDetail(
  scene: CodecScene,
  identifiers: Iterable<string | null | undefined>,
): AgentSceneDetail {
  const candidates = new Set(
    Array.from(identifiers).filter((value): value is string => Boolean(value?.trim())),
  );
  const panel = scene.panels.find((candidate) => candidates.has(candidate.instance_id));
  if (panel) candidates.add(panel.instance_id);

  return {
    panel,
    relationships: scene.relationships.filter(
      (relationship) =>
        candidates.has(relationship.from_instance_id) ||
        candidates.has(relationship.to_instance_id),
    ),
    transients: scene.transients.filter(
      (transient) =>
        (transient.from_instance_id !== undefined && candidates.has(transient.from_instance_id)) ||
        (transient.to_instance_id !== undefined && candidates.has(transient.to_instance_id)),
    ),
  };
}
