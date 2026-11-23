import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrollScheduleJob } from "../enrollment.ts";
import type { ScheduleJob, ScheduleRunRecord } from "../job-types.ts";
import { resolveScheduleJob } from "../jobs.ts";
import { scheduleJobFilePath, scheduleRunDir, scheduleRunStamp } from "../paths.ts";
import { writeScheduleRunReport } from "../report.ts";
import { type ScheduleReadContext, validateScheduleReadResult } from "../types.ts";
import { harneryJobStatus, harneryScheduleReader, harneryScheduleTrigger } from "./harnery.ts";

const MACHINE = "box";
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const PROMPT = "SECRET-PROMPT-TEXT read the status";
let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "harnery-schedule-reader-")));
  spawnSync("git", ["init", "-q"], { cwd: base, windowsHide: true });
  mkdirSync(join(base, ".harnery"), { recursive: true });
  writeFileSync(join(base, ".harnery", "config.jsonc"), JSON.stringify({ timeZone: "UTC" }));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function ctx(): ScheduleReadContext {
  return {
    coordRoot: base,
    env: {},
    homeDir: join(base, "home"),
    platform: "linux",
    machine: MACHINE,
    now: () => NOW,
    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    tmpDir: join(base, "tmp"),
  };
}

const job = (over: Partial<ScheduleJob> = {}): ScheduleJob => ({
  id: "nightly-check",
  title: "Nightly check",
  host: MACHINE,
  trigger: { type: "cron", expr: "0 3 * * *" },
  timeout_minutes: 10,
  max_launches_per_day: 2,
  agent: { adapter: "codex", prompt: PROMPT },
  ...over,
});

function writeJobs(jobs: ScheduleJob[]): void {
  writeFileSync(scheduleJobFilePath(base), JSON.stringify({ version: 1, jobs }));
}

function enroll(j: ScheduleJob, at = "2026-11-20T00:00:00.000Z"): void {
  const resolved = resolveScheduleJob(j, { coordRoot: base, env: {} });
  const result = enrollScheduleJob({
    coordRoot: base,
    job: j,
    resolved,
    machine: MACHINE,
    now: new Date(at),
    registryDir: join(base, "registry"),
  });
  expect(result.ok).toBe(true);
}

function writeRun(jobId: string, startedAt: string, result: ScheduleRunRecord["result"]): void {
  const record: ScheduleRunRecord = {
    schema_version: 1,
    run_id: `run-${startedAt}`,
    job_id: jobId,
    scheduled_for: startedAt,
    kind: "scheduled",
    started_at: startedAt,
    finished_at: new Date(Date.parse(startedAt) + 60_000).toISOString(),
    result,
    gather: [],
    agent: { adapter: "codex", ok: true, status_line: "ok" },
    report_file: "report.md",
  };
  writeScheduleRunReport({
    runDir: scheduleRunDir(base, jobId, scheduleRunStamp(startedAt)),
    record,
    title: "Nightly check",
    agentText: PROMPT,
  });
}

describe("harneryScheduleReader", () => {
  test("a missing job file is an empty current result", async () => {
    const result = await harneryScheduleReader.read(ctx());
    expect(result.coverage.state).toBe("current");
    expect(result.coverage.source).toBe("harnery");
    expect(result.records).toEqual([]);
  });

  test("an invalid job file is unreadable with the first error", async () => {
    writeFileSync(scheduleJobFilePath(base), JSON.stringify({ version: 1, jobs: [{ id: "X" }] }));
    const result = await harneryScheduleReader.read(ctx());
    expect(result.coverage.state).toBe("unreadable");
    expect(result.coverage.detail).toContain("jobs[0]");
    expect(result.records).toEqual([]);
  });

  test("an enrolled job has its next run and newest last run", async () => {
    const j = job();
    writeJobs([j]);
    enroll(j);
    writeRun(j.id, "2026-11-21T03:00:00.000Z", "failed");
    writeRun(j.id, "2026-11-22T03:00:00.000Z", "attention");
    const result = await harneryScheduleReader.read(ctx());
    expect(validateScheduleReadResult(result).ok).toBe(true);
    expect(result.coverage.state).toBe("current");
    const [record] = result.records;
    expect(record).toMatchObject({
      source: "harnery",
      account: MACHINE,
      id: "nightly-check",
      title: "Nightly check",
      runs_on: { host: MACHINE },
      enabled: true,
      created_by: null,
    });
    expect(record?.trigger).toMatchObject({ kind: "cron", expr: "0 3 * * *" });
    expect(record?.trigger.raw).toBe(JSON.stringify(j.trigger));
    expect(record?.next_run_at).toBe("2026-11-23T03:00:00.000Z");
    expect(record?.last_run).toEqual({ at: "2026-11-22T03:01:00.000Z", status: "attention" });
    expect(JSON.stringify(result)).not.toContain("SECRET-PROMPT-TEXT");
  });

  test("an unenrolled job is listed as not enabled with no next run", async () => {
    writeJobs([job()]);
    const result = await harneryScheduleReader.read(ctx());
    expect(result.records[0]).toMatchObject({ enabled: false, next_run_at: null, last_run: null });
  });

  test("a disabled job is not enabled even when enrolled", async () => {
    const j = job({ enabled: false });
    writeJobs([j]);
    enroll(j);
    const result = await harneryScheduleReader.read(ctx());
    expect(result.records[0]).toMatchObject({ enabled: false, next_run_at: null });
  });

  test("a job for another machine is listed on that host", async () => {
    writeJobs([job({ host: "other-box" })]);
    const result = await harneryScheduleReader.read(ctx());
    expect(result.records[0]?.runs_on).toEqual({ host: "other-box" });
    expect(result.records[0]?.enabled).toBeNull();
    expect(result.records[0]?.next_run_at).toBeNull();
  });

  test("gather arguments never reach a record", async () => {
    writeJobs([
      job({
        gather: [{ name: "probe", argv: ["/bin/sh", "SECRET-GATHER-ARG"] }],
        agent: undefined,
      }),
    ]);
    const result = await harneryScheduleReader.read(ctx());
    expect(result.records).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("SECRET-GATHER-ARG");
  });

  test("job status names the enrollment and the newest report", () => {
    const j = job();
    writeJobs([j]);
    enroll(j);
    writeRun(j.id, "2026-11-22T03:00:00.000Z", "ok");
    const status = harneryJobStatus(ctx(), j);
    expect(status.enrollment.state).toBe("enrolled");
    expect(status.latestRun?.result).toBe("ok");
    expect(status.latestReportPath).toBe(
      join(scheduleRunDir(base, j.id, scheduleRunStamp("2026-11-22T03:00:00.000Z")), "report.md"),
    );
  });
});

describe("harneryScheduleTrigger", () => {
  test("maps every job trigger with its raw text", () => {
    expect(harneryScheduleTrigger({ type: "every", minutes: 15 }, "UTC")).toEqual({
      kind: "interval",
      everyMs: 900_000,
      raw: '{"type":"every","minutes":15}',
    });
    expect(harneryScheduleTrigger({ type: "once", at: "2026-12-01T00:00:00Z" }, "UTC")).toEqual({
      kind: "once",
      at: "2026-12-01T00:00:00Z",
      raw: '{"type":"once","at":"2026-12-01T00:00:00Z"}',
    });
  });
});
