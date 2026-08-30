import { describe, expect, test } from "bun:test";
import { createHarneryProgram, loadLazyCommand } from "../commander.ts";

describe("agents recovery command", () => {
  test("registers explicit, approval-gated authority transaction quarantine", async () => {
    const program = createHarneryProgram();
    await loadLazyCommand(program, "agents");
    const agents = program.commands.find((candidate) => candidate.name() === "agents");
    const heal = agents?.commands.find((candidate) => candidate.name() === "heal");
    const options = heal?.options.map(({ long }) => long) ?? [];
    for (const required of ["--quarantine-transaction", "--approval-record-id", "--yes"]) {
      expect(options).toContain(required);
    }
  });
});
