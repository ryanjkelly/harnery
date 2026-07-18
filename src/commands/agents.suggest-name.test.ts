import { describe, expect, test } from "bun:test";
import { buildSuggestedName } from "./agents.ts";

describe("buildSuggestedName", () => {
  test("composes 'Agent <name> - <description>'", () => {
    const out = buildSuggestedName("Hollis", ["Auth", "Refactor"]);
    expect(out).toEqual({
      suggestedName: "Agent Hollis - Auth Refactor",
      description: "Auth Refactor",
    });
  });

  test("collapses internal whitespace and trims", () => {
    const out = buildSuggestedName("Hollis", ["  Auth", "", "  Refactor  "]);
    expect(out?.suggestedName).toBe("Agent Hollis - Auth Refactor");
  });

  test("returns null on an empty description", () => {
    expect(buildSuggestedName("Hollis", [])).toBeNull();
    expect(buildSuggestedName("Hollis", ["", "   "])).toBeNull();
  });

  test("falls back to 'unknown' when the agent name is blank", () => {
    expect(buildSuggestedName("", ["Auth Refactor"])?.suggestedName).toBe(
      "Agent unknown - Auth Refactor",
    );
  });
});
