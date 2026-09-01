// Regression tests for losing the bridge to a qa-run mid-flight: the runner
// still leaves a readable record for every stage a disconnect can hit, and
// qa-status can mechanically tell a dead child from a live one without
// guessing. Nothing here spawns a browser — the disconnect is simulated
// through the injectable exec, which returns the spawn-failure envelope a
// severed child produces (exitCode null plus an error string).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QaManifest } from "../lib/browser/qa-plan.ts";
import {
  QA_RUN_RESULT_FILENAME,
  QA_RUN_STATUS_FILENAME,
  type QaRunExec,
  runQaMatrix,
} from "../lib/browser/qa-run.ts";
import {
  QA_RUN_JOB_SCHEMA_VERSION,
  QA_RUN_STATUS_SCHEMA_VERSION,
  type QaRunJob,
  type QaRunStatusDocument,
} from "../lib/browser/qa-run-contracts.ts";
import { classifyRun, QA_STATUS_HEARTBEAT_STALE_MS, resolveRunDir } from "./qa-status.ts";

const BROWSE_ARGV = ["node", "/cli/harn.ts", "browse"];

/** What a child looks like when the bridge carrying it goes away: no exit
 * code, only a failure description. */
const BRIDGE_LOST = "killed by SIGHUP (host bridge disconnected)";

function outParentDir(): string {
  return mkdtempSync(join(tmpdir(), "qa-disconnect-test-"));
}

function argvValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function manifest(overrides: Partial<QaManifest> = {}): QaManifest {
  return {
    schema_version: 1,
    change_class: "large-structural",
    classification_reasons: ["test"],
    baseline_source: "none",
    scopes: [],
    contexts: [{ viewport: "desktop", theme: "light", state: "default" }],
    checks: { deterministic: ["overflow"], interaction: [], visual: "none" },
    concurrency: { headless: 2, metered: 1 },
    reuse: { mode: "none", cache: false },
    predicted: { tiles_ceiling: 4, model_calls_ceiling: 12 },
    ...overrides,
  };
}

function job(overrides: Partial<QaRunJob> = {}): QaRunJob {
  return {
    schema_version: QA_RUN_JOB_SCHEMA_VERSION,
    target: "http://localhost:4276/page",
    mode: "review",
    ...overrides,
  };
}

type DisconnectStage = "plan" | "gates" | "critique" | "none";

/** Fake executor that behaves normally until the named stage, where every
 * child dies the way a severed bridge kills it. */
