import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { type ScheduleRunRecord, validateScheduleRunRecord } from "./job-types.ts";
import { scheduleRunDir, scheduleRunStamp, scheduleRunsDir } from "./paths.ts";
import {
  latestScheduleRun,
  listScheduleRuns,
  pruneScheduleRuns,
  renderScheduleRunReport,
  writeScheduleRunReport,
} from "./report.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "schedule-report-"));
});

afterEach(() => removeDir(root));

function record(startedAt: string, overrides: Partial<ScheduleRunRecord> = {}): ScheduleRunRecord {
  return {
    schema_version: 1,
    run_id: `run-${startedAt}`,
    job_id: "nightly-check",
    scheduled_for: "2026-01-01T06:00:00.000Z",
    kind: "scheduled",
    started_at: startedAt,
    finished_at: startedAt,
    result: "attention",
    gather: [
      {
        name: "disk",
        state: "finding",
        exit_code: 1,
        duration_ms: 12,
        truncated: false,
        output_file: "gather/disk.txt",
      },
      {
        name: "net",
        state: "error",
        exit_code: null,
        duration_ms: 3,
        truncated: false,
        error: "could not start: ENOENT",
        output_file: "gather/net.txt",
      },
    ],
    agent: { adapter: "codex", ok: false, status_line: "missing", error: "codex timed out" },
    report_file: "report.md",
    ...overrides,
  };
}

function writeRun(startedAt: string, overrides: Partial<ScheduleRunRecord> = {}): string {
  const dir = scheduleRunDir(root, "nightly-check", scheduleRunStamp(startedAt));
  writeScheduleRunReport({
    runDir: dir,
    record: record(startedAt, overrides),
    title: "Nightly check",
    agentText: "STATUS: attention\n\n| a | b |\nDisk 95%.",
  });
  return dir;
}

describe("writeScheduleRunReport", () => {
  test("writes a valid run.json and a readable report.md, privately", () => {
    const dir = writeRun("2026-01-01T06:00:01.000Z");
    const json = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as unknown;
    expect(validateScheduleRunRecord(json).ok).toBe(true);
    const report = readFileSync(join(dir, "report.md"), "utf8");
    const lines = report.split("\n");
    expect(lines[0]).toBe("# Nightly check: attention");
    expect(lines[2]).toBe(
      "Due 2026-01-01T06:00:00.000Z; ran 2026-01-01T06:00:01.000Z to 2026-01-01T06:00:01.000Z (scheduled run, id run-2026-01-01T06:00:01.000Z).",
    );
    expect(report).toContain("| disk | finding | 1 | 12 ms | gather/disk.txt |");
    expect(report).toContain("| net | error | none | 3 ms | gather/net.txt |");
    expect(report).toContain("### Final message\n\nSTATUS: attention\n\n| a | b |\nDisk 95%.");
    expect(report).toContain(
      "## Errors\n\n- net: could not start: ENOENT\n- agent: codex timed out",
    );
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "run.json")).mode & 0o077).toBe(0);
      expect(statSync(join(dir, "report.md")).mode & 0o077).toBe(0);
    }
    expect(readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  test("a gather-only run says no agent ran", () => {
    const text = renderScheduleRunReport(
      record("2026-01-01T06:00:01.000Z", { agent: null, result: "ok", gather: [] }),
      "Nightly check",
      null,
    );
    expect(text).toContain("No gather commands.");
    expect(text).toContain("No agent ran.");
    expect(text).not.toContain("## Errors");
  });

  test("refuses an invalid record", () => {
    expect(() =>
      writeScheduleRunReport({
        runDir: join(root, "x"),
        record: { ...record("2026-01-01T06:00:01.000Z"), extra: 1 } as ScheduleRunRecord,
        title: "t",
      }),
    ).toThrow("invalid run record");
  });
});

describe("listing and pruning", () => {
  const instant = (i: number) =>
    new Date(Date.parse("2026-01-01T06:00:00.000Z") + i * 1000).toISOString();

  test("lists newest first, skipping missing and invalid records", () => {
    writeRun(instant(1));
    writeRun(instant(2));
    writeRun(instant(3));
    mkdirSync(scheduleRunDir(root, "nightly-check", scheduleRunStamp(instant(4))), {
      recursive: true,
    });
    const bad = scheduleRunDir(root, "nightly-check", scheduleRunStamp(instant(5)));
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "run.json"), "{not json");
    const runs = listScheduleRuns(root, "nightly-check");
    expect(runs.map((r) => r.started_at)).toEqual([instant(3), instant(2), instant(1)]);
    expect(latestScheduleRun(root, "nightly-check")?.started_at).toBe(instant(3));
    expect(latestScheduleRun(root, "other-job")).toBeNull();
  });

  test("keeps the newest N and touches nothing else", () => {
    for (let i = 1; i <= 6; i++) writeRun(instant(i));
    const runs = scheduleRunsDir(root, "nightly-check");
    mkdirSync(join(runs, "keep-me"));
    writeFileSync(join(runs, "20200101T000000000Z"), "a file, not a folder");
    const outside = join(root, "outside");
    mkdirSync(join(outside, "precious"), { recursive: true });
    if (process.platform !== "win32") symlinkSync(outside, join(runs, "20000101T000000000Z"));
    const removed = pruneScheduleRuns(root, "nightly-check", 3);
    expect(removed).toEqual([1, 2, 3].map((i) => scheduleRunStamp(instant(i))));
    const left = readdirSync(runs).sort();
    expect(left).toContain("keep-me");
    expect(left).toContain("20200101T000000000Z");
    expect(left.filter((n) => /^2026/.test(n))).toEqual(
      [4, 5, 6].map((i) => scheduleRunStamp(instant(i))),
    );
    expect(existsSync(join(outside, "precious"))).toBe(true);
    if (process.platform !== "win32") expect(left).toContain("20000101T000000000Z");
  });

  test("a missing runs folder prunes nothing", () => {
    expect(pruneScheduleRuns(root, "nightly-check")).toEqual([]);
    expect(listScheduleRuns(root, "nightly-check")).toEqual([]);
  });

  test("refuses a job id that could leave the folder", () => {
    expect(() => pruneScheduleRuns(root, "../escape")).toThrow();
  });
});
