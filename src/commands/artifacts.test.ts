import { describe, expect, test } from "bun:test";
import { createHarneryProgram } from "../commander.ts";

describe("artifacts command", () => {
  test("registers the managed artifact lifecycle", () => {
    const program = createHarneryProgram();
    const command = program.commands.find((candidate) => candidate.name() === "artifacts");
    expect(command).toBeDefined();
    expect(command?.aliases()).toContain("artifact");
    expect(command?.commands.map((candidate) => candidate.name())).toEqual([
      "create",
      "list",
      "show",
      "renew",
      "release",
      "clean",
    ]);
  });
});
