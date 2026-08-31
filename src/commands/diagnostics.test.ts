import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { registerDiagnosticsCommand } from "./diagnostics.ts";

describe("diagnostics command", () => {
  test("registers the stable bundle lifecycle", () => {
    const program = new Command();
    registerDiagnosticsCommand(program, quietEmit());
    const command = program.commands.find((candidate) => candidate.name() === "diagnostics");
    expect(command?.commands.map((candidate) => candidate.name())).toEqual([
      "list",
      "show",
      "capture",
      "replay",
    ]);
  });
});

function quietEmit(): EmitContext {
  return {
    config() {},
    data() {},
    rows() {},
    text() {},
    file() {},
    error() {},
    log() {},
    setExitCode() {},
  };
}
