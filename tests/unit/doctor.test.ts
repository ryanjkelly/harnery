import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexAuthorizationCheck,
  codexWslBridgeCheck,
  countRecentCodexMidFlightOnboardings,
  runChecks,
} from "../../src/commands/doctor.ts";

let checks: Awaited<ReturnType<typeof runChecks>>;
const sandboxes: string[] = [];

beforeAll(async () => {
  checks = await runChecks();
});

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("harn doctor", () => {
  test("runChecks returns Node + git + .harnery checks", () => {
    const names = checks.map((c) => c.name);
    expect(names).toContain("node");
    expect(names).toContain("git");
    expect(names).toContain(".harnery/");
  });

  test("every check has a severity", () => {
    for (const c of checks) {
      expect(["ok", "warn", "fail"]).toContain(c.severity);
    }
  });

  test("node check passes on the test runner (we require ≥ 20)", () => {
    const node = checks.find((c) => c.name === "node");
    expect(node?.severity).toBe("ok");
  });

  test("git check is ok or fail (never warn, git is required)", () => {
    const git = checks.find((c) => c.name === "git");
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

  test("reports recent Codex mid-flight onboarding after the live bridge heals", () => {
    const root = mkdtempSync(join(tmpdir(), "harn-doctor-mid-flight-"));
    sandboxes.push(root);
    const directory = join(root, ".harnery", "ledgers", "v3", "diagnostics");
    mkdirSync(directory, { recursive: true });
    const now = Date.parse("2026-08-27T18:00:00.000Z");
    const write = (name: string, recordedAt: string, adapter = "codex") =>
      writeFileSync(
        join(directory, name),
        JSON.stringify({
          recorded_at: recordedAt,
          category: "mid_flight_onboarding",
          adapter,
        }),
      );
    write("mid_flight_onboarding-recent.json", "2026-08-27T17:00:00.000Z");
    write("mid_flight_onboarding-old.json", "2026-08-24T17:00:00.000Z");
    write("mid_flight_onboarding-cursor.json", "2026-08-27T17:00:00.000Z", "cursor");
    writeFileSync(join(directory, "mid_flight_onboarding-malformed.json"), "{");

    const count = countRecentCodexMidFlightOnboardings(root, now);
    expect(count).toBe(1);
    expect(
      codexWslBridgeCheck(
        {
          ok: true,
          detail: "thread identity forwarded through WSLENV (Ubuntu)",
          threadIdPresent: true,
          wslenvForwardsThreadId: true,
        },
        count,
      ),
    ).toMatchObject({
      severity: "warn",
      detail:
        "thread identity forwarded through WSLENV (Ubuntu); 1 Codex mid-flight onboarding recorded in the last 48h",
    });
  });
});
