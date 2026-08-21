import { describe, expect, test } from "bun:test";
import { createHarneryProgram } from "../commander.ts";

describe("ledger-v3 command", () => {
  test("registers explicit status, initialization, and invalid-authority recovery", () => {
    const command = createHarneryProgram().commands.find(
      (candidate) => candidate.name() === "ledger-v3",
    );
    expect(command?.commands.map((candidate) => candidate.name())).toEqual([
      "status",
      "initialize",
      "recover",
    ]);
    const recover = command?.commands.find((candidate) => candidate.name() === "recover");
    expect(recover?.options.map(({ long }) => long)).toEqual([
      "--root",
      "--approval-record-id",
      "--yes",
    ]);
  });
});
