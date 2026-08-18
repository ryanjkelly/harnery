import { describe, expect, test } from "bun:test";
import { createHarneryProgram } from "../commander.ts";

describe("claude-desktop command", () => {
  test("registers the V2-compatible desktop commands", () => {
    const desktop = createHarneryProgram().commands.find(
      (command) => command.name() === "claude-desktop",
    );
    expect(desktop?.commands.map((command) => command.name())).toEqual([
      "accounts",
      "sessions",
      "mirror",
    ]);
  });
});
