import { describe, expect, test } from "bun:test";
import { codexAuthorizationCheck, runChecks } from "../../src/commands/doctor.ts";

describe("harn doctor", () => {
  test("runChecks returns Node + git + .harnery checks", async () => {
    const checks = await runChecks();
    const names = checks.map((c) => c.name);
    expect(names).toContain("node");
    expect(names).toContain("git");
    expect(names).toContain(".harnery/");
  });

  test("every check has a severity", async () => {
    for (const c of await runChecks()) {
      expect(["ok", "warn", "fail"]).toContain(c.severity);
    }
  });

  test("node check passes on the test runner (we require ≥ 20)", async () => {
    const node = (await runChecks()).find((c) => c.name === "node");
    expect(node?.severity).toBe("ok");
  });

  test("git check is ok or fail (never warn, git is required)", async () => {
    const git = (await runChecks()).find((c) => c.name === "git");
    expect(git).toBeDefined();
    if (git) {
      expect(["ok", "fail"]).toContain(git.severity);
    }
  });

  test("maps Codex trust states without granting authorization", () => {
    expect(
      codexAuthorizationCheck({
        status: "runnable",
        detail: "9 Harnery hooks trusted and enabled",
        hookCount: 9,
        disabledCount: 0,
        trustCounts: { trusted: 9 },
      }).severity,
    ).toBe("ok");
    const review = codexAuthorizationCheck({
      status: "review_required",
      detail: "9 of 9 Harnery hooks require review",
      hookCount: 9,
      disabledCount: 0,
      trustCounts: { untrusted: 9 },
    });
    expect(review.severity).toBe("warn");
    expect(review.hint).toContain("Settings > Hooks");
  });
});
