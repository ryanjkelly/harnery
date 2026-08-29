import { describe, expect, test } from "bun:test";
import { createHarneryProgram } from "../commander.ts";

describe("ledger-v3 command", () => {
  test("registers explicit authority, support-pack, and sealed-history tools", () => {
    const command = createHarneryProgram().commands.find(
      (candidate) => candidate.name() === "ledger-v3",
    );
    expect(command?.commands.map((candidate) => candidate.name())).toEqual([
      "status",
      "initialize",
      "recover",
      "verify-support",
      "unpack-support",
      "support-transaction-status",
      "support-shadow",
      "support-replacement",
      "verify-v1-fence",
      "legacy-inventory",
      "verify-legacy",
      "legacy-canary",
    ]);
    const recover = command?.commands.find((candidate) => candidate.name() === "recover");
    expect(recover?.options.map(({ long }) => long)).toEqual([
      "--root",
      "--approval-record-id",
      "--yes",
    ]);
    const replacement = command?.commands.find(
      (candidate) => candidate.name() === "support-replacement",
    );
    expect(replacement?.options.map(({ long }) => long)).toEqual([
      "--transaction",
      "--exact-transaction",
      "--yes",
      "--root",
    ]);
    const legacyCanary = command?.commands.find(
      (candidate) => candidate.name() === "legacy-canary",
    );
    expect(legacyCanary?.options.map(({ long }) => long)).toContain("--shadow");
  }, 15_000);
});
