import { describe, expect, test } from "bun:test";
import { parseScratch, scratchPath } from "./index.ts";

describe("scratch path and parser security", () => {
  test("rejects instance IDs that are not safe basenames", () => {
    expect(() => scratchPath("../../outside")).toThrow(/instance_id/);
    expect(() => scratchPath("agent/name")).toThrow(/instance_id/);
  });

  test("parses adversarial header whitespace without a polynomial regex", () => {
    const padding = " ".repeat(100_000);
    const doc = parseScratch(
      "fixture.md",
      `# Scratchpad: agent-Test\nsession_id:${padding}fixture\nmachine: local\nstarted: now\nlast_updated: now\n---\n`,
    );
    expect(doc.header.session_id).toBe("fixture");
  });
});
