import { describe, expect, test } from "bun:test";
import { createHarneryProgram } from "../../src/commander.ts";
import {
  appendDurableHistoryRecord,
  createInMemoryLoggerRuntime,
  queryLogs,
} from "../../src/core/storage/index.ts";

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

  test("registers the logging, inbox, messaging, and conversation surfaces", () => {
    const names = new Set(createHarneryProgram().commands.map((command) => command.name()));
    for (const name of ["logs", "inbox", "messages", "conversations"]) {
      expect(names.has(name), name).toBeTrue();
    }
  });

  test("honors command exclusions for every new top-level surface", () => {
    const excluded = ["logs", "inbox", "messages", "conversations"];
    const names = new Set(
      createHarneryProgram({ skipCommands: excluded }).commands.map((command) => command.name()),
    );
    for (const name of excluded) expect(names.has(name), name).toBeFalse();
    expect(names.has("storage")).toBeTrue();
  });

  test("exports the durable history, logger, and bounded query APIs", () => {
    expect(typeof appendDurableHistoryRecord).toBe("function");
    expect(typeof createInMemoryLoggerRuntime).toBe("function");
    expect(typeof queryLogs).toBe("function");
  });
});
