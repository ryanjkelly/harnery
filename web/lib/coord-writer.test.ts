import { describe, expect, test } from "bun:test";
import { endSession, pingAgent, releaseClaim, safeOwnerId } from "./coord-writer";

describe("web coordination writer instance IDs", () => {
  test("rejects path traversal at every mutation boundary", () => {
    const attack = "../../outside";
    expect(safeOwnerId(attack)).toBe(false);
    expect(releaseClaim(attack, "src/index.ts")).toMatchObject({
      ok: false,
      error: "invalid instance_id",
    });
    expect(pingAgent(attack, "hello")).toMatchObject({
      ok: false,
      error: "invalid instance_id",
    });
    expect(endSession(attack)).toMatchObject({ ok: false, error: "invalid instance_id" });
  });
});
