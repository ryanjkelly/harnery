import { describe, expect, test } from "bun:test";
import {
  BUILTIN_HARNESS_IDS,
  BUILTIN_HARNESS_PROFILES,
  validateHarnessEffort,
} from "./profiles.ts";
import { createBuiltinHarnessRegistry, HarnessRegistry } from "./registry.ts";
import { HARNESS_CAPABILITY_DIMENSIONS } from "./types.ts";

describe("harness registry", () => {
  test("ships exactly the agreed Claude, Codex, and Cursor adapters", () => {
    const registry = createBuiltinHarnessRegistry();
    expect(registry.ids()).toEqual(["claude-code", "codex", "cursor"]);
    expect<string[]>([...BUILTIN_HARNESS_IDS]).toEqual(registry.ids());
    expect(Object.keys(registry.spawners())).toEqual(registry.ids());
  });

  test("every profile makes an explicit claim for every capability dimension", () => {
    for (const profile of Object.values(BUILTIN_HARNESS_PROFILES)) {
      expect(Object.keys(profile.capabilities)).toEqual([...HARNESS_CAPABILITY_DIMENSIONS]);
      for (const dimension of HARNESS_CAPABILITY_DIMENSIONS) {
        const claim = profile.capabilities[dimension];
        expect(["supported", "partial", "unsupported", "unknown"]).toContain(claim.support);
        if (claim.support === "partial" || claim.support === "unknown") {
          expect(claim.note?.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("duplicate ids fail instead of silently replacing an adapter", () => {
    const adapter = createBuiltinHarnessRegistry().require("codex");
    expect(() => new HarnessRegistry([adapter, adapter])).toThrow(/already registered/);
  });

  test("unknown adapter lookups name the registered alternatives", () => {
    expect(() => createBuiltinHarnessRegistry().require("gemini")).toThrow(
      /unknown harness "gemini".*claude-code, codex, cursor/,
    );
  });

  test("effort domains are adapter-specific and fail before launch", () => {
    expect(() => validateHarnessEffort("claude-code", "max")).not.toThrow();
    expect(() => validateHarnessEffort("codex", "minimal")).not.toThrow();
    expect(() => validateHarnessEffort("cursor", "high")).toThrow(/supported values: none/);
    expect(() => validateHarnessEffort("claude-code", "minimal")).toThrow(
      /low, medium, high, xhigh, max/,
    );
  });
});
