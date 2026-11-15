import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { StopVerdict } from "../agents/rules/stop-hook.ts";
import type { VerdictResult } from "../agents/rules/verdict.ts";
import {
  type ChildRun,
  cliEntryPath,
  healStopVerdict,
  parseCliError,
  type StopHealDependencies,
} from "./stop-heal.ts";

const block = (rule: string, reason = `${rule} reason`): VerdictResult => ({
  allow: false,
  exit_code: 2,
  rule,
  reason,
});

function blocked(...rules: string[]): StopVerdict {
  const pending = rules.map((rule) => block(rule));
  return { ...pending[0]!, pending_blocks: pending, remediation_cycle_anchor: "turn-1" };
}

const ok = (stdout: string): ChildRun => ({ status: 0, timedOut: false, stdout, stderr: "" });
const BOX = "┌─ agent-Test ─\n│ task  demo\n└─";

function deps(over: Partial<StopHealDependencies> & { runs?: ChildRun[] } = {}) {
  const calls: Array<{ args: string[]; timeoutMs: number; env: Record<string, string> }> = [];
  const runs = [...(over.runs ?? [])];
  const marks: string[] = [];
  const carried: string[] = [];
  const d: StopHealDependencies = {
    runCli: (args, timeoutMs, env) => {
      calls.push({ args, timeoutMs, env });
      return runs.shift() ?? ok(BOX);
    },
    readTask: () => "demo",
    carryTask: (task) => {
      carried.push(task);
      return true;
    },
    hasNoTaskRefusal: () => false,
    markNoTaskRefusal: () => marks.push("marked"),
    ...over,
  };
  return { d, calls, marks, carried };
}

const ctx = {
  adapter: "claude-code" as const,
  sessionId: "sess-1",
  requireGitFinalization: true,
  gitObserved: true,
};

