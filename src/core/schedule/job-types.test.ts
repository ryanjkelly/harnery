import { afterEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  hashScheduleJob,
  isScheduleChild,
  isScheduleJobEnabled,
  parseScheduleClaimFileName,
  parseScheduleJobFileText,
  parseScheduleStatusLine,
  parseScheduleTimeStamp,
  resolveScheduleRunResult,
  SCHEDULE_CHILD_ENV,
  type ScheduleJob,
  scheduleClaimFileName,
  scheduleCronErrors,
  scheduleJobExecutionFields,
  scheduleTimeStamp,
  validateScheduleClaim,
  validateScheduleCursor,
  validateScheduleEnrollment,
  validateScheduleHeartbeat,
  validateScheduleJob,
  validateScheduleJobFile,
  validateScheduleRunRecord,
  validateScheduleTimerInstall,
} from "./job-types.ts";
import {
  scheduleClaimPath,
  scheduleEnrollmentPath,
  scheduleGatherOutputPath,
  scheduleGatherOutputRelativePath,
  scheduleJobFilePath,
  scheduleObservedPath,
  scheduleRunDir,
  scheduleRunStamp,
} from "./paths.ts";

function job(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: "systems-check",
    title: "Systems check",
    host: "box-1",
    trigger: { type: "cron", expr: "0 6 * * 1-5" },
    timeout_minutes: 30,
    max_launches_per_day: 2,
    owner: "agent-A",
    gather: [
      { name: "disk", argv: ["df", "-h"], finding_exit_codes: [2, 1], env: ["PATH", "HOME"] },
      { name: "status", argv: ["git", "status", "--short"] },
    ],
    agent: { adapter: "codex", model: "m1", prompt: "Judge the evidence." },
    ...overrides,
  };
}

const RESOLVED = { executables: ["/usr/bin/df", "/usr/bin/git"], zone: "UTC" };

function errorsOf(value: unknown): string[] {
  const v = validateScheduleJob(value);
  return v.ok ? [] : v.errors;
}

