import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedQaOutParent } from "../core/qa-artifacts.ts";
import {
  classifyRun,
  QA_STATUS_HEARTBEAT_STALE_MS,
  type QaStatusClassification,
  type QaStatusReport,
  type RunDirResolution,
  resolveRunDir,
} from "./qa-status.ts";

const RUN_ID = "11111111-2222-4333-8444-555555555555";
const STARTED_AT = "2026-09-01T12:00:00.000Z";
const UPDATED_AT = "2026-09-01T12:00:05.000Z";
const COMPLETED_AT = "2026-09-01T12:05:00.000Z";

/** Fixed evaluation instant: 5s after the status document's heartbeat. */
const NOW_MS = Date.parse("2026-09-01T12:00:10.000Z");

const ALIVE = { pidAlive: () => true, now: () => NOW_MS };
const DEAD = { pidAlive: () => false, now: () => NOW_MS };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qa-status-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRunDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeStatus(dir: string, overrides: Record<string, unknown> = {}): string {
  const path = join(dir, "run-status.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        schema_version: 1,
        run_id: RUN_ID,
        pid: 4242,
        state: "running",
        stage: "gates",
        started_at: STARTED_AT,
        updated_at: UPDATED_AT,
        ...overrides,
      },
      null,
      2,
    ),
  );
  return path;
}

function writeResult(
  dir: string,
  verdict: string,
  overrides: Record<string, unknown> = {},
): string {
  const path = join(dir, "page-qa-result.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        schema_version: 2,
        run: {
          run_id: RUN_ID,
          started_at: STARTED_AT,
          completed_at: COMPLETED_AT,
          revision_source: "git",
          job_digest: "abc123",
          out_dir: dir,
        },
        target: "http://localhost:9999/page",
        mode: "review",
        verdict,
        wall_time_ms: {
          plan: 100,
          gates: 200,
          interactions: 0,
          critique: 300,
          snapshot: 0,
          total: 600,
          queue: 250,
        },
        ...overrides,
      },
      null,
      2,
    ),
  );
  return path;
}

function expectReport(outcome: QaStatusClassification): QaStatusReport {
  if (!outcome.ok) throw new Error(`expected a report, got error: ${outcome.error}`);
  return outcome.report;
}

function expectRunDir(resolution: RunDirResolution): string {
  if (!resolution.ok) throw new Error(`expected a run dir, got error: ${resolution.error}`);
  return resolution.runDir;
}

describe("classifyRun: terminal results", () => {
  test("a passed result is terminal with exit 0", () => {
    const dir = makeRunDir("run-pass");
    const resultPath = writeResult(dir, "passed");
    const report = expectReport(classifyRun(dir, ALIVE));
    expect(report.state).toBe("passed");
    expect(report.terminal).toBe(true);
    expect(report.exit).toBe(0);
    expect(report.verdict).toBe("passed");
    expect(report.run_id).toBe(RUN_ID);
    expect(report.completed_at).toBe(COMPLETED_AT);
    expect(report.result_path).toBe(resultPath);
    expect(report.wall_time_ms?.total).toBe(600);
    expect(report.wall_time_ms?.queue).toBe(250);
  });

  test("a failed result is terminal with exit 2", () => {
    const dir = makeRunDir("run-fail");
    writeResult(dir, "failed");
    const report = expectReport(classifyRun(dir, ALIVE));
    expect(report.state).toBe("failed");
    expect(report.exit).toBe(2);
  });

  test("an incomplete result is terminal with exit 4", () => {
    const dir = makeRunDir("run-inc");
    writeResult(dir, "incomplete");
    const report = expectReport(classifyRun(dir, ALIVE));
    expect(report.state).toBe("incomplete");
    expect(report.exit).toBe(4);
  });

  test("the result wins over a stale status document, which still supplies the pid", () => {
    const dir = makeRunDir("run-both");
    writeStatus(dir, { state: "running" });
    writeResult(dir, "passed");
    const report = expectReport(classifyRun(dir, DEAD));
    expect(report.state).toBe("passed");
    expect(report.terminal).toBe(true);
    expect(report.pid).toBe(4242);
  });

  test("a result without a recognizable verdict is an error", () => {
    const dir = makeRunDir("run-noverdict");
    writeResult(dir, "maybe");
    const outcome = classifyRun(dir, ALIVE);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("verdict");
  });

  test("an unparseable result document is an error", () => {
    const dir = makeRunDir("run-torn");
    writeFileSync(join(dir, "page-qa-result.json"), "{not json");
    const outcome = classifyRun(dir, ALIVE);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("not valid JSON");
  });
});

describe("resolveRunDir: managed default", () => {
  test("no path resolves the newest managed QA run", () => {
    const olderParent = createManagedQaOutParent(root, "qa-run");
    const newerParent = createManagedQaOutParent(root, "qa-record");
    const older = join(olderParent, "run-older");
    const newer = join(newerParent, "run-newer");
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    writeStatus(older, { started_at: "2026-09-01T10:00:00.000Z" });
    writeStatus(newer, { started_at: "2026-09-01T11:00:00.000Z" });
    expect(expectRunDir(resolveRunDir(undefined, root))).toBe(newer);
  });

  test("no path fails clearly when the managed store has no QA output", () => {
    const resolution = resolveRunDir(undefined, root);
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.error).toContain("no managed qa-run or qa-record output");
  });
});

