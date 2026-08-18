import type { TSchema } from "@sinclair/typebox";
import { canonicalJsonV2 } from "../v2/canonical.ts";

export interface SchemaAdvanceEligibilityV3 {
  eligible: boolean;
  strict: boolean;
  issues: string[];
}

/**
 * Mechanical half of ADR 0080's in-place advance gate. It proves that every
 * value accepted by the prior JSON Schema remains accepted by the next schema.
 * Semantic reinterpretations remain breaking even when this structural check
 * passes and require genesis review.
 */
export function validateAdditiveSchemaAdvanceV3(
  prior: TSchema,
  next: TSchema,
): SchemaAdvanceEligibilityV3 {
  const issues: string[] = [];
  const result = isSuperset(prior as JsonSchema, next as JsonSchema, "$", issues);
  return {
    eligible: result.compatible && result.strict,
    strict: result.strict,
    issues: [...new Set(issues)].sort(),
  };
}

type JsonSchema = Record<string, unknown>;
type Compatibility = { compatible: boolean; strict: boolean };

function isSuperset(
  prior: JsonSchema,
  next: JsonSchema,
  path: string,
  issues: string[],
): Compatibility {
  const priorAnyOf = schemaArray(prior.anyOf);
  const nextAnyOf = schemaArray(next.anyOf);
  if (priorAnyOf || nextAnyOf) {
    if (!priorAnyOf || !nextAnyOf) return incompatible(path, "union_shape_changed", issues);
    const used = new Set<number>();
    let strict = nextAnyOf.length > priorAnyOf.length;
    for (const [priorIndex, priorBranch] of priorAnyOf.entries()) {
      let match: { index: number; result: Compatibility } | undefined;
      for (const [nextIndex, nextBranch] of nextAnyOf.entries()) {
        if (used.has(nextIndex)) continue;
        const branchIssues: string[] = [];
        const result = isSuperset(
          priorBranch,
          nextBranch,
          `${path}/anyOf/${priorIndex}`,
          branchIssues,
        );
        if (result.compatible) {
          match = { index: nextIndex, result };
          break;
        }
      }
      if (!match)
        return incompatible(`${path}/anyOf/${priorIndex}`, "branch_removed_or_narrowed", issues);
      used.add(match.index);
      strict ||= match.result.strict;
    }
    return { compatible: true, strict };
  }

  if (prior.type === "object" || next.type === "object") {
    if (prior.type !== "object" || next.type !== "object") {
      return incompatible(path, "type_changed", issues);
    }
    if (prior.additionalProperties !== next.additionalProperties) {
      return incompatible(path, "additional_properties_changed", issues);
    }
    const priorProperties = schemaMap(prior.properties);
    const nextProperties = schemaMap(next.properties);
    const priorRequired = stringSet(prior.required);
    const nextRequired = stringSet(next.required);
    let strict = false;
    for (const name of priorRequired) {
      if (!nextRequired.has(name)) strict = true;
    }
    for (const name of nextRequired) {
      if (!priorRequired.has(name)) {
        return incompatible(`${path}/properties/${name}`, "optional_became_required", issues);
      }
    }
    for (const [name, priorProperty] of Object.entries(priorProperties)) {
      const nextProperty = nextProperties[name];
      if (!nextProperty)
        return incompatible(`${path}/properties/${name}`, "property_removed", issues);
      const result = isSuperset(priorProperty, nextProperty, `${path}/properties/${name}`, issues);
      if (!result.compatible) return result;
      strict ||= result.strict;
    }
    for (const name of Object.keys(nextProperties)) {
      if (!(name in priorProperties)) {
        if (nextRequired.has(name)) {
          return incompatible(`${path}/properties/${name}`, "new_property_is_required", issues);
        }
        strict = true;
      }
    }
    return { compatible: true, strict };
  }

  if (prior.type === "array" || next.type === "array") {
    if (prior.type !== "array" || next.type !== "array")
      return incompatible(path, "type_changed", issues);
    if (number(next.minItems, 0) < number(prior.minItems, 0)) {
      // A lower minimum broadens acceptance.
    } else if (number(next.minItems, 0) > number(prior.minItems, 0)) {
      return incompatible(path, "array_minimum_narrowed", issues);
    }
    const priorMax = number(prior.maxItems, Number.POSITIVE_INFINITY);
    const nextMax = number(next.maxItems, Number.POSITIVE_INFINITY);
    if (nextMax < priorMax) return incompatible(path, "array_maximum_narrowed", issues);
    const priorItems = prior.items as JsonSchema | undefined;
    const nextItems = next.items as JsonSchema | undefined;
    if (!!priorItems !== !!nextItems) return incompatible(path, "array_items_changed", issues);
    const itemResult =
      priorItems && nextItems
        ? isSuperset(priorItems, nextItems, `${path}/items`, issues)
        : { compatible: true, strict: false };
    return {
      compatible: itemResult.compatible,
      strict:
        itemResult.strict ||
        number(next.minItems, 0) < number(prior.minItems, 0) ||
        nextMax > priorMax,
    };
  }

  const ignored = new Set(["$id", "title", "description"]);
  const priorComparable = Object.fromEntries(
    Object.entries(prior).filter(([key]) => !ignored.has(key)),
  );
  const nextComparable = Object.fromEntries(
    Object.entries(next).filter(([key]) => !ignored.has(key)),
  );
  if (canonicalJsonV2(priorComparable) !== canonicalJsonV2(nextComparable)) {
    return incompatible(path, "constraint_changed", issues);
  }
  return { compatible: true, strict: false };
}

function incompatible(path: string, reason: string, issues: string[]): Compatibility {
  issues.push(`${path}:${reason}`);
  return { compatible: false, strict: false };
}

function schemaArray(value: unknown): JsonSchema[] | undefined {
  return Array.isArray(value) ? (value as JsonSchema[]) : undefined;
}

function schemaMap(value: unknown): Record<string, JsonSchema> {
  return value && typeof value === "object" ? (value as Record<string, JsonSchema>) : {};
}

function stringSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
  );
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}
