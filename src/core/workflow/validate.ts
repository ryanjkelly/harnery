/**
 * Minimal validator for the StageSchema JSON-schema subset. Deliberately tiny:
 * a full JSON Schema implementation would pull a dependency (ajv) for
 * validation depth workflow gates don't need. Supported: type, properties,
 * required, items, enum. Returns a list of human-readable problems (empty =
 * valid) so the engine can feed failures back into the retry prompt verbatim.
 */

import type { StageSchema } from "./types.ts";

export function validateAgainstSchema(value: unknown, schema: StageSchema, path = "$"): string[] {
  const problems: string[] = [];

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
      return problems;
    }
    case "array": {
      if (!Array.isArray(value)) return [`${path}: expected array, got ${short(value)}`];
      if (schema.items) {
        for (const [i, item] of value.entries()) {
          problems.push(
            ...validateAgainstSchema(item, schema.items as StageSchema, `${path}[${i}]`),
          );
        }
      }
      return problems;
    }
    case "string":
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

/** Strip accidental markdown code fences, then strict-parse JSON. */
export function parseStageOutput(text: string): { value?: unknown; error?: string } {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return { value: JSON.parse(stripped) };
  } catch (err) {
    return { error: `not valid JSON: ${(err as Error).message}` };
  }
}

function short(value: unknown): string {
  const s = JSON.stringify(value);
  return s === undefined ? String(value) : s.length > 60 ? `${s.slice(0, 60)}…` : s;
}