describe("classifyRun: live and dead states", () => {
  test("running with a live pid stays running with exit 5", () => {
    const dir = makeRunDir("run-live");
    writeStatus(dir);
    const report = expectReport(classifyRun(dir, ALIVE));
    expect(report.state).toBe("running");
    expect(report.terminal).toBe(false);
    expect(report.exit).toBe(5);
    expect(report.run_id).toBe(RUN_ID);
    expect(report.pid).toBe(4242);
    expect(report.stage).toBe("gates");
    expect(report.warnings).toEqual([]);
  });

  test("a dead pid without a result is dead with exit 4 and points at runner.log", () => {
    const dir = makeRunDir("run-dead");
    writeStatus(dir, { stage: "critique" });
    const report = expectReport(classifyRun(dir, DEAD));
    expect(report.state).toBe("dead");
    expect(report.exit).toBe(4);
    expect(report.pid).toBe(4242);
    expect(report.stage).toBe("critique");
    expect(report.heartbeat_age_ms).toBe(5000);
    expect(report.log_path).toBe(join(dir, "runner.log"));
  });

  test("a queued status passes through with its queue block", () => {
    const dir = makeRunDir("run-queued");
    writeStatus(dir, {
      state: "queued",
      stage: null,
      queue: { resource: "browser-qa", waiting_since: STARTED_AT },
    });
    const report = expectReport(classifyRun(dir, ALIVE));
    expect(report.state).toBe("queued");
    expect(report.exit).toBe(5);
    expect(report.queue).toEqual({ resource: "browser-qa", waiting_since: STARTED_AT });
  });

  test("a launching status passes through", () => {
    const dir = makeRunDir("run-launch");
    writeStatus(dir, { state: "launching", stage: null });
    const report = expectReport(classifyRun(dir, ALIVE));
    expect(report.state).toBe("launching");
    expect(report.exit).toBe(5);
  });

  test("heartbeat age is now minus updated_at", () => {
    const dir = makeRunDir("run-hb");
    writeStatus(dir); // updated_at is 5s before NOW_MS
    const report = expectReport(classifyRun(dir, ALIVE));
    expect(report.heartbeat_age_ms).toBe(5000);
    expect(report.warnings).toEqual([]);
  });

  test("a stale heartbeat warns but stays running while the pid is alive", () => {
    const dir = makeRunDir("run-stale");
    const staleMs = QA_STATUS_HEARTBEAT_STALE_MS + 80_000;
    writeStatus(dir, { updated_at: new Date(NOW_MS - staleMs).toISOString() });
    const report = expectReport(classifyRun(dir, ALIVE));
    expect(report.state).toBe("running");
    expect(report.exit).toBe(5);
    expect(report.heartbeat_age_ms).toBe(staleMs);
    expect(report.warnings.some((warning) => warning.includes("heartbeat stale"))).toBe(true);
  });

  test("a pid of zero is never treated as alive", () => {
    const dir = makeRunDir("run-pid0");
    writeStatus(dir, { pid: 0 });
    const report = expectReport(classifyRun(dir, ALIVE));
    expect(report.state).toBe("dead");
    expect(report.pid).toBeNull();
  });

  test("an unrecognized status state is an error", () => {
    const dir = makeRunDir("run-oddstate");
    writeStatus(dir, { state: "meandering" });
    const outcome = classifyRun(dir, ALIVE);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("unrecognized state");
  });

  test("a directory with neither document is an error", () => {
    const dir = makeRunDir("run-empty");
    const outcome = classifyRun(dir, ALIVE);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("page-qa-result.json");
      expect(outcome.error).toContain("run-status.json");
    }
  });
});

describe("resolveRunDir", () => {
  test("a result file path resolves to its directory", () => {
    const dir = makeRunDir("run-file");
    const resultPath = writeResult(dir, "passed");
    expect(expectRunDir(resolveRunDir(resultPath))).toBe(dir);
  });

  test("a run directory carrying a status document resolves to itself", () => {
    const dir = makeRunDir("run-self");
    writeStatus(dir);
    expect(expectRunDir(resolveRunDir(dir))).toBe(dir);
  });

  test("a parent directory picks the run-* child with the newest started_at", () => {
    const older = makeRunDir("run-aaa");
    writeStatus(older, { started_at: "2026-09-01T10:00:00.000Z" });
    const newest = makeRunDir("run-bbb");
    writeStatus(newest, { started_at: "2026-09-01T13:00:00.000Z" });
    const middle = makeRunDir("run-ccc");
    // No status document: started_at comes from the result's identity block.
    writeResult(middle, "passed", {
      run: {
        run_id: RUN_ID,
        started_at: "2026-09-01T12:30:00.000Z",
        completed_at: COMPLETED_AT,
        revision_source: "git",
        job_digest: "abc123",
        out_dir: middle,
      },
    });
    expect(expectRunDir(resolveRunDir(root))).toBe(newest);
  });

  test("a parent with no dated children follows the latest.json pointer", () => {
    makeRunDir("run-bare"); // run-* child with neither document
    writeFileSync(
      join(root, "latest.json"),
      JSON.stringify({
        schema_version: 1,
        run_id: RUN_ID,
        dir: "run-pointed",
        result: join("run-pointed", "page-qa-result.json"),
      }),
    );
    expect(expectRunDir(resolveRunDir(root))).toBe(join(root, "run-pointed"));
  });

  test("a missing path is an error", () => {
    const resolution = resolveRunDir(join(root, "no-such-place"));
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.error).toContain("cannot access");
  });

  test("a directory with no run evidence at all names what it looked for", () => {
    const empty = makeRunDir("plain-dir");
    const resolution = resolveRunDir(empty);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toContain("run-status.json");
      expect(resolution.error).toContain("page-qa-result.json");
      expect(resolution.error).toContain("latest.json");
    }
  });
});