describe("job file validation", () => {
  test("accepts a good file with comments", () => {
    const text = `// jobs\n{ "version": 1, /* x */ "jobs": ${JSON.stringify([
      job(),
      job({ id: "only-gather", agent: undefined, trigger: { type: "every", minutes: 5 } }),
      job({
        id: "only-agent",
        gather: undefined,
        trigger: { type: "once", at: "2027-01-01T06:00:00Z" },
      }),
    ])} }`;
    const v = parseScheduleJobFileText(text);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.jobs).toHaveLength(3);
  });

  test("rejects bad JSON, version, duplicates and unknown keys", () => {
    expect(parseScheduleJobFileText("{").ok).toBe(false);
    const bad = validateScheduleJobFile({ version: 2, jobs: [job(), job()], extra: 1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors).toContain("file.version: must be 1");
      expect(bad.errors).toContain('file.jobs[1].id: "systems-check" is used by another job');
      expect(bad.errors).toContain("file.extra: is not a known field");
    }
  });

  test("rejects each bad job shape with a clear message", () => {
    const cases: [unknown, string][] = [
      [job({ id: "Bad_Id" }), "job.id: must be kebab-case"],
      [job({ id: "a".repeat(65) }), "job.id: must be kebab-case"],
      [job({ title: "" }), "job.title: must be a non-empty string"],
      [job({ host: undefined as unknown as string }), "job.host"],
      [job({ timeout_minutes: 0 }), "job.timeout_minutes: must be a whole number from 1 to 240"],
      [job({ timeout_minutes: 241 }), "job.timeout_minutes"],
      [
        job({ max_launches_per_day: 49 }),
        "job.max_launches_per_day: must be a whole number from 1 to 48",
      ],
      [job({ trigger: { type: "every", minutes: 4 } }), "job.trigger.minutes"],
      [job({ trigger: { type: "once", at: "soon" } }), "job.trigger.at"],
      [job({ trigger: { type: "cron", expr: "0 6 * *" } }), "job.trigger.expr: must have 5 fields"],
      [job({ trigger: { type: "cron", expr: "61 6 * * *" } }), "minute field"],
      [{ ...job(), trigger: { type: "rrule", rule: "x" } }, "job.trigger.type: must be one of"],
      [{ ...job(), timeout: 5 }, "job.timeout: is not a known field"],
      [
        job({ gather: undefined, agent: undefined }),
        "job: needs gather commands, an agent, or both",
      ],
      [job({ gather: [] }), "job.gather: must not be empty"],
      [job({ enabled: "no" as unknown as boolean }), "job.enabled"],
      [job({ agent: { adapter: "codex", prompt: "" } }), "job.agent.prompt"],
      [
        { ...job(), agent: { adapter: "codex", prompt: "p", sandbox: "x" } },
        "job.agent.sandbox: is not a known field",
      ],
    ];
    for (const [value, expected] of cases) {
      const errors = errorsOf(value);
      expect(errors.some((e) => e.includes(expected))).toBe(true);
    }
  });

  test("gather commands refuse shell lines and bad fields", () => {
    const g = (gather: unknown) => errorsOf(job({ gather: gather as ScheduleJob["gather"] }));
    expect(g([{ name: "x", argv: ["df -h | grep sda"] }]).join()).toContain(
      "looks like a shell line",
    );
    expect(g([{ name: "x", argv: ["echo", "a && b"] }]).join()).toContain(
      "looks like a shell line",
    );
    expect(g([{ name: "x", argv: ["echo", "a ; b"] }]).join()).toContain("looks like a shell line");
    expect(g([{ name: "x", argv: ["echo", "a > b"] }]).join()).toContain("looks like a shell line");
    expect(g([{ name: "x", argv: ["df -h"] }]).join()).toContain("not a command line");
    expect(g([{ name: "x", argv: ["bash", "-c", "df"] }]).join()).toContain("must not run a shell");
    expect(g([{ name: "x", argv: ["/bin/sh", "-c", "df"] }]).join()).toContain(
      "must not run a shell",
    );
    expect(g([{ name: "x", argv: [] }]).join()).toContain("must be a non-empty array");
    expect(g([{ name: "x", argv: "df -h" }]).join()).toContain("must be a non-empty array");
    expect(g([{ name: "x", argv: ["df", ""] }]).join()).toContain(
      "argv[1]: must be a non-empty string",
    );
    expect(
      g([
        { name: "x", argv: ["df"] },
        { name: "x", argv: ["du"] },
      ]).join(),
    ).toContain("used twice");
    expect(g([{ name: "x", argv: ["df"], finding_exit_codes: [0] }]).join()).toContain(
      "from 1 to 255",
    );
    expect(g([{ name: "x", argv: ["df"], finding_exit_codes: [1, 1] }]).join()).toContain(
      "listed twice",
    );
    expect(g([{ name: "x", argv: ["df"], env: ["TOKEN=abc"] }]).join()).toContain("variable name");
    // Legitimate arguments that contain operators but no whitespace, or spaces but no operator.
    expect(g([{ name: "x", argv: ["grep", "-E", "a|b", "f"] }])).toEqual([]);
    expect(g([{ name: "x", argv: ["git", "log", "--format=%h %s"] }])).toEqual([]);
    expect(g([{ name: "x", argv: ["C:\\Program Files\\Tool\\tool.exe", "--check"] }])).toEqual([]);
  });

  test("cron syntax", () => {
    expect(scheduleCronErrors("*/15 0-23/2 1,15 * 0-7")).toEqual([]);
    expect(scheduleCronErrors("0 6 * * MON")).toHaveLength(1);
    expect(scheduleCronErrors("0 24 * * *")).toHaveLength(1);
    expect(scheduleCronErrors("0 6 0 * *")).toHaveLength(1);
    expect(scheduleCronErrors("5-1 * * * *")).toHaveLength(1);
    expect(scheduleCronErrors("*/0 * * * *")).toHaveLength(1);
    expect(scheduleCronErrors("")).toHaveLength(1);
  });

  test("enabled defaults to true", () => {
    expect(isScheduleJobEnabled(job())).toBe(true);
    expect(isScheduleJobEnabled(job({ enabled: false }))).toBe(false);
  });
});

