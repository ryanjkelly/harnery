import { describe, expect, test } from "bun:test";
import { journalPath, parseJournal } from "./index.ts";

describe("journal path and parser security", () => {
  test("rejects instance IDs that are not safe basenames", () => {
    expect(() => journalPath("../../outside")).toThrow(/instance_id/);
    expect(() => journalPath("agent/name")).toThrow(/instance_id/);
  });

  test("parses adversarial header whitespace without a polynomial regex", () => {
    const padding = " ".repeat(100_000);
    const doc = parseJournal(
      "fixture.md",
      `# Journal: agent-Test\nsession_id:${padding}fixture\nmachine: local\nstarted: now\nlast_updated: now\n---\n`,
    );
    expect(doc.header.session_id).toBe("fixture");
  });
});
