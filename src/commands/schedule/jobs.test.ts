import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { EmitContext } from "../../commander.ts";
import { readScheduleEnrollment } from "../../core/schedule/enrollment.ts";
import type { ScheduleJob, ScheduleRunRecord } from "../../core/schedule/job-types.ts";
import { loadScheduleJobFile, writeScheduleJobFile } from "../../core/schedule/jobs.ts";
import { scheduleClaimsDir, scheduleRunDir, scheduleRunStamp } from "../../core/schedule/paths.ts";
import type {
  ManualScheduleRunOptions,
  ManualScheduleRunResult,
} from "../../core/schedule/tick.ts";
import {
  registerScheduleJobsCommands,
  SCHEDULE_JOBS_EXIT,
  type ScheduleJobsCommandDeps,
} from "./jobs.ts";

const MACHINE = "test-box";
const SECRET_PROMPT = "Check the status.\nSECRET-SECOND-LINE do not print me";

let root: string;
let registryDir: string;
let exe: string;

interface Captured {
  data: unknown[];
  text: string[];
  errors: { code?: string; message?: string; hint?: string }[];
  exitCode: number;
  all(): string;
}

function fakeEmit(): EmitContext & { captured: Captured } {
  const captured: Captured = {
    data: [],
    text: [],
    errors: [],
    exitCode: 0,
    all() {
      return JSON.stringify([this.data, this.text, this.errors]);
    },
  };
  return {
    captured,
    config() {},
    data(p) {
      captured.data.push(p);
    },
    rows(r) {
      captured.data.push(r);
    },
    text(s) {
      captured.text.push(s);
    },
    file() {},
    error(e) {
      captured.errors.push(e as Captured["errors"][number]);
      captured.exitCode = 1;
    },
    log() {},
    setExitCode(n) {
      captured.exitCode = n;
    },
  };
}

async function cli(
  args: string[],
  extra: Partial<ScheduleJobsCommandDeps> = {},
): Promise<Captured> {
  const emit = fakeEmit();
  const schedule = new Command("schedule").exitOverride();
  schedule.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerScheduleJobsCommands(schedule, {
    emit,
    coordRoot: () => root,
    machine: () => MACHINE,
    now: () => new Date("2026-11-22T12:00:00.000Z"),
    env: { PATH: "" },
    pathLookup: (name) => (name === "checker" ? exe : null),
    registryDir,
    runManually: async () => ({ ok: false, reason: "no runner in this test" }),
    ...extra,
  });
  await schedule.parseAsync(args, { from: "user" });
  return emit.captured;
}

function jobs(): ScheduleJob[] {
  const load = loadScheduleJobFile(root);
  if (!load.ok) throw new Error(`job file not ok: ${load.reason}`);
  return load.file.jobs;
}

function job(id: string): ScheduleJob {
  const j = jobs().find((x) => x.id === id);
  if (!j) throw new Error(`no job ${id}`);
  return j;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "harnery-schedule-cmd-")));
  mkdirSync(join(root, ".harnery"), { recursive: true });
  writeFileSync(join(root, ".harnery", ".gitignore"), "*\n");
  registryDir = join(root, "registry");
  exe = join(root, "bin", "checker");
  mkdirSync(join(root, "bin"));
  writeFileSync(exe, "#!/bin/sh\nexit 0\n");
  chmodSync(exe, 0o755);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const AGENT = ["--adapter", "codex", "--model", "gpt-test", "--prompt", SECRET_PROMPT];