describe("execution hash", () => {
  test("title, owner and enabled do not change it", () => {
    const h = hashScheduleJob(job(), RESOLVED);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(
      hashScheduleJob(job({ title: "Renamed", owner: "agent-B", enabled: false }), RESOLVED),
    ).toBe(h);
  });

  test("equivalent rewrites keep it: key order, sorted codes and names, absent lists", () => {
    const reordered: ScheduleJob = {
      agent: { prompt: "Judge the evidence.", model: "m1", adapter: "codex" },
      gather: [
        { env: ["HOME", "PATH"], finding_exit_codes: [1, 2], argv: ["df", "-h"], name: "disk" },
        { name: "status", argv: ["git", "status", "--short"], env: [], finding_exit_codes: [] },
      ],
      max_launches_per_day: 2,
      timeout_minutes: 30,
      trigger: { expr: "0 6 * * 1-5", type: "cron" },
      host: "box-1",
      title: "Systems check",
      id: "systems-check",
    };
    expect(hashScheduleJob(reordered, RESOLVED)).toBe(hashScheduleJob(job(), RESOLVED));
  });

  test("each execution field changes it", () => {
    const h = hashScheduleJob(job(), RESOLVED);
    const variants: ScheduleJob[] = [
      job({
        gather: [
          { name: "disk", argv: ["df", "-H"], finding_exit_codes: [1, 2], env: ["HOME", "PATH"] },
          { name: "status", argv: ["git", "status", "--short"] },
        ],
      }),
      job({ agent: { adapter: "codex", model: "m1", prompt: "Judge it." } }),
      job({ agent: { adapter: "codex", model: "m2", prompt: "Judge the evidence." } }),
      job({
        agent: { adapter: "codex", model: "m1", effort: "high", prompt: "Judge the evidence." },
      }),
      job({ trigger: { type: "cron", expr: "0 7 * * 1-5" } }),
      job({ host: "box-2" }),
      job({ timeout_minutes: 31 }),
      job({ max_launches_per_day: 3 }),
    ];
    for (const v of variants) expect(hashScheduleJob(v, RESOLVED)).not.toBe(h);
    expect(hashScheduleJob(job(), { ...RESOLVED, zone: "America/New_York" })).not.toBe(h);
    expect(
      hashScheduleJob(job(), { ...RESOLVED, executables: ["/opt/df", "/usr/bin/git"] }),
    ).not.toBe(h);
  });

  test("the execution fields exclude title and owner and need one executable per command", () => {
    const fields = scheduleJobExecutionFields(job(), RESOLVED);
    expect(JSON.stringify(fields)).not.toContain("Systems check");
    expect(JSON.stringify(fields)).not.toContain("agent-A");
    expect(fields.gather[0]?.executable).toBe("/usr/bin/df");
    expect(() => scheduleJobExecutionFields(job(), { executables: [], zone: "UTC" })).toThrow();
  });
});

