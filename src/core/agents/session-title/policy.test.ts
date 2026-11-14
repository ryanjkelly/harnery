import { describe, expect, test } from "bun:test";
import { titleChangeAllowed } from "./policy.ts";

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