describe("healStopVerdict", () => {
  test("timeout with no earlier Git observation keeps the original refusal", () => {
    const { d } = deps({ runs: [{ status: null, timedOut: true, stdout: "", stderr: "" }] });
    const out = healStopVerdict(blocked("stop-hook.rule_1_3"), { ...ctx, gitObserved: false }, d);
    expect(out.verdict.allow).toBe(false);
    expect(out.verdict.rule).toBe("stop-hook.rule_1_3");
    expect(out.verdict.remediation_cycle_anchor).toBe("turn-1");
    expect(out.debug.git_observed).toBe(false);
  });

  test("internal failure with no earlier Git observation keeps the original refusal", () => {
    const { d } = deps({ runs: [{ status: 1, timedOut: false, stdout: "", stderr: "boom" }] });
    const out = healStopVerdict(
      blocked("stop-hook.rule_1_3", "stop-hook.rule_2_3"),
      { ...ctx, gitObserved: false },
      d,
    );
    expect(out.verdict.allow).toBe(false);
    expect(out.verdict.rule).toBe("stop-hook.rule_1_3");
  });

  test("timeout after a successful Git observation still allows the stop", () => {
    const { d } = deps({ runs: [{ status: null, timedOut: true, stdout: "", stderr: "" }] });
    const out = healStopVerdict(blocked("stop-hook.rule_1_3"), ctx, d);
    expect(out.verdict.allow).toBe(true);
    expect(out.verdict.rule).toBe("stop-hook.v3_evidence_unavailable");
  });

  test("a project without Git finalization gets the ordinary status, never the Git check", () => {
    const { d, calls } = deps();
    const out = healStopVerdict(
      blocked("stop-hook.rule_1_3"),
      { ...ctx, requireGitFinalization: false, gitObserved: false },
      d,
    );
    expect(out.verdict.allow).toBe(true);
    expect(out.verdict.rule).toBe("stop-hook.healed_status_run");
    expect(calls[0]!.args).toEqual(["agents", "status", "--session-id", "sess-1"]);
  });

  test("a stale status on a blocked verdict reruns the check instead of only displaying", () => {
    const { d, calls } = deps();
    const out = healStopVerdict(
      { ...blocked("stop-hook.rule_2_3"), status_after_tools: true },
      ctx,
      d,
    );
    expect(out.verdict.rule).toBe("stop-hook.healed_status_run");
    expect(calls[0]!.args).toContain("--end-turn");
  });

  test("missing status: runs the closing check and shows its box", () => {
    const { d, calls } = deps();
    const out = healStopVerdict(blocked("stop-hook.rule_1_3"), ctx, d);
    expect(out.verdict.allow).toBe(true);
    expect(out.verdict.rule).toBe("stop-hook.healed_status_run");
    expect(out.userMessage).toContain(BOX);
    expect(calls[0]!.args).toEqual(["agents", "status", "--end-turn", "--session-id", "sess-1"]);
    expect(Number(calls[0]!.env.HARNERY_END_TURN_SYNC_TIMEOUT_MS)).toBeLessThan(
      calls[0]!.timeoutMs,
    );
  });

  test("status before a later tool call: reruns the check on a passing verdict", () => {
    const { d, calls } = deps();
    const out = healStopVerdict(
      { allow: true, exit_code: 0, rule: "stop-hook.pass", status_after_tools: true },
      ctx,
      d,
    );
    expect(out.verdict.rule).toBe("stop-hook.healed_status_run");
    expect(calls).toHaveLength(1);
  });

  test("plain pass is untouched and runs nothing", () => {
    const { d, calls } = deps();
    const out = healStopVerdict({ allow: true, exit_code: 0, rule: "stop-hook.pass" }, ctx, d);
    expect(out.verdict).toEqual({ allow: true, exit_code: 0, rule: "stop-hook.pass" });
    expect(out.userMessage).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("Git refusal from the closing check stays a refusal with its message", () => {
    const { d } = deps({
      runs: [
        {
          status: 1,
          timedOut: false,
          stdout: "",
          stderr: JSON.stringify({
            error: { code: "git_not_finalized", message: "Commit and push a.ts" },
          }),
        },
      ],
    });
    const out = healStopVerdict(blocked("stop-hook.rule_1_3", "stop-hook.rule_2_3"), ctx, d);
    expect(out.verdict.allow).toBe(false);
    expect(out.verdict.rule).toBe("stop-hook.git_not_finalized");
    expect(out.verdict.reason).toBe("Commit and push a.ts");
    expect(out.verdict.remediation_cycle_anchor).toBe("turn-1");
  });

  test("deadline fails open under the unavailable-evidence rule", () => {
    const { d } = deps({ runs: [{ status: null, timedOut: true, stdout: "", stderr: "" }] });
    const out = healStopVerdict(blocked("stop-hook.rule_1_3"), { ...ctx, deadlineMs: 5_000 }, d);
    expect(out.verdict.allow).toBe(true);
    expect(out.verdict.rule).toBe("stop-hook.v3_evidence_unavailable");
    expect(out.verdict.reason).toContain("5s deadline");
    expect(out.debug.heal_check).toBe("timeout");
  });

  test("internal failure fails open too", () => {
    const { d } = deps({
      runs: [
        {
          status: 1,
          timedOut: false,
          stdout: "",
          stderr: '{"error":{"code":"no_live_generation","message":"x"}}',
        },
      ],
    });
    const out = healStopVerdict(blocked("stop-hook.rule_1_3"), ctx, d);
    expect(out.verdict.allow).toBe(true);
    expect(out.verdict.rule).toBe("stop-hook.v3_evidence_unavailable");
    expect(out.debug.heal_error).toBe("no_live_generation");
  });

  test("status ran but was not pasted: shows it without the end-turn flag", () => {
    const { d, calls } = deps();
    const out = healStopVerdict(blocked("stop-hook.rule_2_3"), ctx, d);
    expect(out.verdict.rule).toBe("stop-hook.healed_status_display");
    expect(out.userMessage).toContain(BOX);
    expect(calls[0]!.args).toEqual(["agents", "status", "--session-id", "sess-1"]);
  });

  test("display failure still allows", () => {
    const { d } = deps({ runs: [{ status: 1, timedOut: false, stdout: "", stderr: "" }] });
    const out = healStopVerdict(blocked("stop-hook.rule_2_3"), ctx, d);
    expect(out.verdict.allow).toBe(true);
    expect(out.userMessage).toBeUndefined();
  });

  test("no set-task with an existing task: carries it forward", () => {
    const { d, calls, carried } = deps();
    const out = healStopVerdict(blocked("stop-hook.rule_3_3"), ctx, d);
    expect(out.verdict.rule).toBe("stop-hook.healed_task_carried");
    expect(carried).toEqual(["demo"]);
    expect(calls).toHaveLength(0);
  });

  test("never-declared task: refused once, then allowed", () => {
    const first = deps({ readTask: () => undefined });
    const out = healStopVerdict(blocked("stop-hook.rule_1_3", "stop-hook.rule_3_3"), ctx, first.d);
    expect(out.verdict.allow).toBe(false);
    expect(out.verdict.rule).toBe("stop-hook.rule_3_3");
    expect(out.verdict.reason).toBe("stop-hook.rule_3_3 reason");
    expect(first.marks).toEqual(["marked"]);
    expect(first.calls).toHaveLength(0);

    const later = deps({ readTask: () => undefined, hasNoTaskRefusal: () => true });
    const again = healStopVerdict(blocked("stop-hook.rule_3_3"), ctx, later.d);
    expect(again.verdict.allow).toBe(true);
    expect(again.verdict.rule).toBe("stop-hook.no_task_already_refused");
  });

  test("session-name and observed Git blocks are never healed", () => {
    const { d, calls } = deps();
    const out = healStopVerdict(
      blocked("stop-hook.rule_1_3", "stop-hook.git_not_finalized", "stop-hook.session_name"),
      ctx,
      d,
    );
    expect(out.verdict.allow).toBe(false);
    expect(out.verdict.rule).toBe("stop-hook.git_not_finalized");
    expect(out.verdict.reason).not.toContain("rule_1_3");
    expect(out.verdict.reason).toContain("session_name");
    expect(calls).toHaveLength(0);
  });

  test("codex and opencode pass through untouched", () => {
    for (const adapter of ["codex", "opencode"] as const) {
      const { d, calls } = deps();
      const out = healStopVerdict(blocked("stop-hook.rule_1_3"), { ...ctx, adapter }, d);
      expect(out.verdict.allow).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  test("throwing dependencies never throw out of the healer", () => {
    const out = healStopVerdict(blocked("stop-hook.rule_3_3"), ctx, {
      readTask: () => {
        throw new Error("boom");
      },
      hasNoTaskRefusal: () => {
        throw new Error("boom");
      },
      markNoTaskRefusal: () => {
        throw new Error("boom");
      },
    });
    expect(out.verdict.rule).toBe("stop-hook.rule_3_3");
  });

  test("background deferral and other pass-through rules are untouched", () => {
    const { d, calls } = deps();
    for (const rule of ["stop-hook.background_handoff_deferred", "stop-hook.pure_prose_pass"]) {
      const out = healStopVerdict({ allow: true, exit_code: 0, rule }, ctx, d);
      expect(out.verdict.rule).toBe(rule);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("helpers", () => {
  test("parseCliError reads the last error envelope", () => {
    expect(parseCliError('noise\n{"error":{"code":"git_not_finalized","message":"m"}}\n')).toEqual({
      code: "git_not_finalized",
      message: "m",
    });
    expect(parseCliError("plain text")).toBeUndefined();
  });

  test("cliEntryPath points at an existing entry", () => {
    expect(existsSync(cliEntryPath())).toBe(true);
  });
});
