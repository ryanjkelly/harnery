import { describe, expect, test } from "bun:test";
import { assertSafeInstanceId, isSafeInstanceId, readHeartbeat } from "./index.ts";

describe("coordination instance IDs", () => {
  test("accepts portable coordination basenames", () => {
    expect(isSafeInstanceId("019f8037-5867-73d1-b06f-c3c67e67d7b0")).toBe(true);
    expect(isSafeInstanceId("fixture_agent-1")).toBe(true);
  });

  test("rejects traversal, separators, controls, and oversized IDs", () => {
    for (const value of ["../outside", "a/b", "a\\b", ".", "..", "a\0b", "é", "a".repeat(129)]) {
      expect(isSafeInstanceId(value)).toBe(false);
      expect(() => assertSafeInstanceId(value)).toThrow(/instance_id/);
    }
  });

  test("heartbeat lookup rejects a traversal ID before filesystem access", () => {
    expect(readHeartbeat("../../outside")).toBeNull();
  });
});
