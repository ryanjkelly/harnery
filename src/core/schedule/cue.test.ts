import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import {
  assessScheduleHealth,
  parseSystemctlShow,
  SCHEDULE_CUE_MAX_LINES,
  type ScheduleHealth,
  type ScheduleUnitState,
  scheduleCueLines,
  systemctlUnitStateProbe,
} from "./cue.ts";
import { enrollScheduleJob } from "./enrollment.ts";
import {
  parseScheduleJobFileText,
  type ScheduleClaim,
  type ScheduleHeartbeat,
  type ScheduleRunRecord,
  type ScheduleTimerInstall,
  validateScheduleClaim,
  validateScheduleHeartbeat,
  validateScheduleRunRecord,
  validateScheduleTimerInstall,
} from "./job-types.ts";
import { resolveScheduleJob } from "./jobs.ts";
import {
  scheduleClaimPath,
  scheduleHeartbeatPath,
  scheduleJobFilePath,
  scheduleRunDir,
  scheduleRunRecordPath,
  scheduleRunStamp,
  scheduleStateDir,
  scheduleTimerInstallPath,
} from "./paths.ts";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "harnery-cue-"));
  dirs.push(r);
  mkdirSync(scheduleStateDir(r), { recursive: true });
  return r;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function heartbeat(over: Partial<ScheduleHeartbeat> = {}): ScheduleHeartbeat {
  const h: ScheduleHeartbeat = {
    schema_version: 1,
    last_tick_at: minutesAgo(1),
    last_tick_status: "ok",
    last_ok_at: minutesAgo(1),
    source: "timer",
    last_timer_tick_at: minutesAgo(1),
    timer_interval_minutes: 5,
    ...over,
  };
  expect(validateScheduleHeartbeat(h).ok).toBe(true);
  return h;
}

function install(over: Partial<ScheduleTimerInstall> = {}): ScheduleTimerInstall {
  const t: ScheduleTimerInstall = {
    schema_version: 1,
    installed_at: minutesAgo(600),
    interval_minutes: 5,
    unit: "harnery-schedule-abc.timer",
    command: ["harn", "schedule", "tick"],
    ...over,
  };
  expect(validateScheduleTimerInstall(t).ok).toBe(true);
  return t;
}

let runSeq = 0;
function writeRun(
  r: string,
  jobId: string,
  result: ScheduleRunRecord["result"],
  startedMinAgo: number,
) {
  const started = minutesAgo(startedMinAgo);
  const run: ScheduleRunRecord = {
    schema_version: 1,
    run_id: `run-${++runSeq}`,
    job_id: jobId,
    scheduled_for: started,
    kind: "scheduled",
    started_at: started,
    finished_at: minutesAgo(startedMinAgo - 1),
    result,
    gather: [],
    agent: null,
    report_file: "report.md",
  };
  expect(validateScheduleRunRecord(run).ok).toBe(true);
  writeJson(scheduleRunRecordPath(scheduleRunDir(r, jobId, scheduleRunStamp(started))), run);
  return run;
}

function writeClaim(
  r: string,
  over: Partial<ScheduleClaim> & { job_id: string; scheduled_for: string },
) {
  const claim: ScheduleClaim = {
    schema_version: 1,
    kind: "scheduled",
    state: "started",
    claimed_at: over.scheduled_for,
    started_at: over.scheduled_for,
    run_id: `claim-${++runSeq}`,
    ...over,
  };
  expect(validateScheduleClaim(claim).ok).toBe(true);
  writeJson(scheduleClaimPath(r, claim.job_id, claim.scheduled_for), claim);
  return claim;
}

const active = async (): Promise<ScheduleUnitState> => ({ status: "active" });
const neverProbe = async (): Promise<ScheduleUnitState> => {
  throw new Error("unit probe must not run");
};

