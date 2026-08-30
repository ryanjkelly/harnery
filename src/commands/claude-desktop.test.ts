import { describe, expect, test } from "bun:test";
import { createHarneryProgram, loadLazyCommand } from "../commander.ts";

describe("claude-desktop command", () => {
  test("registers the V3-compatible desktop commands", async () => {
    const program = createHarneryProgram();
    await loadLazyCommand(program, "claude-desktop");
    const desktop = program.commands.find((command) => command.name() === "claude-desktop");
    expect(desktop?.commands.map((command) => command.name())).toEqual([
      "accounts",
      "sessions",
      "mirror",
    ]);
  });
});
