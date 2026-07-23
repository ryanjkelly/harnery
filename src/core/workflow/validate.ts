/**
 * Minimal validator for the StageSchema JSON-schema subset. Deliberately tiny:
 * a full JSON Schema implementation would pull a dependency (ajv) for
 * validation depth workflow gates don't need. Supported: type, oneOf,
 * properties, required, additionalProperties, items, minItems/maxItems,
 * minLength/maxLength, pattern, and enum.
 * Returns a list of human-readable problems (empty = valid) so the engine can
 * feed failures back into the retry prompt verbatim.
 */

import type { StageSchema } from "./types.ts";

export function validateAgainstSchema(value: unknown, schema: StageSchema, path = "$"): string[] {
  const problems: string[] = [];

  if (schema.oneOf) {
    const branches = schema.oneOf.map((branch) => validateAgainstSchema(value, branch, path));
    const matches = branches.filter((branch) => branch.length === 0).length;
    if (matches !== 1) {
      if (matches > 1) {
        return [`${path}: expected exactly one schema option to match, got ${matches}`];
      }
      return [
        `${path}: expected exactly one schema option to match`,
        ...branches.map(
          (branch, index) =>
            `${path}: option ${index + 1}: ${branch.slice(0, 4).join("; ") || "did not match"}`,
        ),
      ];
    }
  }

  if (schema.enum) {
    if (!schema.enum.some((v) => v === value)) {
      problems.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${short(value)}`);
    }
    return problems; // enum is exhaustive; type check is implied by membership
  }

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return [`${path}: expected object, got ${short(value)}`];
      }
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in obj)) problems.push(`${path}.${key}: required property missing`);
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (key in obj) problems.push(...validateAgainstSchema(obj[key], sub, `${path}.${key}`));
      }
      if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(schema.properties ?? {}));
        for (const key of Object.keys(obj)) {
          if (!allowed.has(key)) problems.push(`${path}.${key}: unexpected property`);
        }
      }
      return problems;
    }
    case "array": {
      if (!Array.isArray(value)) return [`${path}: expected array, got ${short(value)}`];
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        problems.push(`${path}: expected at least ${schema.minItems} item(s), got ${value.length}`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        problems.push(`${path}: expected at most ${schema.maxItems} item(s), got ${value.length}`);
      }
      if (schema.items) {
        for (const [i, item] of value.entries()) {
          problems.push(
            ...validateAgainstSchema(item, schema.items as StageSchema, `${path}[${i}]`),
          );
        }
      }
      return problems;
    }
    case "string": {
      if (typeof value !== "string") {
        return [`${path}: expected string, got ${short(value)}`];
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        problems.push(
          `${path}: expected at least ${schema.minLength} character(s), got ${value.length}`,
        );
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        problems.push(
          `${path}: expected at most ${schema.maxLength} character(s), got ${value.length}`,
        );
      }
      if (schema.pattern !== undefined) {
        try {
          if (!new RegExp(schema.pattern).test(value)) {
            problems.push(`${path}: expected string matching ${JSON.stringify(schema.pattern)}`);
          }
        } catch {
          problems.push(`${path}: schema pattern is invalid`);
        }
      }
      return problems;
    }
    case "number":
    case "boolean": {
      if (typeof value !== schema.type) {
        problems.push(`${path}: expected ${schema.type}, got ${short(value)}`);
      }
      return problems;
    }
    default:
      return [`${path}: unsupported schema type ${String((schema as { type?: unknown }).type)}`];
  }
}

/**
 * Parse one schema-gated JSON value.
 *
 * Exact JSON and a whole fenced value remain the normal paths. Some harnesses
 * prepend a short narration despite an explicit JSON-only contract. Accept
 * that drift only when the reply contains exactly one unambiguous top-level
 * object or array, the value reaches the end of the reply, and JSON.parse
 * accepts it. Trailing prose, multiple values, and malformed candidates remain
 * failures.
 */
export function parseStageOutput(text: string): { value?: unknown; error?: string } {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return { value: JSON.parse(stripped) };
  } catch (err) {
    const embedded = singleTrailingJsonContainer(stripped);
    if (embedded !== undefined) return { value: embedded };
    return { error: `not valid JSON: ${(err as Error).message}` };
  }
}

function singleTrailingJsonContainer(text: string): unknown | undefined {
  const candidates: Array<{ end: number; value: unknown }> = [];
  let start = -1;
  let stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (start === -1) {
      if (char === "{" || char === "[") {
        start = index;
        stack = [char];
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char !== "}" && char !== "]") continue;

    const expectedOpen = char === "}" ? "{" : "[";
    if (stack.at(-1) !== expectedOpen) {
      start = -1;
      stack = [];
      continue;
    }
    stack.pop();
    if (stack.length > 0) continue;

    const end = index + 1;
    try {
      candidates.push({ end, value: JSON.parse(text.slice(start, end)) });
    } catch {
      // A balanced brace pair in narration is not a JSON candidate.
    }
    start = -1;
  }

  if (candidates.length !== 1 || text.slice(candidates[0]!.end).trim() !== "") {
    return undefined;
  }
  return candidates[0]!.value;
}

function short(value: unknown): string {
  const s = JSON.stringify(value);
  return s === undefined ? String(value) : s.length > 60 ? `${s.slice(0, 60)}…` : s;
}
