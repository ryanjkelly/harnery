import { EVENT_V3_SCHEMA_DIGEST, EVENT_V3_SCHEMA_LINEAGE } from "./generated.ts";

/** One event schema digest as the generator records it. */
export type EventV3SchemaDigestV3 = `sha256:${string}`;

/**
 * The committed schema history: groups of digests that are additive to each
 * other, oldest group first and oldest digest first inside a group. A new
 * group starts at every breaking change.
 */
export interface EventV3SchemaLineageV3 {
  groups: readonly (readonly EventV3SchemaDigestV3[])[];
}

/** Where a digest sits in the lineage. */
export interface EventV3SchemaGroupPositionV3 {
  /** Index of the additive group, 0 for the oldest. */
  group_index: number;
  /** Index of the digest inside its group, 0 for the oldest. */
  position: number;
  /** Every digest in the same group, oldest first. */
  group: readonly EventV3SchemaDigestV3[];
}

/** What a runtime may do with an epoch it finds. */
export type EventV3EpochCompatibilityVerdictV3 = "serve" | "replace_breaking" | "unknown";

export interface EventV3EpochCompatibilityV3 {
  verdict: EventV3EpochCompatibilityVerdictV3;
  reason: string;
}

export interface EventV3EpochSchemasV3 {
  /** Digest recorded in the epoch's genesis. */
  genesis_schema_digest: string;
  /** Every digest the epoch's rows carry, when known. */
  present_schema_digests?: readonly string[];
}

/** Find the additive group and position of a digest, or undefined when the lineage lacks it. */
export function schemaGroupForDigestV3(
  digest: string,
  lineage: EventV3SchemaLineageV3 = EVENT_V3_SCHEMA_LINEAGE,
): EventV3SchemaGroupPositionV3 | undefined {
  for (const [groupIndex, group] of lineage.groups.entries()) {
    const position = group.indexOf(digest as EventV3SchemaDigestV3);
    if (position >= 0) return { group_index: groupIndex, position, group };
  }
  return undefined;
}

/**
 * The additive group holding the running build's own schema digest. The
 * generator keeps that digest last in the last group, so this lookup fails
 * only when the generated contract and lineage disagree.
 */
export function runtimeSchemaGroupV3(
  lineage: EventV3SchemaLineageV3 = EVENT_V3_SCHEMA_LINEAGE,
  runtimeDigest: string = EVENT_V3_SCHEMA_DIGEST,
): EventV3SchemaGroupPositionV3 {
  const found = schemaGroupForDigestV3(runtimeDigest, lineage);
  if (!found) throw new Error("event ledger V3 schema lineage does not hold the runtime digest");
  return found;
}

/**
 * Decide whether this runtime may serve an epoch with the given schemas.
 *
 * Current rule, kept until the compatibility work switches callers over: serve
 * only when the genesis digest equals the runtime digest, otherwise replace.
 *
 * Intended rule, as each runtime applies it to the epoch it finds:
 *
 * | The epoch's schemas, as the running runtime sees them | Verdict |
 * |---|---|
 * | All in the runtime's own additive group | `serve`; the runtime stamps its own digest on what it writes |
 * | Genesis digest known, in a group before a breaking change | `replace_breaking` |
 * | Any digest the runtime does not know | `unknown`: block this runtime only, reason `epoch_schema_unknown`; replacing needs the approved command |
 *
 * `present_schema_digests` lists every digest the epoch's rows carry; the
 * genesis digest always counts as present.
 */
export function epochCompatibilityV3(
  input: EventV3EpochSchemasV3,
  _lineage: EventV3SchemaLineageV3 = EVENT_V3_SCHEMA_LINEAGE,
  runtimeDigest: string = EVENT_V3_SCHEMA_DIGEST,
): EventV3EpochCompatibilityV3 {
  if (input.genesis_schema_digest === runtimeDigest) {
    return { verdict: "serve", reason: "genesis_schema_digest_matches_runtime" };
  }
  return { verdict: "replace_breaking", reason: "genesis_schema_digest_incompatible" };
}
