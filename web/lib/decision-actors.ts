import type { InstanceIdentity } from "@/lib/coord-reader";
import { bareName, displayName } from "@/lib/identities";

/** Normalize a stored agent name (heartbeat form "Quill") to the chip form "agent-Quill". */
export function chipName(name: string | null | undefined): string | null {
  return name ? displayName(name) : null;
}

/**
 * Resolve a decision actor field to a chip name. `claimed_by` stores an
 * instance_id (from `resolveOwner`), unlike `filed_by`/`resolved_by` which
 * store the name; map the id back through the identity index so the chip
 * resolves and hovers instead of showing a raw `agent-<uuid>`.
 */
export function actorName(
  value: string | null | undefined,
  identities: Record<string, InstanceIdentity>,
): string | null {
  if (!value) return null;
  const bare = bareName(value);
  return chipName(identities[bare]?.name ?? identities[value]?.name ?? value);
}
