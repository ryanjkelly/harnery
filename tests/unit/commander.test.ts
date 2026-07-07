import { describe, expect, test } from "bun:test";
import { createHarneryProgram } from "../../src/commander.ts";

describe("createHarneryProgram", () => {
  test("returns a Commander program with default binName 'harn'", () => {
    const program = createHarneryProgram();
    expect(program.name()).toBe("harn");
  });

  test("respects custom binName from opts", () => {
    const program = createHarneryProgram({ binName: "acme" });
    expect(program.name()).toBe("acme");
  });

  test("version string is set", () => {
    const program = createHarneryProgram();
    expect(program.version()).toBeDefined();
    expect(typeof program.version()).toBe("string");
  });

  test("description is non-empty", () => {
    const program = createHarneryProgram();
    expect(program.description()).toBeTruthy();
  });
});
