import { describe, expect, test } from "bun:test";
import { createHarneryProgram } from "../commander.ts";

describe("supervisor command", () => {
  test("registers the durable goal lifecycle", () => {
    const program = createHarneryProgram();
    const command = program.commands.find((candidate) => candidate.name() === "supervisor");
    expect(command).toBeDefined();
    expect(command?.commands.map((candidate) => candidate.name())).toEqual([
      "create",
      "list",
      "show",
      "service",
      "tick",
      "run",
    ]);
    const service = command?.commands.find((candidate) => candidate.name() === "service");
    expect(service?.commands.map((candidate) => candidate.name())).toEqual([
      "start",
      "run",
      "status",
      "stop",
      "logs",
      "daemon",
    ]);
  });
});