function makeDisconnectingExec(
  stage: DisconnectStage,
  planManifest: QaManifest,
): { exec: QaRunExec; calls: string[][] } {
  const calls: string[][] = [];
  const lost = { exitCode: null, stdout: "", stderr: "", error: BRIDGE_LOST } as const;
  const exec: QaRunExec = async (argv: string[]) => {
    calls.push(argv);
    if (argv.includes("--qa-plan")) {
      if (stage === "plan") return { ...lost };
      return {
        exitCode: 0,
        stdout: JSON.stringify({ qaPlan: { manifest: planManifest } }),
        stderr: "",
      };
    }
    const outPrefix = argvValue(argv, "--out");
    if (outPrefix === undefined) return { exitCode: 1, stdout: "", stderr: "", error: "no --out" };
    if (argv.includes("--check-critique")) {
      if (stage === "critique") return { ...lost };
      writeFileSync(
        `${outPrefix}.json`,
        JSON.stringify({
          critique: { rule: "critique", tiles: 3, provider: true, findings: [], outcome: "pass" },
        }),
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (stage === "gates") return { ...lost };
    writeFileSync(`${outPrefix}.json`, JSON.stringify({}));
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const TRUE_ARGV: string[] = existsSync("/bin/true") ? ["/bin/true"] : [process.execPath, "-e", ""];

/** A PID that is definitely not running: spawn a trivial child synchronously
 * and reuse its PID once the call has returned and reaped it. */
function deadPid(): number {
  const [command, ...args] = TRUE_ARGV as [string, ...string[]];
  const child = spawnSync(command, args);
  if (typeof child.pid !== "number" || child.pid <= 0) {
    throw new Error("could not obtain an exited child's PID");
  }
  return child.pid;
}

function writeStatusDocument(runDir: string, document: QaRunStatusDocument): void {
  writeFileSync(join(runDir, QA_RUN_STATUS_FILENAME), `${JSON.stringify(document, null, 2)}\n`);
}

function readStatusDocument(runDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(runDir, QA_RUN_STATUS_FILENAME), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("qa-run bridge disconnect", () => {
  test("a planner killed by a lost bridge blocks at plan and still writes a readable status document", async () => {
    const parent = outParentDir();
    const { exec, calls } = makeDisconnectingExec("plan", manifest());
    const result = await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
      runId: "plan-disconnect",
    });

    expect(result.verdict).toBe("incomplete");
    expect(result.last_completed_stage).toBeNull();
    const blocker = result.blockers.find((entry) => entry.stage === "plan");
    expect(blocker?.reason).toContain("planner command did not complete");
    expect(blocker?.reason).toContain(BRIDGE_LOST);
    // Nothing beyond the planner was attempted: an untrusted plan cannot gate.
    expect(calls).toHaveLength(1);

    const runDir = join(parent, "run-plan-disconnect");
    expect(result.run.out_dir).toBe(runDir);
    expect(existsSync(join(runDir, QA_RUN_RESULT_FILENAME))).toBe(true);
    const status = readStatusDocument(runDir);
    expect(status.state).toBe("completed");
    expect(status.verdict).toBe("incomplete");
    expect(status.stage).toBeNull();
  });

  test("a gate killed by a lost bridge blocks at gates and records the host pressure that stage began under", async () => {
    const parent = outParentDir();
    const { exec } = makeDisconnectingExec("gates", manifest());
    const result = await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
      runId: "gates-disconnect",
    });

    expect(result.verdict).toBe("incomplete");
    const blocker = result.blockers.find((entry) => entry.stage === "gates");
    expect(blocker?.context_id).toBe("desktop-light-default");
    expect(blocker?.reason).toContain("gate command did not complete");
    expect(blocker?.reason).toContain(BRIDGE_LOST);
    const outcome = result.commands.find((entry) => entry.check_id.startsWith("manifest:"));
    expect(outcome?.outcome).toBe("unknown");
    expect(outcome?.exit_code).toBeNull();

    const sample = result.host.stages?.gates;
    expect(sample).toBeDefined();
    const capturedAt = sample?.captured_at ?? "";
    expect(new Date(capturedAt).toISOString()).toBe(capturedAt);
    expect(Number.isFinite(sample?.loadavg_1m ?? Number.NaN)).toBe(true);

    const status = readStatusDocument(join(parent, "run-gates-disconnect"));
    expect(status.state).toBe("completed");
    expect(status.verdict).toBe("incomplete");
  });

  test("a critique killed by a lost bridge blocks at critique and records the host pressure that stage began under", async () => {
    const parent = outParentDir();
    const { exec } = makeDisconnectingExec(
      "critique",
      manifest({ checks: { deterministic: ["overflow"], interaction: [], visual: "full-page" } }),
    );
    const result = await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
      runId: "critique-disconnect",
    });

    expect(result.verdict).toBe("incomplete");
    const blocker = result.blockers.find((entry) => entry.stage === "critique");
    expect(blocker?.context_id).toBe("desktop-light-default");
    expect(blocker?.reason).toContain("critique command did not complete");
    expect(blocker?.reason).toContain(BRIDGE_LOST);
    expect(result.critique[0]?.outcome).toBe("unknown");
    // The gates that ran before the disconnect keep their proven outcomes.
    expect(result.last_completed_stage).toBe("interactions");

    const sample = result.host.stages?.critique;
    expect(sample).toBeDefined();
    const capturedAt = sample?.captured_at ?? "";
    expect(new Date(capturedAt).toISOString()).toBe(capturedAt);

    const status = readStatusDocument(join(parent, "run-critique-disconnect"));
    expect(status.state).toBe("completed");
    expect(status.verdict).toBe("incomplete");
  });
});

