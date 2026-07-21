import { describe, expect, test } from "bun:test";
import { createHarneryProgram } from "../commander.ts";
import { normalizePolicy, policyDigest } from "../core/policy/index.ts";
import { renderPolicy } from "./policy.ts";

describe("policy command", () => {
  test("is registered in the composed command tree", () => {
    const program = createHarneryProgram();
    const command = program.commands.find((candidate) => candidate.name() === "policy");
    expect(command).toBeDefined();
    expect(command?.commands.map((candidate) => candidate.name())).toEqual(["check"]);
  });

  test("renders normalized policy facts and digest", () => {
    const policy = normalizePolicy({
      name: "safe run",
      max_cost_usd: 2,
      allowed_isolation: ["sandbox"],
      network: "ask",
    });
    const output = renderPolicy(policy, policyDigest(policy));
    expect(output).toContain("safe run (schema 1)");
    expect(output).toContain("cost ceiling: $2.0000");
    expect(output).toContain("network: ask");
    expect(output).toContain("isolation: sandbox");
  });
});
