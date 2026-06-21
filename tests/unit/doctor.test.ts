import { describe, expect, test } from "bun:test";
import { runChecks } from "../../src/commands/doctor.ts";

describe("harn doctor", () => {
  test("runChecks returns Node + git + .harnery checks", () => {
    const checks = runChecks();
    const names = checks.map((c) => c.name);
    expect(names).toContain("node");
    expect(names).toContain("git");
    expect(names).toContain(".harnery/");
  });

  test("every check has a severity", () => {
    for (const c of runChecks()) {
      expect(["ok", "warn", "fail"]).toContain(c.severity);
    }
  });

  test("node check passes on the test runner (we require ≥ 20)", () => {
    const node = runChecks().find((c) => c.name === "node");
    expect(node?.severity).toBe("ok");
  });

  test("git check is ok or fail (never warn, git is required)", () => {
    const git = runChecks().find((c) => c.name === "git");
    expect(git).toBeDefined();
    if (git) {
      expect(["ok", "fail"]).toContain(git.severity);
    }
  });
});
