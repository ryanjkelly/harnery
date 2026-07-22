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
      "plan",
      "service",
      "tick",
      "run",
    ]);
    const plan = command?.commands.find((candidate) => candidate.name() === "plan");
    expect(plan?.commands.map((candidate) => candidate.name())).toEqual([
      "list",
      "show",
      "approve",
      "reject",
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
    const create = command?.commands.find((candidate) => candidate.name() === "create");
    expect(create?.registeredArguments[0]?.required).toBe(false);
    expect(create?.options.map((option) => option.long)).toContain("--mission");
  });
});
