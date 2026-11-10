import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bunCheck,
  type Check,
  codexAuthorizationCheck,
  codexWslBridgeCheck,
  countRecentCodexMidFlightOnboardings,
  doctorOutcome,
  doctorReport,
  nodeCheck,
  runChecks,
} from "../../src/commands/doctor.ts";
import { doctorEnvironmentFindings } from "../../src/core/config.ts";
import { removeDir } from "../helpers/remove-dir.ts";

let checks: Awaited<ReturnType<typeof runChecks>>;
const sandboxes: string[] = [];

beforeAll(async () => {
  checks = await runChecks();
});

afterEach(() => {
  for (const root of sandboxes.splice(0)) removeDir(root);
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

  test("every check returned by runChecks has a scope", () => {
    for (const c of checks) {
      expect(["runtime", "environment"]).toContain(c.scope);
    }
  });

  test("node check does not fail on the patched Node on PATH", () => {
    const node = checks.find((c) => c.name === "node");
    expect(node?.severity).not.toBe("fail");
  });

  test("node check reports the node on PATH, not the version Bun emulates", () => {
    const bun = { node: "24.3.0", bun: "1.4.0" };
    expect(nodeCheck({ ok: true, out: "v21.7.3" }, bun)).toMatchObject({
      severity: "fail",
    });
    expect(nodeCheck({ ok: true, out: "v18.20.0" }, bun).severity).toBe("fail");
    expect(nodeCheck({ ok: false, out: "" }, bun).severity).toBe("warn");
    expect(nodeCheck({ ok: false, out: "" }, { node: "22.23.4" })).toMatchObject({
      severity: "ok",
      detail: "22.23.4",
    });
  });

  test("node check rejects vulnerable releases and accepts each fixed boundary", () => {
    for (const node of [
      "20.20.2",
      "22.23.3",
      "23.11.0",
      "24.22.0",
      "25.8.0",
      "26.12.0",
      "24.22.1-rc.1",
      "bad",
    ]) {
      expect(nodeCheck({ ok: true, out: `v${node}` }, { node }).severity).toBe("fail");
    }
    for (const node of ["22.23.4", "22.24.0", "24.22.1", "24.22.2", "26.12.1", "27.0.0"]) {
      expect(nodeCheck({ ok: true, out: `v${node}` }, { node }).severity).toBe("ok");
    }
    expect(nodeCheck({ ok: false, out: "" }, { node: "24.22.0" }).severity).toBe("fail");
  });

  test("bun check rejects vulnerable releases and accepts the fixed boundary", () => {
    for (const version of ["1.3.3", "1.4.0", "1.4.3", "1.4.4-canary", "bad"]) {
      expect(bunCheck(version).severity).toBe("fail");
    }
    for (const version of ["1.4.4", "1.4.5", "1.5.0", "2.0.0"]) {
      expect(bunCheck(version).severity).toBe("ok");
    }
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

  describe("runtime and environment scope", () => {
    const oldPathNode = { ok: true, out: "v20.19.0" };
    const onNode = { node: "20.19.0" };
    const onBun = { node: "24.3.0", bun: "1.4.4" };
    const report = { mode: "report", error: null } as const;
    const strict = { mode: "fail", error: null } as const;
    const git: Check = { name: "git", scope: "runtime", severity: "ok", detail: "2.43.0" };

    test("running on an old Node.js is a runtime failure, opt-in or not", () => {
      const node = nodeCheck(oldPathNode, onNode);
      expect(node).toMatchObject({ scope: "runtime", severity: "fail" });
      for (const setting of [strict, report]) {
        const r = doctorReport([node, git], setting);
        expect(r.exitCode).toBe(1);
        expect(r.json).toMatchObject({ outcome: "fail", summary: { runtimeFail: 1 } });
      }
    });

    test("running on Bun with an old PATH Node.js is an environment failure that fails by default", () => {
      const node = nodeCheck(oldPathNode, onBun);
      expect(node).toMatchObject({ scope: "environment", severity: "fail" });
      expect(nodeCheck({ ok: false, out: "" }, onBun).scope).toBe("environment");
      const r = doctorReport([node, git], strict);
      expect(r.exitCode).toBe(1);
      expect(r.json).toMatchObject({
        outcome: "fail",
        environmentFindings: "fail",
        summary: { fail: 1, runtimeFail: 0, environmentFail: 1 },
      });
      expect(r.text).toContain("✗ node");
      expect(r.text).toContain("environment finding");
    });

    test("a host that opts in reports the environment failure and exits 0", () => {
      const node = nodeCheck(oldPathNode, onBun);
      const r = doctorReport([node, git], report);
      expect(r.exitCode).toBe(0);
      expect(r.json).toMatchObject({
        outcome: "reported",
        environmentFindings: "report",
        summary: { fail: 1, runtimeFail: 0, environmentFail: 1 },
      });
      expect((r.json.checks as Check[])[0]).toMatchObject({
        name: "node",
        scope: "environment",
        severity: "fail",
        hint: "https://nodejs.org/en/download",
      });
      expect(r.text).toContain("✗ node");
      expect(r.text).toContain("https://nodejs.org/en/download");
      expect(r.text).toContain("1 environment finding reported without failing");
    });

    test("an environment failure beside a runtime failure still exits 1 under the opt-in", () => {
      const node = nodeCheck(oldPathNode, onBun);
      const badGit: Check = { ...git, severity: "fail", detail: "missing" };
      const r = doctorReport([node, badGit], report);
      expect(r.exitCode).toBe(1);
      expect(r.json).toMatchObject({
        outcome: "fail",
        summary: { runtimeFail: 1, environmentFail: 1 },
      });
    });

    test("all clear is distinct from reported findings", () => {
      expect(doctorOutcome([git], "report")).toMatchObject({ outcome: "pass", exitCode: 0 });
      expect(doctorReport([git], report).text).not.toContain("reported without failing");
    });

    test("the setting is read from the project config, and an invalid value fails closed", () => {
      const root = mkdtempSync(join(tmpdir(), "harn-doctor-scope-"));
      sandboxes.push(root);
      mkdirSync(join(root, ".harnery"));
      expect(doctorEnvironmentFindings(root)).toEqual({ mode: "fail", error: null });
      const write = (value: unknown) =>
        writeFileSync(
          join(root, ".harnery", "config.jsonc"),
          JSON.stringify({ doctor: { environmentFindings: value } }),
        );
      write("report");
      expect(doctorEnvironmentFindings(root)).toEqual({ mode: "report", error: null });
      write("warn");
      const invalid = doctorEnvironmentFindings(root);
      expect(invalid.mode).toBe("fail");
      expect(invalid.error).toContain('"warn"');
      const r = doctorReport([nodeCheck(oldPathNode, onBun)], invalid);
      expect(r.exitCode).toBe(1);
      expect((r.json.checks as Check[]).map((c) => c.name)).toContain("doctor settings");
    });
  });
});
