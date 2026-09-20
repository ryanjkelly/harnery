import { describe, expect, test } from "bun:test";
import {
  ADAPTERS,
  type AdapterFallback,
  adapterFromPlatform,
  DEFAULT_ADAPTER,
  normalizeAdapter,
  normalizeAdapterId,
  reportAdapterFallback,
  resolveAdapterId,
} from "./adapter.ts";
import {
  EVENT_ADAPTER_IDS_V3,
  eventAdapterIdV3FromPlatform,
  normalizeEventAdapterIdV3,
} from "./events/v3/adapter-id.ts";

describe("shared adapter normalizer", () => {
  test("every workflow adapter id round-trips through both normalizers", () => {
    for (const adapter of ADAPTERS) {
      expect(normalizeAdapter(adapter)).toBe(adapter);
      expect(adapterFromPlatform(adapter, { onFallback: failOnFallback })).toBe(adapter);
      expect(normalizeEventAdapterIdV3(adapter)).toBe(adapter);
      expect(eventAdapterIdV3FromPlatform(adapter, { onFallback: failOnFallback })).toBe(adapter);
    }
  });

  test("every event adapter id round-trips through the event normalizer", () => {
    for (const adapter of EVENT_ADAPTER_IDS_V3) {
      expect(normalizeEventAdapterIdV3(adapter)).toBe(adapter);
      expect(eventAdapterIdV3FromPlatform(adapter, { onFallback: failOnFallback })).toBe(adapter);
    }
  });

  test("opencode is a first-class adapter, never folded into the default", () => {
    expect(normalizeAdapter("opencode")).toBe("opencode");
    expect(adapterFromPlatform("opencode", { onFallback: failOnFallback })).toBe("opencode");
    expect(eventAdapterIdV3FromPlatform("opencode", { onFallback: failOnFallback })).toBe(
      "opencode",
    );
  });

  test("the event-only openclaw id is not a workflow adapter", () => {
    expect(normalizeAdapter("openclaw")).toBeNull();
    expect(normalizeEventAdapterIdV3("openclaw")).toBe("openclaw");
    const seen: AdapterFallback[] = [];
    expect(adapterFromPlatform("openclaw", { onFallback: (f) => seen.push(f) })).toBe(
      DEFAULT_ADAPTER,
    );
    expect(seen).toEqual([
      { value: "openclaw", reason: "unknown", fallback: DEFAULT_ADAPTER, context: undefined },
    ]);
  });

  test("an unknown string reports an explicit fallback with its context", () => {
    const seen: AdapterFallback[] = [];
    const result = adapterFromPlatform("antigravity", {
      context: "unit-test",
      onFallback: (f) => seen.push(f),
    });
    expect(result).toBe(DEFAULT_ADAPTER);
    expect(seen).toEqual([
      { value: "antigravity", reason: "unknown", fallback: DEFAULT_ADAPTER, context: "unit-test" },
    ]);
    expect(normalizeAdapter("antigravity")).toBeNull();
    expect(normalizeEventAdapterIdV3("antigravity")).toBeNull();
  });

  test("missing or non-string values fall back with reason=missing or unknown", () => {
    const reasons = new Map<unknown, string>();
    for (const value of [undefined, null, "", 42, { adapter: "codex" }, ["codex"]]) {
      eventAdapterIdV3FromPlatform(value, { onFallback: (f) => reasons.set(value, f.reason) });
    }
    expect(reasons.get(undefined)).toBe("missing");
    expect(reasons.get(null)).toBe("missing");
    expect(reasons.get("")).toBe("missing");
    expect(reasons.get(42)).toBe("unknown");
    expect(normalizeAdapterId(42, ADAPTERS)).toBeNull();
    expect(normalizeAdapterId("codex", ADAPTERS)).toBe("codex");
  });

  test("the default sink prints only unknown values to stderr", () => {
    const lines: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      reportAdapterFallback({ value: undefined, reason: "missing", fallback: DEFAULT_ADAPTER });
      reportAdapterFallback({
        value: "mystery",
        reason: "unknown",
        fallback: DEFAULT_ADAPTER,
        context: "sink-test",
      });
      resolveAdapterId("mystery-two", ADAPTERS, DEFAULT_ADAPTER);
    } finally {
      process.stderr.write = original;
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"mystery" (sink-test)');
    expect(lines[0]).toContain(`treating it as ${DEFAULT_ADAPTER}`);
    expect(lines[1]).toContain('"mystery-two"');
  });
});

function failOnFallback(fallback: AdapterFallback): never {
  throw new Error(`unexpected adapter fallback: ${JSON.stringify(fallback)}`);
}