describe("assessScheduleHealth", () => {
  test("a checkout with nothing set up has no problems and no subprocess", async () => {
    const r = mkdtempSync(join(tmpdir(), "harnery-cue-empty-"));
    dirs.push(r);
    const h = await assessScheduleHealth({ coordRoot: r, now: NOW, unitState: neverProbe });
    expect(h.problems).toEqual([]);
    expect(scheduleCueLines(h, "harn")).toEqual([]);
  });

  test("a healthy timer and ok runs add nothing", async () => {
    const r = root();
    writeJson(scheduleHeartbeatPath(r), heartbeat());
    writeJson(scheduleTimerInstallPath(r), install());
    writeRun(r, "nightly", "failed", 120);
    writeRun(r, "nightly", "ok", 30);
    const h = await assessScheduleHealth({ coordRoot: r, now: NOW, unitState: active });
    expect(h.problems).toEqual([]);
    expect(h.jobs).toEqual(["nightly"]);
    expect(scheduleCueLines(h, "harn")).toEqual([]);
  });

  test("a failed newest run is reported with its report path and history command", async () => {
    const r = root();
    writeRun(r, "nightly", "ok", 300);
    writeRun(r, "nightly", "attention", 200);
    const last = writeRun(r, "nightly", "failed", 100);
    const h = await assessScheduleHealth({ coordRoot: r, now: NOW });
    expect(h.problems).toHaveLength(1);
    const p = h.problems[0];
    expect(p?.kind).toBe("run-failed");
    expect(p?.message).toContain("2 runs since the last ok");
    expect(p?.report).toBe(
      join(
        ".harnery",
        "private",
        "schedule",
        "runs",
        "nightly",
        scheduleRunStamp(last.started_at),
        "report.md",
      ),
    );
    const [line] = scheduleCueLines(h, "harn");
    expect(line).toContain("`harn schedule history nightly`");
    expect(line).toContain(p?.report as string);
  });

  test("an attention run is reported", async () => {
    const r = root();
    writeRun(r, "check", "attention", 10);
    const h = await assessScheduleHealth({ coordRoot: r, now: NOW });
    expect(h.problems.map((p) => p.kind)).toEqual(["run-attention"]);
  });

  test("a started claim whose process is gone is uncertain", async () => {
    const r = root();
    writeClaim(r, { job_id: "check", scheduled_for: minutesAgo(20), pid: 4242 });
    const h = await assessScheduleHealth({ coordRoot: r, now: NOW, isProcessAlive: () => false });
    expect(h.problems.map((p) => p.kind)).toEqual(["run-uncertain"]);
    expect(h.problems[0]?.message).toContain("process is gone");
  });

  test("a started claim that is plausibly still running is not a problem", async () => {
    const r = root();
    writeClaim(r, { job_id: "check", scheduled_for: minutesAgo(20), pid: 4242 });
    const h = await assessScheduleHealth({ coordRoot: r, now: NOW, isProcessAlive: () => true });
    expect(h.problems).toEqual([]);
  });

  test("a started claim past the job deadline is uncertain even if the pid is alive", async () => {
    const r = root();
    writeFileSync(
      join(r, ".harnery", "schedules.jsonc"),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "check",
            title: "Check",
            host: "box",
            trigger: { type: "every", minutes: 60 },
            timeout_minutes: 10,
            max_launches_per_day: 4,
            gather: [{ name: "probe", argv: ["true"] }],
          },
        ],
      }),
    );
    expect(
      parseScheduleJobFileText(readFileSync(join(r, ".harnery", "schedules.jsonc"), "utf8")).ok,
    ).toBe(true);
    // 10 minute deadline plus 10 minutes of grace: 15 minutes is still running, 25 is not.
    writeClaim(r, { job_id: "check", scheduled_for: minutesAgo(15), pid: 4242 });
    expect(
      (await assessScheduleHealth({ coordRoot: r, now: NOW, isProcessAlive: () => true })).problems,
    ).toEqual([]);
    writeClaim(r, { job_id: "check", scheduled_for: minutesAgo(25), pid: 4242 });
    const h = await assessScheduleHealth({ coordRoot: r, now: NOW, isProcessAlive: () => true });
    expect(h.problems.map((p) => p.kind)).toEqual(["run-uncertain"]);
    expect(h.problems[0]?.message).toContain("past its deadline");
  });

  test("a started claim with no pid is uncertain only after the longest deadline", async () => {
    const r = root();
    writeClaim(r, { job_id: "check", scheduled_for: minutesAgo(60) });
    writeClaim(r, { job_id: "old", scheduled_for: minutesAgo(600) });
    const h = await assessScheduleHealth({ coordRoot: r, now: NOW });
    expect(h.problems.map((p) => `${p.kind}:${p.job_id}`)).toEqual(["run-uncertain:old"]);
  });

  test("an uncertain claim is superseded by a newer ok run, and a finished run id clears it", async () => {
    const r = root();
    writeClaim(r, { job_id: "check", scheduled_for: minutesAgo(60), pid: 1 });
    writeRun(r, "check", "ok", 30);
    const run = writeRun(r, "other", "ok", 30);
    writeClaim(r, { job_id: "other", scheduled_for: minutesAgo(10), pid: 1, run_id: run.run_id });
    const h = await assessScheduleHealth({ coordRoot: r, now: NOW, isProcessAlive: () => false });
    expect(h.problems).toEqual([]);
  });

  test("claims that are not started are not reported", async () => {
    const r = root();
    writeClaim(r, {
      job_id: "check",
      scheduled_for: minutesAgo(900),
      state: "claimed",
      started_at: undefined,
    });
    writeClaim(r, { job_id: "check", scheduled_for: minutesAgo(800), state: "abandoned" });
    writeClaim(r, {
      job_id: "check",
      scheduled_for: minutesAgo(700),
      state: "finished",
      finished_at: minutesAgo(690),
    });
    const h = await assessScheduleHealth({ coordRoot: r, now: NOW, isProcessAlive: () => false });
    expect(h.problems).toEqual([]);
  });

  test("an invalid claim or heartbeat is reported as unreadable, not a crash", async () => {
    const r = root();
    writeJson(scheduleClaimPath(r, "check", minutesAgo(5)), { schema_version: 1, nope: true });
    writeFileSync(scheduleHeartbeatPath(r), "{not json");
    const h = await assessScheduleHealth({ coordRoot: r, now: NOW });
    expect(h.problems.map((p) => p.kind).sort()).toEqual(["unreadable", "unreadable"]);
    expect(h.problems.find((p) => p.area === "clock")?.file).toBe(
      join(".harnery", "private", "schedule", "heartbeat.json"),
    );
  });

  test("with no install record, an old or errored heartbeat gives no clock warning", async () => {
    const r = root();
    writeJson(
      scheduleHeartbeatPath(r),
      heartbeat({
        last_tick_at: minutesAgo(5000),
        last_tick_status: "error",
        last_tick_error: "boom",
        last_timer_tick_at: minutesAgo(5000),
      }),
    );
    const h = await assessScheduleHealth({ coordRoot: r, now: NOW, unitState: neverProbe });
    expect(h.problems).toEqual([]);
  });

  test("a tick error is reported with its one-line error", async () => {
    const r = root();
    writeJson(scheduleTimerInstallPath(r), install());
    writeJson(
      scheduleHeartbeatPath(r),
      heartbeat({ last_tick_status: "error", last_tick_error: "job file\ninvalid" }),
    );
    const h = await assessScheduleHealth({ coordRoot: r, now: NOW, unitState: active });
    expect(h.problems.map((p) => p.kind)).toEqual(["tick-error"]);
    expect(h.problems[0]?.message).toContain("job file invalid");
    expect(scheduleCueLines(h, "harn")[0]).toContain("`harn schedule tick`");
  });

  test("a timer tick older than twice the interval is overdue", async () => {
    const r = root();
    writeJson(scheduleTimerInstallPath(r), install());
    writeJson(
      scheduleHeartbeatPath(r),
      heartbeat({ last_timer_tick_at: minutesAgo(11), source: "activity" }),
    );
    const h = await assessScheduleHealth({ coordRoot: r, now: NOW, unitState: active });
    expect(h.problems.map((p) => p.kind)).toEqual(["timer-overdue"]);
  });

  test("no timer tick yet: quiet right after install, overdue later", async () => {
    const r = root();
    writeJson(scheduleTimerInstallPath(r), install({ installed_at: minutesAgo(3) }));
    expect(
      (await assessScheduleHealth({ coordRoot: r, now: NOW, unitState: active })).problems,
    ).toEqual([]);
    writeJson(scheduleTimerInstallPath(r), install({ installed_at: minutesAgo(30) }));
    const h = await assessScheduleHealth({ coordRoot: r, now: NOW, unitState: active });
    expect(h.problems.map((p) => p.kind)).toEqual(["timer-overdue"]);
  });

  test("the heartbeat is judged as read, before a later tick refreshes it", async () => {
    const r = root();
    writeJson(scheduleTimerInstallPath(r), install());
    writeJson(scheduleHeartbeatPath(r), heartbeat({ last_timer_tick_at: minutesAgo(120) }));
    let release: (s: ScheduleUnitState) => void = () => {};
    const pending = assessScheduleHealth({
      coordRoot: r,
      now: NOW,
      unitState: () => new Promise((resolve) => (release = resolve)),
    });
    // The catch-up tick writes a fresh heartbeat while the assessment is in flight.
    writeJson(scheduleHeartbeatPath(r), heartbeat());
    release({ status: "active" });
    const h = await pending;
    expect(h.problems.map((p) => p.kind)).toEqual(["timer-overdue"]);
    // A fresh assessment now sees the refreshed heartbeat.
    expect(
      (await assessScheduleHealth({ coordRoot: r, now: NOW, unitState: active })).problems,
    ).toEqual([]);
  });

  test.each([
    ["missing", "is missing"],
    ["disabled", "is disabled"],
    ["failed", "is failed"],
    ["inactive", "is inactive"],
  ] as const)("a %s unit is reported", async (status, text) => {
    const r = root();
    writeJson(scheduleTimerInstallPath(r), install());
    writeJson(scheduleHeartbeatPath(r), heartbeat());
    const h = await assessScheduleHealth({
      coordRoot: r,
      now: NOW,
      unitState: async () => ({ status }),
    });
    expect(h.problems.map((p) => p.kind)).toEqual(["timer-unit"]);
    expect(h.problems[0]?.message).toContain(text);
    expect(scheduleCueLines(h, "harn")[0]).toContain("`harn schedule install`");
  });

  test("an unknown unit state or a throwing probe falls back to the heartbeat", async () => {
    const r = root();
    writeJson(scheduleTimerInstallPath(r), install());
    writeJson(scheduleHeartbeatPath(r), heartbeat());
    const unknown = await assessScheduleHealth({
      coordRoot: r,
      now: NOW,
      unitState: async () => ({ status: "unknown" }),
    });
    expect(unknown.problems).toEqual([]);
    const thrown = await assessScheduleHealth({ coordRoot: r, now: NOW, unitState: neverProbe });
    expect(thrown.problems).toEqual([]);
    expect(thrown.unit_state?.status).toBe("unknown");
  });
});