describe("qa-status classification after a disconnect", () => {
  test("a running status document whose PID has exited classifies dead, not running", () => {
    const parent = outParentDir();
    const runDir = join(parent, "run-orphaned");
    mkdirSync(runDir, { recursive: true });
    const pid = deadPid();
    writeStatusDocument(runDir, {
      schema_version: QA_RUN_STATUS_SCHEMA_VERSION,
      run_id: "orphaned",
      pid,
      state: "running",
      stage: "gates",
      started_at: "2026-09-01T12:00:00.000Z",
      updated_at: "2026-09-01T12:00:30.000Z",
    });
    expect(existsSync(join(runDir, QA_RUN_RESULT_FILENAME))).toBe(false);

    // The parent resolves to the only run directory carrying run state.
    const resolved = resolveRunDir(parent);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.runDir).toBe(runDir);

    const outcome = classifyRun(runDir);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.state).toBe("dead");
    expect(outcome.report.terminal).toBe(false);
    expect(outcome.report.exit).toBe(4);
    expect(outcome.report.pid).toBe(pid);
    expect(outcome.report.stage).toBe("gates");
    expect(outcome.report.run_id).toBe("orphaned");
  });

  test("the same orphaned run classifies running while its PID is still alive", () => {
    const parent = outParentDir();
    const runDir = join(parent, "run-continuing");
    mkdirSync(runDir, { recursive: true });
    writeStatusDocument(runDir, {
      schema_version: QA_RUN_STATUS_SCHEMA_VERSION,
      run_id: "continuing",
      pid: deadPid(),
      state: "running",
      stage: "critique",
      started_at: "2026-09-01T12:00:00.000Z",
      updated_at: "2026-09-01T12:00:30.000Z",
    });

    const outcome = classifyRun(runDir, {
      pidAlive: () => true,
      now: () => Date.parse("2026-09-01T12:00:45.000Z"),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The child outlived the bridge: still running, exit 5, nothing invented.
    expect(outcome.report.state).toBe("running");
    expect(outcome.report.terminal).toBe(false);
    expect(outcome.report.exit).toBe(5);
    expect(outcome.report.stage).toBe("critique");
    expect(outcome.report.heartbeat_age_ms).toBe(15_000);
    expect(outcome.report.warnings).toEqual([]);
  });

  test("a completed result outranks a status document still claiming a run under a dead PID", async () => {
    const parent = outParentDir();
    const { exec } = makeDisconnectingExec("none", manifest());
    const result = await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
      runId: "reconnected",
    });
    expect(result.verdict).toBe("passed");

    // Reconnect shape: the finished run's status document is rewound to the
    // last thing the disconnected client saw.
    const runDir = join(parent, "run-reconnected");
    const pid = deadPid();
    writeStatusDocument(runDir, {
      schema_version: QA_RUN_STATUS_SCHEMA_VERSION,
      run_id: "reconnected",
      pid,
      state: "running",
      stage: "gates",
      started_at: result.run.started_at,
      updated_at: result.run.started_at,
    });

    const outcome = classifyRun(runDir);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.terminal).toBe(true);
    expect(outcome.report.state).toBe("passed");
    expect(outcome.report.verdict).toBe("passed");
    expect(outcome.report.exit).toBe(0);
    expect(outcome.report.run_id).toBe("reconnected");
    expect(outcome.report.completed_at).toBe(result.run.completed_at);
    expect(outcome.report.result_path).toBe(join(runDir, QA_RUN_RESULT_FILENAME));
  });

  test("a live run whose heartbeat has gone stale stays running and says the heartbeat is old", () => {
    const parent = outParentDir();
    const runDir = join(parent, "run-stale-heartbeat");
    mkdirSync(runDir, { recursive: true });
    const nowMs = Date.parse("2026-09-01T12:30:00.000Z");
    const staleMs = QA_STATUS_HEARTBEAT_STALE_MS * 5;
    writeStatusDocument(runDir, {
      schema_version: QA_RUN_STATUS_SCHEMA_VERSION,
      run_id: "stale-heartbeat",
      pid: deadPid(),
      state: "running",
      stage: "critique",
      started_at: new Date(nowMs - staleMs - 60_000).toISOString(),
      updated_at: new Date(nowMs - staleMs).toISOString(),
    });

    const outcome = classifyRun(runDir, { pidAlive: () => true, now: () => nowMs });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.state).toBe("running");
    expect(outcome.report.exit).toBe(5);
    expect(outcome.report.heartbeat_age_ms).toBe(staleMs);
    expect(outcome.report.warnings.some((entry) => entry.includes("heartbeat stale"))).toBe(true);
  });
});