describe("add", () => {
  test("adds a job with each trigger form and does not enroll it", async () => {
    let c = await cli(["add", "a-once", "--once", "2026-12-01T09:00:00Z", ...AGENT]);
    expect(c.exitCode).toBe(0);
    c = await cli(["add", "b-every", "--every", "15", ...AGENT]);
    expect(c.exitCode).toBe(0);
    c = await cli(["add", "c-cron", "--cron", "0 3 * * *", ...AGENT]);
    expect(c.exitCode).toBe(0);
    expect(c.text.join("\n")).toContain("schedule enroll c-cron");
    expect(c.text.join("\n")).toContain("not enrolled");
    expect(job("a-once").trigger).toEqual({ type: "once", at: "2026-12-01T09:00:00Z" });
    expect(job("b-every").trigger).toEqual({ type: "every", minutes: 15 });
    expect(job("c-cron").trigger).toEqual({ type: "cron", expr: "0 3 * * *" });
    expect(job("c-cron").host).toBe(MACHINE);
    expect(job("c-cron").agent).toEqual({
      adapter: "codex",
      model: "gpt-test",
      prompt: SECRET_PROMPT,
    });
    expect(readScheduleEnrollment(root, "c-cron")).toBeNull();
  });

  test("accepts --gather name=argv, --gather-json, and --from-file", async () => {
    let c = await cli([
      "add",
      "g-flag",
      "--every",
      "10",
      "--gather",
      'st=["checker","--fast"]',
      "--gather",
      'two=["checker"]',
    ]);
    expect(c.exitCode).toBe(0);
    expect(job("g-flag").gather).toEqual([
      { name: "st", argv: ["checker", "--fast"] },
      { name: "two", argv: ["checker"] },
    ]);
    expect(job("g-flag").agent).toBeUndefined();

    const gj = join(root, "gather.json");
    writeFileSync(
      gj,
      JSON.stringify([{ name: "disk", argv: ["checker"], finding_exit_codes: [2], env: ["HOME"] }]),
    );
    c = await cli([
      "add",
      "g-json",
      "--cron",
      "*/30 * * * *",
      "--gather-json",
      gj,
      "--host",
      "other-box",
    ]);
    expect(c.exitCode).toBe(0);
    expect(job("g-json").gather?.[0]).toEqual({
      name: "disk",
      argv: ["checker"],
      finding_exit_codes: [2],
      env: ["HOME"],
    });
    expect(job("g-json").host).toBe("other-box");

    const jf = join(root, "job.json");
    writeFileSync(
      jf,
      JSON.stringify({
        title: "From file",
        trigger: { type: "every", minutes: 60 },
        timeout_minutes: 5,
        max_launches_per_day: 3,
        gather: [{ name: "x", argv: ["checker"] }],
      }),
    );
    c = await cli(["add", "from-file", "--from-file", jf, "--json"]);
    expect(c.exitCode).toBe(0);
    expect(job("from-file").title).toBe("From file");
    expect(job("from-file").host).toBe(MACHINE);
    expect((c.data[0] as { enrolled: boolean }).enrolled).toBe(false);
  });

  test("refuses every invalid form and writes nothing", async () => {
    const cases: [string[], string][] = [
      [["add", "x", ...AGENT], "schedule_bad_trigger"],
      [["add", "x", "--every", "10", "--cron", "* * * * *", ...AGENT], "schedule_bad_trigger"],
      [["add", "x", "--every", "2", ...AGENT], "schedule_invalid_job"],
      [["add", "x", "--cron", "0 3 * *", ...AGENT], "schedule_invalid_job"],
      [["add", "x", "--once", "tomorrow", ...AGENT], "schedule_invalid_job"],
      [["add", "Bad_Id", "--every", "10", ...AGENT], "schedule_invalid_job"],
      [["add", "x", "--every", "10"], "schedule_invalid_job"],
      [["add", "x", "--every", "10", "--gather", "st=git status"], "schedule_bad_gather"],
      [["add", "x", "--every", "10", "--gather", 'st="git status"'], "schedule_bad_gather"],
      [["add", "x", "--every", "10", "--gather", '["git"]'], "schedule_bad_gather"],
      [
        ["add", "x", "--every", "10", "--gather", 'st=["bash","-c","ls | wc"]'],
        "schedule_invalid_job",
      ],
      [["add", "x", "--every", "10", "--prompt", "hi"], "schedule_bad_agent"],
      [["add", "x", "--every", "10", "--adapter", "codex"], "schedule_bad_agent"],
      [["add", "x", "--every", "10", "--timeout-minutes", "500", ...AGENT], "schedule_invalid_job"],
      [["add", "x", "--every", "10", "--launches-per-day", "0", ...AGENT], "schedule_invalid_job"],
      [["add", "x", "--every", "abc", ...AGENT], "schedule_bad_number"],
      [
        ["add", "x", "--every", "10", "--prompt", "a", "--prompt-file", "f", "--adapter", "c"],
        "schedule_conflicting_options",
      ],
      [["add", "x", "--from-file", "j.json", "--every", "10"], "schedule_conflicting_options"],
    ];
    for (const [args, code] of cases) {
      const c = await cli(args);
      expect({ args, code: c.errors[0]?.code }).toEqual({ args, code });
      expect(c.exitCode).toBe(SCHEDULE_JOBS_EXIT.refused);
    }
    expect(existsSync(join(root, ".harnery", "schedules.jsonc"))).toBe(false);

    const gj = join(root, "gather.json");
    writeFileSync(gj, JSON.stringify([{ name: "s", argv: "git status" }]));
    expect((await cli(["add", "x", "--every", "10", "--gather-json", gj])).errors[0]?.code).toBe(
      "schedule_bad_gather",
    );
  });

  test("prints every validation error", async () => {
    const c = await cli([
      "add",
      "x",
      "--every",
      "2",
      "--timeout-minutes",
      "999",
      "--gather",
      'a=["checker"]',
    ]);
    const hint = c.errors[0]?.hint ?? "";
    expect(hint).toContain("trigger.minutes");
    expect(hint).toContain("timeout_minutes");
  });

  test("refuses a duplicate id", async () => {
    expect((await cli(["add", "dup", "--every", "10", ...AGENT])).exitCode).toBe(0);
    const c = await cli(["add", "dup", "--every", "20", ...AGENT]);
    expect(c.errors[0]?.code).toBe("schedule_duplicate_job");
    expect(jobs()).toHaveLength(1);
  });

  test("writes the gitignore exception once", async () => {
    await cli(["add", "one", "--every", "10", ...AGENT]);
    await cli(["add", "two", "--every", "10", ...AGENT]);
    const text = readFileSync(join(root, ".harnery", ".gitignore"), "utf8");
    expect(text.split("\n").filter((l) => l === "!schedules.jsonc")).toHaveLength(1);
  });
});

