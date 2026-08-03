import { describe, expect, test } from "bun:test";
import { inspectAdapterSpread } from "./adapter-spread.ts";

const TEAM_OF_SIX = {
  implementer: {},
  verifier: {},
  reviewer: {},
  planner: {},
  auditor: {},
  warden: {},
};

describe("inspectAdapterSpread", () => {
  test("flags a team with no pins when other adapters are attested and idle", () => {
    // The recorded failure: six specialists, zero pins, subscription auth. Every
    // child inherited the default and one seat carried the whole team.
    const v = inspectAdapterSpread({
      specialists: TEAM_OF_SIX,
      defaultAdapter: "claude-code",
      reachable: ["claude-code", "cursor", "codex"],
      subscriptionOnly: true,
    });
    expect(v.concentrated).toBe(true);
    expect(v.adapter).toBe("claude-code");
    expect(v.unused).toEqual(["cursor", "codex"]);
    expect(v.reason).toContain("no specialist pins an adapter");
    expect(v.reason).toContain("cursor, codex");
  });

  test("flags a team that pins every specialist to the same adapter", () => {
    // Explicit pins are not automatically better than none: six pins onto one
    // seat is the same concentration, so the message names the other shape.
    const v = inspectAdapterSpread({
      specialists: { a: { adapter: "cursor" }, b: { adapter: "cursor" } },
      defaultAdapter: "claude-code",
      reachable: ["claude-code", "cursor"],
      subscriptionOnly: true,
    });
    expect(v.concentrated).toBe(true);
    expect(v.reason).toContain("all 2 specialists resolve to cursor");
    expect(v.reason).toContain("This adapter is");
  });

  test("passes a team that spreads", () => {
    const v = inspectAdapterSpread({
      specialists: { a: { adapter: "cursor" }, b: { adapter: "codex" }, c: {} },
      defaultAdapter: "claude-code",
      reachable: ["claude-code", "cursor", "codex"],
      subscriptionOnly: true,
    });
    expect(v.concentrated).toBe(false);
    expect(v.unused).toEqual([]);
  });

  test("stays quiet when only one adapter is actually reachable", () => {
    // The whole point of keying on attestation rather than registration: an
    // adapter that is registered but has never completed a turn is not an option,
    // so it must not appear in `reachable`, and with nothing else proven to run
    // a refusal would be advice the operator cannot take. The call site is what
    // enforces that distinction (registry.ids() filtered by readAttestation).
    const v = inspectAdapterSpread({
      specialists: TEAM_OF_SIX,
      defaultAdapter: "claude-code",
      reachable: ["claude-code"],
      subscriptionOnly: true,
    });
    expect(v.concentrated).toBe(false);
  });

  test("stays quiet under metered billing", () => {
    // Without a shared session meter, concentration is a cost curve rather than
    // a cliff, and refusing would be a judgement about spend, not about safety.
    const v = inspectAdapterSpread({
      specialists: TEAM_OF_SIX,
      defaultAdapter: "claude-code",
      reachable: ["claude-code", "cursor", "codex"],
      subscriptionOnly: false,
    });
    expect(v.concentrated).toBe(false);
  });

  test("stays quiet for a single specialist", () => {
    const v = inspectAdapterSpread({
      specialists: { solo: {} },
      defaultAdapter: "claude-code",
      reachable: ["claude-code", "cursor"],
      subscriptionOnly: true,
    });
    expect(v.concentrated).toBe(false);
  });
});
