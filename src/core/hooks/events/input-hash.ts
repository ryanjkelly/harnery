import { createHash } from "node:crypto";

/** Canonical JSON for hashing adapter input before any event-payload clamp. */
export function canonicalToolInput(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Exact-input digest used by the report-only run-quality evaluator. */
export function toolInputHash(toolName: string, input: unknown): string {
  return createHash("sha256")
    .update(toolName)
    .update("\n")
    .update(canonicalToolInput(input))
    .digest("hex");
}

/** Hash a semantic target without persisting its path, URL, or query. */
export function toolTargetHash(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const target =
    record.file_path ??
    record.path ??
    record.target ??
    record.url ??
    record.notebook_path ??
    record.pattern;
  if (target === undefined) return undefined;
  return createHash("sha256")
    .update(toolName)
    .update("\n")
    .update(canonicalToolInput(target))
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}
