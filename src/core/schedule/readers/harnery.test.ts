import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { enrollScheduleJob } from "../enrollment.ts";
import type { ScheduleJob, ScheduleRunRecord } from "../job-types.ts";
import { resolveScheduleJob } from "../jobs.ts";
import { scheduleJobFilePath, scheduleRunDir, scheduleRunStamp } from "../paths.ts";
import { writeScheduleRunReport } from "../report.ts";
import { type ScheduleReadContext, validateScheduleReadResult } from "../types.ts";
import { harneryScheduleReader, harneryScheduleTrigger } from "./harnery.ts";

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

function ctx(env: Record<string, string> = {}): ScheduleReadContext {
  return {
    coordRoot: base,
    env,
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

function writeRun(
  jobId: string,
  startedAt: string,
  result: ScheduleRunRecord["result"],
  gather: ScheduleRunRecord["gather"] = [],
): void {
  const record: ScheduleRunRecord = {
    schema_version: 1,
    run_id: `run-${startedAt}`,
    job_id: jobId,
    scheduled_for: startedAt,
    kind: "scheduled",
    started_at: startedAt,
    finished_at: new Date(Date.parse(startedAt) + 60_000).toISOString(),
    result,
    gather,
    agent: { adapter: "codex", ok: true, status_line: "ok" },
    report_file: "report.md",
  };
  writeScheduleRunReport({
    runDir: scheduleRunDir(base, jobId, scheduleRunStamp(startedAt)),
    record,
    title: "Nightly check",
    agentText: "SECRET-REPORT-TEXT the agent wrote this",
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
    expect(JSON.stringify(result)).not.toContain("SECRET-REPORT-TEXT");
  });

  test("a job's description is carried onto its record", async () => {
    writeJobs([job({ description: "Checks the nightly backups." })]);
    const result = await harneryScheduleReader.read(ctx());
    expect(validateScheduleReadResult(result).ok).toBe(true);
    expect(result.records[0]?.description).toBe("Checks the nightly backups.");
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

  test("an agent job carries its adapter, model, effort and full prompt", async () => {
    writeJobs([
      job({ agent: { adapter: "codex", model: "m-1", effort: "medium", prompt: PROMPT } }),
    ]);
    const result = await harneryScheduleReader.read(ctx());
    expect(validateScheduleReadResult(result).ok).toBe(true);
    const detail = result.records[0]?.job;
    expect(result.records[0]?.work).toEqual({
      commands: [],
      agent: { adapter: "codex", model: "m-1", effort: "medium", prompt: PROMPT },
      redacted: false,
    });
    expect(detail).toMatchObject({
      owner: null,
      timeout_minutes: 10,
      max_launches_per_day: 2,
      zone: "UTC",
      latest_run: null,
    });
  });

  test("a commands-only job lists each argv as written and has no agent", async () => {
    writeJobs([
      job({
        owner: "agent-ops",
        gather: [
          { name: "probe", argv: ["/bin/echo", "hi there", "--flag"], finding_exit_codes: [3] },
          { name: "second", argv: ["/bin/true"] },
        ],
        agent: undefined,
      }),
    ]);
    const result = await harneryScheduleReader.read(ctx());
    expect(validateScheduleReadResult(result).ok).toBe(true);
    const detail = result.records[0]?.job;
    const work = result.records[0]?.work;
    expect(result.coverage.detail).toBeUndefined();
    expect(work?.agent).toBeNull();
    expect(detail?.owner).toBe("agent-ops");
    expect(work?.commands).toEqual([
      {
        name: "probe",
        argv: ["/bin/echo", "hi there", "--flag"],
        line: null,
        env: [],
        finding_exit_codes: [3],
      },
      { name: "second", argv: ["/bin/true"], line: null, env: [], finding_exit_codes: [] },
    ]);
  });

  test("secret-looking arguments and prompt text are masked before the record", async () => {
    writeJobs([
      job({
        gather: [{ name: "probe", argv: ["/bin/tool", "--token", "plain-secret-value"] }],
        agent: { adapter: "codex", prompt: "Use API_KEY=abc123 when calling." },
      }),
    ]);
    const result = await harneryScheduleReader.read(ctx());
    expect(validateScheduleReadResult(result).ok).toBe(true);
    const work = result.records[0]?.work;
    expect(work?.redacted).toBe(true);
    expect(work?.commands[0]?.argv).toEqual(["/bin/tool", "--token", "‹redacted›"]);
    expect(work?.agent?.prompt).toBe("Use API_KEY=‹redacted› when calling.");
    expect(JSON.stringify(result)).not.toContain("plain-secret-value");
    expect(JSON.stringify(result)).not.toContain("abc123");
  });

  test("environment variable names are listed and their values never are", async () => {
    writeJobs([
      job({
        gather: [{ name: "probe", argv: ["/bin/true"], env: ["PROBE_TOKEN"] }],
        agent: undefined,
      }),
    ]);
    const result = await harneryScheduleReader.read(ctx({ PROBE_TOKEN: "SECRET-ENV-VALUE" }));
    expect(result.records[0]?.work?.commands[0]?.env).toEqual(["PROBE_TOKEN"]);
    expect(JSON.stringify(result)).not.toContain("SECRET-ENV-VALUE");
  });

  test("enrollment states come from the enrollment check", async () => {
    const j = job();
    writeJobs([j]);
    let result = await harneryScheduleReader.read(ctx());
    expect(result.records[0]?.job?.enrollment).toEqual({
      state: "not-enrolled",
      detail: 'job "nightly-check" is not enrolled in this checkout',
      enrolled_at: null,
    });

    enroll(j);
    result = await harneryScheduleReader.read(ctx());
    expect(result.records[0]?.job?.enrollment).toEqual({
      state: "enrolled",
      detail: null,
      enrolled_at: "2026-11-20T00:00:00.000Z",
    });

    writeJobs([{ ...j, timeout_minutes: 20 }]);
    result = await harneryScheduleReader.read(ctx());
    expect(result.records[0]?.job?.enrollment.state).toBe("changed");
    expect(result.records[0]?.job?.enrollment.enrolled_at).toBe("2026-11-20T00:00:00.000Z");

    writeJobs([{ ...j, host: "other-box" }]);
    result = await harneryScheduleReader.read(ctx());
    expect(result.records[0]?.job?.enrollment.state).toBe("wrong-machine");
    expect(validateScheduleReadResult(result).ok).toBe(true);
  });

  test("the newest run gives its result, duration, exit codes and report path", async () => {
    const j = job();
    writeJobs([j]);
    writeRun(j.id, "2026-11-21T03:00:00.000Z", "ok");
    writeRun(j.id, "2026-11-22T03:00:00.000Z", "attention", [
      {
        name: "probe",
        state: "finding",
        exit_code: 3,
        duration_ms: 50,
        truncated: false,
        output_file: "gather/probe.txt",
      },
    ]);
    const result = await harneryScheduleReader.read(ctx());
    expect(validateScheduleReadResult(result).ok).toBe(true);
    expect(result.records[0]?.job?.latest_run).toEqual({
      run_id: "run-2026-11-22T03:00:00.000Z",
      kind: "scheduled",
      result: "attention",
      started_at: "2026-11-22T03:00:00.000Z",
      finished_at: "2026-11-22T03:01:00.000Z",
      duration_ms: 60_000,
      commands: [{ name: "probe", state: "finding", exit_code: 3 }],
      agent: { adapter: "codex", ok: true, status_line: "ok" },
      report_path: relative(
        base,
        join(scheduleRunDir(base, j.id, scheduleRunStamp("2026-11-22T03:00:00.000Z")), "report.md"),
      ),
    });
    expect(JSON.stringify(result)).not.toContain("SECRET-REPORT-TEXT");
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
