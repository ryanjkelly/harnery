import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  assertSafeInstanceId,
  isSafeInstanceId,
  readHeartbeat,
  resolveContainedFile,
} from "./index.ts";

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

  test("resolves only direct children beneath a coordination root", () => {
    const root = resolve("fixture-coordination-root");
    expect(resolveContainedFile(root, "agent-1.json")).toBe(resolve(root, "agent-1.json"));
    expect(() => resolveContainedFile(root, "../outside.json")).toThrow(/directly beneath/);
    expect(() => resolveContainedFile(root, "nested/agent.json")).toThrow(/directly beneath/);
  });
});