describe("systemctl unit probe", () => {
  const show = (timer: Record<string, string>, service?: Record<string, string>) =>
    [timer, service]
      .filter(Boolean)
      .map((b) =>
        Object.entries(b as Record<string, string>)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
      )
      .join("\n\n");
  const T = "harnery-schedule-abc.timer";
  const S = "harnery-schedule-abc.service";

  test("parses the timer and service states", () => {
    const ok = { Id: T, LoadState: "loaded", ActiveState: "active", UnitFileState: "enabled" };
    const svc = {
      Id: S,
      LoadState: "loaded",
      ActiveState: "inactive",
      UnitFileState: "static",
      Result: "success",
    };
    expect(parseSystemctlShow(show(ok, svc), T, S).status).toBe("active");
    expect(parseSystemctlShow(show({ ...ok, LoadState: "not-found" }), T, S).status).toBe(
      "missing",
    );
    expect(parseSystemctlShow(show({ ...ok, UnitFileState: "disabled" }), T, S).status).toBe(
      "disabled",
    );
    expect(parseSystemctlShow(show({ ...ok, ActiveState: "inactive" }), T, S).status).toBe(
      "inactive",
    );
    expect(
      parseSystemctlShow(show(ok, { ...svc, ActiveState: "failed", Result: "exit-code" }), T, S),
    ).toEqual({
      status: "failed",
      detail: `${S}: exit-code`,
    });
    expect(parseSystemctlShow("", T, S).status).toBe("unknown");
  });

  test("runs one systemctl show and treats a missing systemctl as unknown", async () => {
    const calls: string[][] = [];
    const probe = systemctlUnitStateProbe(async (argv) => {
      calls.push([...argv]);
      return { exitCode: null, stdout: "", stderr: "", error: "ENOENT" };
    });
    expect(await probe(install())).toEqual({ status: "unknown", detail: "ENOENT" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 5)).toEqual(["systemctl", "--user", "show", T, S]);
  });
});