describe("enroll", () => {
  beforeEach(async () => {
    await cli([
      "add",
      "nightly",
      "--cron",
      "0 3 * * *",
      "--gather",
      'st=["checker","-v"]',
      ...AGENT,
    ]);
  });

  test("first enrollment proceeds and prints what is pinned", async () => {
    const c = await cli(["enroll", "nightly"]);
    expect(c.exitCode).toBe(0);
    const text = c.text.join("\n");
    expect(text).toContain(`executable: ${realpathSync(exe)}`);
    expect(text).toContain("variables passed: none");
    expect(text).toContain("codex, model gpt-test");
    expect(text).toContain('first line "Check the status."');
    expect(text).toContain("30 minutes");
    expect(text).toMatch(/hash: [0-9a-f]{64}/);
    expect(c.all()).not.toContain("SECRET-SECOND-LINE");
    expect(readScheduleEnrollment(root, "nightly")).not.toBeNull();
  });

  test("re-enrolling after an edit previews unless --yes", async () => {
    await cli(["enroll", "nightly"]);
    const before = readScheduleEnrollment(root, "nightly");
    const j = job("nightly");
    writeScheduleJobFile(root, {
      version: 1,
      jobs: [{ ...j, timeout_minutes: 45, agent: { ...j.agent!, prompt: "New prompt" } }],
    });

    let c = await cli(["enroll", "nightly", "--json"]);
    expect(c.exitCode).toBe(0);
    const preview = c.data[0] as { action: string; applied: boolean; changed_fields: string[] };
    expect(preview.action).toBe("preview");
    expect(preview.applied).toBe(false);
    expect(preview.changed_fields).toEqual(["agent.prompt", "timeout_minutes"]);
    expect(readScheduleEnrollment(root, "nightly")?.job_hash).toBe(before?.job_hash);

    c = await cli(["enroll", "nightly", "--yes"]);
    expect(c.exitCode).toBe(0);
    expect(c.text.join("\n")).toContain("Enrolled again");
    expect(readScheduleEnrollment(root, "nightly")?.job_hash).not.toBe(before?.job_hash);

    c = await cli(["enroll", "nightly", "--json"]);
    expect((c.data[0] as { action: string }).action).toBe("unchanged");
  });

  test("refuses a host that is not this machine", async () => {
    await cli(["add", "elsewhere", "--every", "10", "--host", "far-box", ...AGENT]);
    const c = await cli(["enroll", "elsewhere"]);
    expect(c.errors[0]?.code).toBe("schedule_enroll_wrong-host");
    expect(c.exitCode).toBe(SCHEDULE_JOBS_EXIT.refused);
  });

  test("refuses an executable that cannot be resolved", async () => {
    await cli(["add", "lost", "--every", "10", "--gather", 'x=["no-such-tool"]']);
    const c = await cli(["enroll", "lost"]);
    expect(c.errors[0]?.code).toBe("schedule_enroll_missing-executable");
    expect(c.errors[0]?.message).toContain("no-such-tool");
    expect(c.exitCode).toBe(SCHEDULE_JOBS_EXIT.refused);
  });

  test("refuses when another checkout on this machine holds the job", async () => {
    // First enrollment from another checkout of the same (non-git) path key.
    const other = realpathSync(mkdtempSync(join(tmpdir(), "harnery-schedule-cmd-other-")));
    try {
      mkdirSync(join(other, ".harnery"), { recursive: true });
      const { scheduleRepoKey } = await import("../../core/schedule/enrollment.ts");
      const key = scheduleRepoKey(root);
      mkdirSync(join(registryDir, key), { recursive: true });
      writeFileSync(
        join(registryDir, key, "nightly.json"),
        JSON.stringify({
          checkout: other,
          machine: MACHINE,
          enrolled_at: "2026-11-01T00:00:00.000Z",
        }),
      );
      const c = await cli(["enroll", "nightly"]);
      expect(c.errors[0]?.code).toBe("schedule_enroll_other-checkout");
      expect(c.exitCode).toBe(SCHEDULE_JOBS_EXIT.refused);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("refuses an unknown job", async () => {
    expect((await cli(["enroll", "nope"])).errors[0]?.code).toBe("schedule_unknown_job");
  });
});

describe("pause and resume", () => {
  test("toggle the enabled flag without needing to enroll again", async () => {
    await cli(["add", "p", "--every", "10", "--gather", 'st=["checker"]']);
    await cli(["enroll", "p"]);
    const hash = readScheduleEnrollment(root, "p")?.job_hash;

    let c = await cli(["pause", "p", "--json"]);
    expect(c.data[0]).toMatchObject({ action: "paused", enabled: false, needs_enroll: false });
    expect(job("p").enabled).toBe(false);
    c = await cli(["pause", "p"]);
    expect(c.text.join("\n")).toContain("already paused");
    expect(c.text.join("\n")).toContain("not part of the enrollment hash");

    // Still enrolled as is: a plain enroll reports no change.
    c = await cli(["enroll", "p", "--json"]);
    expect((c.data[0] as { action: string }).action).toBe("unchanged");
    expect(readScheduleEnrollment(root, "p")?.job_hash).toBe(hash);

    c = await cli(["resume", "p", "--json"]);
    expect(c.data[0]).toMatchObject({ action: "resumed", enabled: true });
    expect(job("p").enabled).toBeUndefined();
  });
});

describe("remove", () => {
  test("previews unless --yes, and keeps reports and claims", async () => {
    await cli(["add", "r", "--every", "10", "--gather", 'st=["checker"]']);
    await cli(["enroll", "r"]);
    const runDir = scheduleRunDir(root, "r", scheduleRunStamp("2026-11-22T10:00:00.000Z"));
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "report.md"), "report");
    const claims = scheduleClaimsDir(root, "r");
    mkdirSync(claims, { recursive: true });
    writeFileSync(join(claims, "claim.json"), "{}");

    let c = await cli(["remove", "r", "--json"]);
    expect(c.data[0]).toMatchObject({
      action: "preview",
      applied: false,
      in_file: true,
      enrolled: true,
    });
    expect(jobs()).toHaveLength(1);
    expect(readScheduleEnrollment(root, "r")).not.toBeNull();

    c = await cli(["remove", "r", "--yes"]);
    expect(c.exitCode).toBe(0);
    expect(jobs()).toHaveLength(0);
    expect(readScheduleEnrollment(root, "r")).toBeNull();
    expect(existsSync(join(runDir, "report.md"))).toBe(true);
    expect(existsSync(join(claims, "claim.json"))).toBe(true);

    expect((await cli(["remove", "r", "--yes"])).errors[0]?.code).toBe("schedule_unknown_job");
  });
});

function record(over: Partial<ScheduleRunRecord> = {}): ScheduleRunRecord {
  return {
    schema_version: 1,
    run_id: "run-1",
    job_id: "h",
    scheduled_for: "2026-11-22T10:00:00.000Z",
    kind: "scheduled",
    started_at: "2026-11-22T10:00:01.000Z",
    finished_at: "2026-11-22T10:01:31.000Z",
    result: "ok",
    gather: [
      {
        name: "st",
        state: "ok",
        exit_code: 0,
        duration_ms: 20,
        truncated: false,
        output_file: "gather/st.txt",
      },
    ],
    agent: null,
    report_file: "report.md",
    ...over,
  };
}

describe("run", () => {
  const cases: [ManualScheduleRunResult, number][] = [
    [{ ok: true, record: record(), runDir: "", reportPath: "" }, SCHEDULE_JOBS_EXIT.ok],
    [
      { ok: true, record: record({ result: "attention" }), runDir: "", reportPath: "" },
      SCHEDULE_JOBS_EXIT.attention,
    ],
    [
      { ok: true, record: record({ result: "failed" }), runDir: "", reportPath: "" },
      SCHEDULE_JOBS_EXIT.failed,
    ],
    [{ ok: false, reason: "job is not enrolled" }, SCHEDULE_JOBS_EXIT.runRefused],
  ];
  for (const [result, code] of cases) {
    test(`exits ${code} for ${result.ok ? result.record.result : "refused"}`, async () => {
      let seen: ManualScheduleRunOptions | null = null;
      const fixed: ManualScheduleRunResult = result.ok
        ? {
            ...result,
            reportPath: join(
              root,
              ".harnery",
              "private",
              "schedule",
              "runs",
              "h",
              "x",
              "report.md",
            ),
          }
        : result;
      const c = await cli(["run", "h"], {
        runManually: async (opts) => {
          seen = opts;
          return fixed;
        },
      });
      expect(c.exitCode).toBe(code);
      expect(seen).toMatchObject({ coordRoot: root, jobId: "h", machine: MACHINE });
      if (result.ok) {
        const text = c.text.join("\n");
        expect(text).toContain("gather st: ok (exit 0)");
        expect(text).toContain("Report: .harnery/private/schedule/runs/h/x/report.md");
      } else {
        expect(c.errors[0]?.message).toContain("job is not enrolled");
      }
    });
  }
});

describe("history", () => {
  function writeRun(r: ScheduleRunRecord): void {
    const dir = scheduleRunDir(root, r.job_id, scheduleRunStamp(r.started_at));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify(r));
  }

  test("lists runs newest first and honours --limit", async () => {
    writeRun(
      record({
        run_id: "old",
        started_at: "2026-11-20T10:00:00.000Z",
        finished_at: "2026-11-20T10:00:05.000Z",
      }),
    );
    writeRun(
      record({
        run_id: "new",
        started_at: "2026-11-22T10:00:00.000Z",
        finished_at: "2026-11-22T10:02:00.000Z",
        kind: "manual",
      }),
    );
    writeRun(
      record({
        run_id: "mid",
        started_at: "2026-11-21T10:00:00.000Z",
        finished_at: "2026-11-21T10:00:30.000Z",
        result: "attention",
      }),
    );

    let c = await cli(["history", "h", "--json"]);
    const out = c.data[0] as {
      rows: { run_id: string; duration_ms: number; report_path: string }[];
    };
    expect(out.rows.map((r) => r.run_id)).toEqual(["new", "mid", "old"]);
    expect(out.rows[0]?.duration_ms).toBe(120_000);
    expect(out.rows[0]?.report_path).toBe(
      ".harnery/private/schedule/runs/h/20261122T100000000Z/report.md",
    );

    c = await cli(["history", "h", "--limit", "2", "--json"]);
    expect((c.data[0] as { rows: unknown[] }).rows).toHaveLength(2);

    c = await cli(["history", "h", "--limit", "1"]);
    const text = c.text.join("\n");
    expect(text).toContain("1 of 3");
    expect(text).toContain("manual");
    expect(text).toContain("2m 0s");

    expect((await cli(["history", "h", "--limit", "0"])).errors[0]?.code).toBe(
      "schedule_bad_number",
    );
    expect((await cli(["history", "none"])).text.join("\n")).toContain("No runs recorded");
  });
});

describe("no prompt leak", () => {
  test("add, pause, remove and history never print the prompt text", async () => {
    const outputs: Captured[] = [];
    outputs.push(await cli(["add", "leak", "--every", "10", ...AGENT]));
    outputs.push(await cli(["add", "leak2", "--every", "10", ...AGENT, "--json"]));
    outputs.push(await cli(["pause", "leak"]));
    outputs.push(await cli(["remove", "leak"]));
    outputs.push(await cli(["history", "leak", "--json"]));
    for (const c of outputs) {
      expect(c.all()).not.toContain("SECRET-SECOND-LINE");
      expect(c.all()).not.toContain("Check the status.");
    }
  });
});
