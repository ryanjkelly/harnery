import { describe, expect, test } from "bun:test";
import { createHarneryProgram } from "../commander.ts";

describe("work command", () => {
  test("registers the complete durable-work surface", () => {
    const program = createHarneryProgram();
    const command = program.commands.find((candidate) => candidate.name() === "work");
    expect(command).toBeDefined();
    expect(command?.commands.map((candidate) => candidate.name())).toEqual([
      "create",
      "list",
      "show",
      "reconcile",
      "run",
      "retry",
      "accept",
      "cancel",
      "reopen",
    ]);
  });
});