describe("scheduleCueLines", () => {
  test("caps the lines and ends with how many more", () => {
    const health: ScheduleHealth = {
      assessed_at: NOW.toISOString(),
      jobs: [],
      job_file: true,
      heartbeat: null,
      timer: null,
      problems: Array.from({ length: 8 }, (_, i) => ({
        kind: "run-failed" as const,
        area: "runs" as const,
        job_id: `job-${i}`,
        message: `scheduled job job-${i} failed`,
      })),
    };
    const lines = scheduleCueLines(health, "harn");
    expect(lines).toHaveLength(SCHEDULE_CUE_MAX_LINES);
    expect(lines.at(-1)).toBe("and 4 more schedule problems; run `harn doctor`");
    health.problems = health.problems.slice(0, SCHEDULE_CUE_MAX_LINES);
    expect(scheduleCueLines(health, "harn")).toHaveLength(SCHEDULE_CUE_MAX_LINES);
  });
});

describe("a job stopped by an edit", () => {
  const job = (prompt: string) => ({
    id: "nightly-check",
    title: "Nightly check",
    host: "box",
    trigger: { type: "every" as const, minutes: 60 },
    timeout_minutes: 10,
    max_launches_per_day: 4,
    agent: { adapter: "codex", prompt },
  });
  function setup(enrolledPrompt: string, filePrompt: string, extra: object = {}) {
    const r = root();
    const registryDir = join(r, "registry");
    const enrolled = job(enrolledPrompt);
    const done = enrollScheduleJob({
      coordRoot: r,
      job: enrolled,
      resolved: resolveScheduleJob(enrolled, { coordRoot: r, env: {} }),
      machine: "box",
      now: NOW,
      registryDir,
    });
    expect(done.ok).toBe(true);
    writeJson(scheduleJobFilePath(r), { version: 1, jobs: [{ ...job(filePrompt), ...extra }] });
    return r;
  }
  const assess = (r: string, machine = "box") =>
    assessScheduleHealth({ coordRoot: r, now: NOW, machine, env: {} });

  test("is reported with the command that enrolls it again", async () => {
    const health = await assess(setup("Judge the evidence.", "Judge the evidence, strictly."));
    expect(health.problems).toMatchObject([
      { kind: "job-stopped", area: "runs", job_id: "nightly-check" },
    ]);
    const lines = scheduleCueLines(health, "harn");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("will not run");
    expect(lines[0]).toContain("harn schedule enroll nightly-check");
    expect(lines[0]).not.toContain("strictly");
  });

  test("an unchanged, a disabled, another machine's and a never-enrolled job add nothing", async () => {
    expect((await assess(setup("Same.", "Same."))).problems).toEqual([]);
    expect((await assess(setup("A.", "B.", { enabled: false }))).problems).toEqual([]);
    expect((await assess(setup("A.", "B."), "other-box")).problems).toEqual([]);
    const fresh = root();
    writeJson(scheduleJobFilePath(fresh), { version: 1, jobs: [job("Never enrolled.")] });
    expect((await assess(fresh)).problems).toEqual([]);
  });
});
