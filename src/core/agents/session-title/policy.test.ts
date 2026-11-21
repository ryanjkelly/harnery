import { describe, expect, test } from "bun:test";
import { isAgentNameChange, parseAgentTitle, titleChangeAllowed, withAgentName } from "./policy.ts";

describe("titleChangeAllowed", () => {
  test("allows any title before one is applied", () => {
    expect(titleChangeAllowed(undefined, "Agent Orion - X")).toBe(true);
  });
  test("allows re-delivering the applied title", () => {
    expect(titleChangeAllowed("Agent Orion - X", "Agent Orion - X")).toBe(true);
  });
  test("allows the done form after the applied title", () => {
    expect(titleChangeAllowed("X", "[DONE] X")).toBe(true);
    expect(titleChangeAllowed("Agent unknown - X", "[DONE] Agent Orion - X")).toBe(true);
  });
  test("refuses a different non-done title mid-session", () => {
    expect(titleChangeAllowed("Agent Orion - X", "Agent Orion - Y")).toBe(false);
  });
  test("refuses anything but itself after a done title", () => {
    expect(titleChangeAllowed("[DONE] X", "[DONE] Y")).toBe(false);
    expect(titleChangeAllowed("[DONE] X", "X")).toBe(false);
    expect(titleChangeAllowed("[DONE] X", "[DONE] X")).toBe(true);
  });
  test("refuses an empty pending title", () => {
    expect(titleChangeAllowed(undefined, "")).toBe(false);
    expect(titleChangeAllowed("X", "")).toBe(false);
  });
});

describe("agent name changes", () => {
  test("parses Harnery's title form and nothing else", () => {
    expect(parseAgentTitle("Agent Orion - Auth refactor")).toEqual({
      done: false,
      agentName: "Orion",
      description: "Auth refactor",
    });
    expect(parseAgentTitle("[DONE] Agent Orion - A - B")).toEqual({
      done: true,
      agentName: "Orion",
      description: "A - B",
    });
    expect(parseAgentTitle("Portal work")).toBeNull();
    expect(parseAgentTitle("Agent Orion")).toBeNull();
    expect(parseAgentTitle(undefined)).toBeNull();
  });
  test("replaces only the agent name", () => {
    expect(withAgentName("Agent Orion - Auth refactor", "Vela")).toBe("Agent Vela - Auth refactor");
    expect(withAgentName("[DONE] Agent Orion - Auth refactor", "Vela")).toBe(
      "[DONE] Agent Vela - Auth refactor",
    );
    expect(withAgentName("Agent Orion - Auth refactor", "Orion")).toBeNull();
    expect(withAgentName("Agent Orion - Auth refactor", " ")).toBeNull();
    expect(withAgentName("Portal work", "Vela")).toBeNull();
  });
  test("a name change keeps the description and the done marker", () => {
    expect(isAgentNameChange("Agent Orion - X", "Agent Vela - X")).toBe(true);
    expect(isAgentNameChange("[DONE] Agent Orion - X", "[DONE] Agent Vela - X")).toBe(true);
    expect(isAgentNameChange("Agent unknown - X", "Agent Orion - X")).toBe(true);
    expect(isAgentNameChange("Agent Orion - X", "Agent Orion - X")).toBe(false);
    expect(isAgentNameChange("Agent Orion - X", "Agent Vela - Y")).toBe(false);
    expect(isAgentNameChange("[DONE] Agent Orion - X", "Agent Vela - X")).toBe(false);
    expect(isAgentNameChange("Portal work", "Agent Vela - X")).toBe(false);
    expect(isAgentNameChange(undefined, "Agent Vela - X")).toBe(false);
  });
  test("the policy allows a name change and still refuses a new description", () => {
    expect(titleChangeAllowed("Agent Orion - X", "Agent Vela - X")).toBe(true);
    expect(titleChangeAllowed("[DONE] Agent Orion - X", "[DONE] Agent Vela - X")).toBe(true);
    expect(titleChangeAllowed("Agent Orion - X", "Agent Vela - Y")).toBe(false);
    expect(titleChangeAllowed("[DONE] Agent Orion - X", "Agent Vela - X")).toBe(false);
  });
});
