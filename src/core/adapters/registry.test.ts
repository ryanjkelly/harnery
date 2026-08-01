import { describe, expect, test } from "bun:test";
import {
  BUILTIN_ADAPTER_IDS,
  BUILTIN_ADAPTER_PROFILES,
  validateAdapterEffort,
} from "./profiles.ts";
import { AdapterRegistry, createBuiltinAdapterRegistry } from "./registry.ts";
import { ADAPTER_CAPABILITY_DIMENSIONS } from "./types.ts";

describe("adapter registry", () => {
  test("ships exactly the agreed Claude, Codex, and Cursor adapters", () => {
    const registry = createBuiltinAdapterRegistry();
    expect(registry.ids()).toEqual(["claude-code", "codex", "cursor"]);
    expect<string[]>([...BUILTIN_ADAPTER_IDS]).toEqual(registry.ids());
    expect(Object.keys(registry.spawners())).toEqual(registry.ids());
  });

  test("every profile makes an explicit claim for every capability dimension", () => {
    for (const profile of Object.values(BUILTIN_ADAPTER_PROFILES)) {
      expect(Object.keys(profile.capabilities)).toEqual([...ADAPTER_CAPABILITY_DIMENSIONS]);
      for (const dimension of ADAPTER_CAPABILITY_DIMENSIONS) {
        const claim = profile.capabilities[dimension];
        expect(["supported", "partial", "unsupported", "unknown"]).toContain(claim.support);
        if (claim.support === "partial" || claim.support === "unknown") {
          expect(claim.note?.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("duplicate ids fail instead of silently replacing an adapter", () => {
    const adapter = createBuiltinAdapterRegistry().require("codex");
    expect(() => new AdapterRegistry([adapter, adapter])).toThrow(/already registered/);
  });

  test("unknown adapter lookups name the registered alternatives", () => {
    expect(() => createBuiltinAdapterRegistry().require("gemini")).toThrow(
      /unknown adapter "gemini".*claude-code, codex, cursor/,
    );
  });

  test("effort domains are adapter-specific and fail before launch", () => {
    expect(() => validateAdapterEffort("claude-code", "max")).not.toThrow();
    expect(() => validateAdapterEffort("codex", "minimal")).not.toThrow();
    expect(() => validateAdapterEffort("cursor", "high")).toThrow(/supported values: none/);
    expect(() => validateAdapterEffort("claude-code", "minimal")).toThrow(
      /low, medium, high, xhigh, max/,
    );
  });
});
