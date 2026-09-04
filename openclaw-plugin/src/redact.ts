const TRUSTED_IDENTITIES: Record<"event" | "context", ReadonlySet<string>> = {
  event: new Set(["toolCallId"]),
  context: new Set(["sessionKey", "runId", "agentId"]),
} as const;

export interface CaptureSkeleton {
  event: unknown;
  context: unknown;
}

/** Keep structure and correlation ids while replacing every content-bearing value. */
export function captureSkeleton(event: unknown, context: unknown): CaptureSkeleton {
  return {
    event: redactValue(event, "event", []),
    context: redactValue(context, "context", []),
  };
}

function redactValue(
  value: unknown,
  envelope: keyof typeof TRUSTED_IDENTITIES,
  path: readonly string[],
): unknown {
  if (typeof value === "string") {
    const key = path[0];
    if (path.length === 1 && key && TRUSTED_IDENTITIES[envelope].has(key)) return value;
    return { type: "string", length: value.length };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      items: value.map((item, index) => redactValue(item, envelope, [...path, String(index)])),
    };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, child]) => [
        name,
        redactValue(child, envelope, [...path, name]),
      ]),
    );
  }
  if (value === null) return { type: "null" };
  return { type: typeof value };
}