describe("time stamps and claim file names", () => {
  test("stamps are colon-free and round-trip", () => {
    const stamp = scheduleTimeStamp("2026-11-23T06:00:00Z");
    expect(stamp).toBe("20261123T060000000Z");
    expect(stamp).toMatch(/^[0-9TZ]+$/);
    expect(parseScheduleTimeStamp(stamp)).toBe("2026-11-23T06:00:00.000Z");
    expect(scheduleTimeStamp("2026-11-23T00:30:00.5-06:00")).toBe("20261123T063000500Z");
    expect(parseScheduleTimeStamp("20261323T060000000Z")).toBeNull();
    expect(() => scheduleTimeStamp("nope")).toThrow();
  });

  test("claim file names round-trip and are Windows-safe", () => {
    const name = scheduleClaimFileName("systems-check", "2026-11-23T06:00:00.000Z");
    expect(name).toBe("systems-check_20261123T060000000Z.json");
    expect(name).not.toMatch(/[:<>"/\\|?*]/);
    expect(parseScheduleClaimFileName(name)).toEqual({
      job_id: "systems-check",
      scheduled_for: "2026-11-23T06:00:00.000Z",
    });
    expect(parseScheduleClaimFileName("systems-check_2026.json")).toBeNull();
    expect(parseScheduleClaimFileName("Bad_20261123T060000000Z.json")).toBeNull();
    expect(() => scheduleClaimFileName("../x", "2026-11-23T06:00:00Z")).toThrow();
  });
});

describe("run result truth table", () => {
  const ok = { state: "ok" as const };
  const finding = { state: "finding" as const };
  const error = { state: "error" as const };
  const agent = (isOk: boolean, status_line: "ok" | "attention" | "missing") => ({
    ok: isOk,
    status_line,
  });

  test("every branch", () => {
    expect(resolveScheduleRunResult([], null)).toBe("ok");
    expect(resolveScheduleRunResult([ok], null)).toBe("ok");
    expect(resolveScheduleRunResult([ok], agent(true, "ok"))).toBe("ok");
    expect(resolveScheduleRunResult([], agent(true, "ok"))).toBe("ok");
    expect(resolveScheduleRunResult([finding], null)).toBe("attention");
    expect(resolveScheduleRunResult([ok], agent(true, "attention"))).toBe("attention");
    expect(resolveScheduleRunResult([ok], agent(true, "missing"))).toBe("attention");
    expect(resolveScheduleRunResult([error], null)).toBe("failed");
    expect(resolveScheduleRunResult([ok], agent(false, "ok"))).toBe("failed");
    expect(resolveScheduleRunResult([finding, error], agent(true, "ok"))).toBe("failed");
  });

  test("the agent cannot clear a finding or an error", () => {
    expect(resolveScheduleRunResult([finding], agent(true, "ok"))).toBe("attention");
    expect(resolveScheduleRunResult([error], agent(true, "ok"))).toBe("failed");
  });
});

describe("status line", () => {
  test("parses the first non-empty line only", () => {
    expect(parseScheduleStatusLine("STATUS: ok\nAll fine.")).toBe("ok");
    expect(parseScheduleStatusLine("\n\n  STATUS: attention  \nDisk full")).toBe("attention");
    expect(parseScheduleStatusLine("STATUS: OK")).toBe("ok");
    expect(parseScheduleStatusLine("STATUS: Attention\r\nx")).toBe("attention");
    expect(parseScheduleStatusLine("STATUS:ok")).toBe("ok");
  });

  test("anything else is missing", () => {
    expect(parseScheduleStatusLine("")).toBe("missing");
    expect(parseScheduleStatusLine("All fine.\nSTATUS: ok")).toBe("missing");
    expect(parseScheduleStatusLine("STATUS: fine")).toBe("missing");
    expect(parseScheduleStatusLine("**STATUS: ok**")).toBe("missing");
    expect(parseScheduleStatusLine("STATUS: ok, mostly")).toBe("missing");
  });
});

describe("private record validators", () => {
  test("enrollment", () => {
    const good = {
      schema_version: 1,
      job_id: "systems-check",
      job_hash: "a".repeat(64),
      machine: "box-1",
      checkout: "/srv/repo",
      enrolled_at: "2026-11-22T10:00:00Z",
    };
    expect(validateScheduleEnrollment(good).ok).toBe(true);
    expect(validateScheduleEnrollment({ ...good, job_hash: "abc" }).ok).toBe(false);
  });

  test("claim", () => {
    const good = {
      schema_version: 1,
      job_id: "systems-check",
      scheduled_for: "2026-11-23T06:00:00.000Z",
      kind: "scheduled",
      state: "started",
      claimed_at: "2026-11-23T06:00:05Z",
      started_at: "2026-11-23T06:00:06Z",
      pid: 1234,
      run_id: "r1",
    };
    expect(validateScheduleClaim(good).ok).toBe(true);
    expect(validateScheduleClaim({ ...good, state: "running" }).ok).toBe(false);
    expect(validateScheduleClaim({ ...good, kind: "retry" }).ok).toBe(false);
  });

  test("cursor", () => {
    const good = {
      schema_version: 1,
      job_id: "systems-check",
      last_considered: "2026-11-23T06:00:00Z",
      skipped: [{ from: "2026-11-01T06:00:00Z", to: "2026-11-10T06:00:00Z", count: 10 }],
    };
    expect(validateScheduleCursor(good).ok).toBe(true);
    const range = good.skipped[0];
    expect(validateScheduleCursor({ ...good, skipped: Array(21).fill(range) }).ok).toBe(false);
  });

  test("heartbeat", () => {
    const good = {
      schema_version: 1,
      last_tick_at: "2026-11-23T06:00:00Z",
      last_tick_status: "error",
      last_tick_error: "job file did not parse",
      last_ok_at: "2026-11-23T05:55:00Z",
      source: "timer",
      timer_interval_minutes: 5,
    };
    expect(validateScheduleHeartbeat(good).ok).toBe(true);
    expect(validateScheduleHeartbeat({ ...good, source: "cron" }).ok).toBe(false);
    expect(
      validateScheduleHeartbeat({
        ...good,
        source: "activity",
        last_timer_tick_at: "2026-11-23T05:55:00Z",
      }).ok,
    ).toBe(true);
    expect(validateScheduleHeartbeat({ ...good, last_timer_tick_at: "yesterday" }).ok).toBe(false);
  });

  test("timer install", () => {
    const good = {
      schema_version: 1,
      installed_at: "2026-11-23T05:00:00Z",
      interval_minutes: 5,
      unit: "harnery-schedule-abc123.timer",
      command: ["harn", "schedule", "tick", "--source", "timer"],
    };
    expect(validateScheduleTimerInstall(good).ok).toBe(true);
    expect(validateScheduleTimerInstall({ ...good, command: [] }).ok).toBe(false);
    expect(validateScheduleTimerInstall({ ...good, command: "harn schedule tick" }).ok).toBe(false);
    expect(validateScheduleTimerInstall({ ...good, extra: 1 }).ok).toBe(false);
  });

  test("run record", () => {
    const good = {
      schema_version: 1,
      run_id: "r1",
      job_id: "systems-check",
      scheduled_for: "2026-11-23T06:00:00.000Z",
      kind: "catch-up",
      started_at: "2026-11-23T06:00:06Z",
      finished_at: "2026-11-23T06:03:00Z",
      result: "attention",
      gather: [
        {
          name: "disk",
          state: "finding",
          exit_code: 1,
          duration_ms: 40,
          truncated: false,
          output_file: "gather/disk.txt",
        },
      ],
      agent: { adapter: "codex", ok: true, status_line: "attention" },
      report_file: "report.md",
    };
    expect(validateScheduleRunRecord(good).ok).toBe(true);
    expect(validateScheduleRunRecord({ ...good, agent: null }).ok).toBe(true);
    expect(validateScheduleRunRecord({ ...good, result: "warning" }).ok).toBe(false);
  });
});

describe("paths", () => {
  test("live under the private schedule folder and refuse bad names", () => {
    const root = resolve("/repo");
    const state = join(root, ".harnery", "private", "schedule");
    expect(scheduleJobFilePath(root)).toBe(join(root, ".harnery", "schedules.jsonc"));
    expect(scheduleObservedPath(root)).toBe(join(state, "observed.jsonl"));
    expect(scheduleEnrollmentPath(root, "systems-check")).toBe(
      join(state, "enrollments", "systems-check.json"),
    );
    expect(scheduleClaimPath(root, "systems-check", "2026-11-23T06:00:00Z")).toBe(
      join(state, "claims", "systems-check", "systems-check_20261123T060000000Z.json"),
    );
    const stamp = scheduleRunStamp("2026-11-23T06:00:06Z");
    expect(stamp).not.toContain(":");
    const runDir = scheduleRunDir(root, "systems-check", stamp);
    expect(runDir).toBe(join(state, "runs", "systems-check", "20261123T060006000Z"));
    expect(scheduleGatherOutputPath(runDir, "disk")).toBe(join(runDir, "gather", "disk.txt"));
    expect(scheduleGatherOutputRelativePath("disk")).toBe("gather/disk.txt");
    expect(() => scheduleEnrollmentPath(root, "../etc")).toThrow();
    expect(() => scheduleRunDir(root, "systems-check", "..")).toThrow();
    expect(() => scheduleGatherOutputPath(runDir, "a/b")).toThrow();
  });
});

describe("schedule child marker", () => {
  const saved = process.env[SCHEDULE_CHILD_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[SCHEDULE_CHILD_ENV];
    else process.env[SCHEDULE_CHILD_ENV] = saved;
  });

  test("reads HARNERY_SCHEDULE_CHILD", () => {
    expect(SCHEDULE_CHILD_ENV).toBe("HARNERY_SCHEDULE_CHILD");
    expect(isScheduleChild({ HARNERY_SCHEDULE_CHILD: "1" })).toBe(true);
    expect(isScheduleChild({ HARNERY_SCHEDULE_CHILD: "0" })).toBe(false);
    process.env[SCHEDULE_CHILD_ENV] = "1";
    expect(isScheduleChild()).toBe(true);
    delete process.env[SCHEDULE_CHILD_ENV];
    expect(isScheduleChild()).toBe(false);
  });
});
