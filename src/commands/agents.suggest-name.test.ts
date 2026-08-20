import { describe, expect, test } from "bun:test";
import {
  buildLifecycleSuggestedName,
  buildSuggestedName,
} from "../core/agents/state/heartbeat-writer.ts";

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

describe("buildLifecycleSuggestedName", () => {
  test("projects only the done title from the original session name", () => {
    const name = "Agent Hollis - Auth Refactor";
    expect(buildLifecycleSuggestedName(name, "active")).toBeNull();
    expect(buildLifecycleSuggestedName(name, "blocked")).toBeNull();
    expect(buildLifecycleSuggestedName(name, "done")).toBe("[DONE] Agent Hollis - Auth Refactor");
  });

  test("returns null when the session has no current name", () => {
    expect(buildLifecycleSuggestedName(undefined, "done")).toBeNull();
  });

  test("is idempotent and normalizes legacy lifecycle prefixes", () => {
    expect(buildLifecycleSuggestedName("[DONE] Agent Hollis - Auth Refactor", "done")).toBe(
      "[DONE] Agent Hollis - Auth Refactor",
    );
    expect(buildLifecycleSuggestedName("[BLOCKED] - Agent Hollis - Auth Refactor", "done")).toBe(
      "[DONE] Agent Hollis - Auth Refactor",
    );
  });
});
