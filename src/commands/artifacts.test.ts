import { describe, expect, test } from "bun:test";
import { createHarneryProgram, loadLazyCommand } from "../commander.ts";

describe("artifacts command", () => {
  test("registers the managed artifact lifecycle", async () => {
    const program = createHarneryProgram();
    await loadLazyCommand(program, "artifacts");
    const command = program.commands.find((candidate) => candidate.name() === "artifacts");
    expect(command).toBeDefined();
    expect(command?.aliases()).toContain("artifact");
    expect(command?.commands.map((candidate) => candidate.name())).toEqual([
      "create",
      "adopt-unmanaged",
      "list",
      "show",
      "renew",
      "release",
      "clean",
    ]);
  });
});
