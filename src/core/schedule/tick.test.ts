import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScheduleClaim,
  listScheduleClaims,
  markScheduleClaimStarted,
  readScheduleClaim,
  takeScheduleClaimRetry,
} from "./claims.ts";
import { enrollScheduleJob } from "./enrollment.ts";
import { readScheduleHeartbeat, writeScheduleHeartbeat } from "./heartbeat.ts";
import type {
  ScheduleJob,
  ScheduleLauncher,
  ScheduleLaunchRequest,
  ScheduleRunRecord,
  ScheduleRunResult,
} from "./job-types.ts";
import { resolveScheduleJob } from "./jobs.ts";
import {
  scheduleHeartbeatPath,
  scheduleJobFilePath,
  scheduleRunDir,
  scheduleRunRecordPath,
  scheduleRunReportPath,
  scheduleRunStamp,
  scheduleStateDir,
} from "./paths.ts";
import {
  readScheduleCursor,
  runScheduleJobManually,
  runScheduleTick,
  type ScheduleTickOptions,
  shouldRunActivityTick,
  spawnDetachedScheduleTick,
} from "./tick.ts";

const MACHINE = "box";
const ENROLLED = new Date("2026-11-22T12:00:00.000Z");
const MIN = 60_000;
const at = (minutes: number) => new Date(ENROLLED.getTime() + minutes * MIN);
const iso = (minutes: number) => at(minutes).toISOString();

let base: string;
let root: string;
let registryDir: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "harnery-schedule-tick-")));
  root = join(base, "repo");
  registryDir = join(base, "registry");
  mkdirSync(join(root, ".harnery"), { recursive: true });
  writeFileSync(join(root, ".harnery", "config.jsonc"), JSON.stringify({ timeZone: "UTC" }));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const job = (over: Partial<ScheduleJob> = {}): ScheduleJob => ({
  id: "hourly-check",
  title: "Hourly check",
  host: MACHINE,
  trigger: { type: "every", minutes: 60 },
  timeout_minutes: 10,
  max_launches_per_day: 48,
  agent: { adapter: "codex", prompt: "Look at the evidence." },
  ...over,
});

function writeJobs(jobs: ScheduleJob[]): void {
  writeFileSync(scheduleJobFilePath(root), JSON.stringify({ version: 1, jobs }, null, 2));
}

function enroll(j: ScheduleJob, now = ENROLLED): void {
  const resolved = resolveScheduleJob(j, { coordRoot: root, env: {} });
  const r = enrollScheduleJob({
    coordRoot: root,
    job: j,
    resolved,
    machine: MACHINE,
    now,
    registryDir,
  });
  if (!r.ok) throw new Error(`enroll failed: ${r.detail}`);
}

function setup(j = job()): ScheduleJob {
  writeJobs([j]);
  enroll(j);
  return j;
}

/** A launcher that writes a valid run record and report, as the run module does. */
function fakeLauncher(result: ScheduleRunResult = "ok", delayMs = 0) {
  const calls: ScheduleLaunchRequest[] = [];
  const launcher: ScheduleLauncher = async (request) => {
    calls.push(request);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const startedAt = request.claim.started_at as string;
    const runDir = scheduleRunDir(request.coordRoot, request.job.id, scheduleRunStamp(startedAt));
    mkdirSync(runDir, { recursive: true });
    const record: ScheduleRunRecord = {
      schema_version: 1,
      run_id: request.claim.run_id,
      job_id: request.job.id,
      scheduled_for: request.claim.scheduled_for,
      kind: request.claim.kind,
      started_at: startedAt,
      finished_at: startedAt,
      result,
      gather: [],
      agent: { adapter: "codex", ok: true, status_line: result === "ok" ? "ok" : "attention" },
      report_file: "report.md",
    };
    writeFileSync(scheduleRunRecordPath(runDir), JSON.stringify(record));
    writeFileSync(scheduleRunReportPath(runDir), "# report\n");
    return { record };
  };
  return { launcher, calls };
}

function tick(now: Date, launcher: ScheduleLauncher, over: Partial<ScheduleTickOptions> = {}) {
  return runScheduleTick({
    coordRoot: root,
    source: "manual",
    now,
    launcher,
    machine: MACHINE,
    env: {},
    notify: () => {},
    ...over,
  });
}

describe("runScheduleTick", () => {
  test("two concurrent ticks launch one due time exactly once", async () => {
    setup();
    const { launcher, calls } = fakeLauncher("ok", 30);
    const [a, b] = await Promise.all([tick(at(61), launcher), tick(at(61), launcher)]);
    expect(calls).toHaveLength(1);
    expect([a.status, b.status].sort()).toEqual(["busy", "ok"]);
    const claims = listScheduleClaims(root, "hourly-check");
    expect(claims.map((c) => [c.scheduled_for, c.claim?.state])).toEqual([[iso(60), "finished"]]);
  });

  test("a second tick after a finished run does nothing", async () => {
    setup();
    const { launcher, calls } = fakeLauncher();
    const first = await tick(at(61), launcher);
    expect(first.jobs[0]?.launches).toMatchObject([
      { scheduled_for: iso(60), kind: "scheduled", result: "ok", retry: false },
    ]);
    const second = await tick(at(65), launcher);
    expect(calls).toHaveLength(1);
    expect(second.jobs[0]?.launches).toEqual([]);
  });

  test("hands the launcher a started claim and the job deadline", async () => {
    setup();
    const { launcher, calls } = fakeLauncher();
    await tick(at(61), launcher);
    const request = calls[0] as ScheduleLaunchRequest;
    expect(request.claim.state).toBe("started");
    expect(request.claim.pid).toBe(process.pid);
    expect(request.deadline_at).toBe(iso(71));
    expect(request.enrollment.job_id).toBe("hourly-check");
  });

  test("nothing due before enrollment runs", async () => {
    setup(job({ id: "past-once", trigger: { type: "once", at: iso(-30) } }));
    const { launcher, calls } = fakeLauncher();
    const r = await tick(at(120), launcher);
    expect(calls).toHaveLength(0);
    expect(r.status).toBe("ok");
    expect(listScheduleClaims(root, "past-once")).toEqual([]);
  });

  test("restart catch-up runs only the latest missed time and writes one skipped range", async () => {
    setup();
    const { launcher, calls } = fakeLauncher();
    const r = await tick(at(5 * 60 + 1), launcher);
    expect(calls.map((c) => c.claim.scheduled_for)).toEqual([iso(300)]);
    expect(calls[0]?.claim.kind).toBe("catch-up");
    expect(r.jobs[0]?.skipped_range).toEqual({ from: iso(60), to: iso(240), count: 4 });
    const cursor = readScheduleCursor(root, "hourly-check");
    expect(cursor?.last_considered).toBe(iso(301));
    expect(cursor?.skipped).toEqual([{ from: iso(60), to: iso(240), count: 4 }]);
    // A later tick does not walk the backlog again.
    const again = await tick(at(302), launcher);
    expect(again.jobs[0]?.skipped_range).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test("a due time older than the catch-up window is skipped, not run", async () => {
    setup(job({ trigger: { type: "once", at: iso(10) } }));
    const { launcher, calls } = fakeLauncher();
    const r = await tick(at(8 * 24 * 60), launcher);
    expect(calls).toHaveLength(0);
    expect(r.jobs[0]?.skipped_range).toEqual({ from: iso(10), to: iso(10), count: 1 });
  });

  test("a claim with no start is retried once", async () => {
    setup();
    // A tick crashed after creating the claim and before starting it.
    const crashed = createScheduleClaim({
      coordRoot: root,
      jobId: "hourly-check",
      scheduledFor: iso(60),
      kind: "scheduled",
      now: at(61),
    });
    if (!crashed.ok) throw new Error("setup");
    const { launcher, calls } = fakeLauncher();
    const r = await tick(at(66), launcher);
    expect(calls).toHaveLength(1);
    expect(r.jobs[0]?.launches).toMatchObject([{ scheduled_for: iso(60), retry: true }]);
    const read = readScheduleClaim(root, "hourly-check", iso(60));
    expect(read.state === "ok" && read.claim.state).toBe("finished");
  });

  test("a claim whose retry also never started is abandoned", async () => {
    setup();
    const crashed = createScheduleClaim({
      coordRoot: root,
      jobId: "hourly-check",
      scheduledFor: iso(60),
      kind: "scheduled",
      now: at(61),
    });
    if (!crashed.ok) throw new Error("setup");
    expect(takeScheduleClaimRetry(root, crashed.claim, at(62))).toBe(true);
    const { launcher, calls } = fakeLauncher();
    const r = await tick(at(66), launcher);
    expect(calls).toHaveLength(0);
    expect(r.jobs[0]?.abandoned).toEqual([{ scheduled_for: iso(60), reason: "retried-once" }]);
    const read = readScheduleClaim(root, "hourly-check", iso(60));
    expect(read.state === "ok" && read.claim.state).toBe("abandoned");
  });

  test("a claim with no start is superseded by a newer due time", async () => {
    setup();
    const crashed = createScheduleClaim({
      coordRoot: root,
      jobId: "hourly-check",
      scheduledFor: iso(60),
      kind: "scheduled",
      now: at(61),
    });
    if (!crashed.ok) throw new Error("setup");
    const { launcher, calls } = fakeLauncher();
    const r = await tick(at(121), launcher);
    expect(calls.map((c) => c.claim.scheduled_for)).toEqual([iso(120)]);
    expect(r.jobs[0]?.abandoned).toEqual([{ scheduled_for: iso(60), reason: "superseded" }]);
  });

  test("a claim that started and never finished is never rerun", async () => {
    setup();
    const crashed = createScheduleClaim({
      coordRoot: root,
      jobId: "hourly-check",
      scheduledFor: iso(60),
      kind: "scheduled",
      now: at(61),
    });
    if (!crashed.ok) throw new Error("setup");
    markScheduleClaimStarted(root, crashed.claim, { now: at(61), pid: 999_999 });
    const { launcher, calls } = fakeLauncher();
    const r = await tick(at(70), launcher);
    expect(calls).toHaveLength(0);
    expect(r.jobs[0]?.uncertain).toEqual([iso(60)]);
    const read = readScheduleClaim(root, "hourly-check", iso(60));
    expect(read.state === "ok" && read.claim.state).toBe("started");
  });

  test("an edited job is skipped with a reason", async () => {
    const j = setup();
    writeJobs([{ ...j, agent: { adapter: "codex", prompt: "Something else." } }]);
    const { launcher, calls } = fakeLauncher();
    const r = await tick(at(61), launcher);
    expect(calls).toHaveLength(0);
    expect(r.status).toBe("ok");
    expect(r.jobs[0]?.skipped?.reason).toBe("changed");
  });

  test("jobs for another host, disabled jobs and unenrolled jobs are skipped", async () => {
    writeJobs([
      job({ id: "elsewhere", host: "other-box" }),
      job({ id: "off", enabled: false }),
      job({ id: "new-job" }),
    ]);
    const { launcher, calls } = fakeLauncher();
    const r = await tick(at(61), launcher);
    expect(calls).toHaveLength(0);
    expect(r.jobs.map((j) => [j.job_id, j.skipped?.reason])).toEqual([
      ["elsewhere", "other-host"],
      ["off", "disabled"],
      ["new-job", "not-enrolled"],
    ]);
  });

  test("the launches-per-day limit refuses a due time and records it as skipped", async () => {
    setup(job({ trigger: { type: "every", minutes: 5 }, max_launches_per_day: 1 }));
    const { launcher, calls } = fakeLauncher();
    await tick(at(5), launcher);
    const r = await tick(at(10), launcher);
    expect(calls).toHaveLength(1);
    expect(r.jobs[0]?.refused).toEqual([
      { scheduled_for: iso(10), reason: "daily-limit", launches_today: 1 },
    ]);
    expect(r.jobs[0]?.skipped_range).toEqual({ from: iso(10), to: iso(10), count: 1 });
    expect(readScheduleClaim(root, "hourly-check", iso(10)).state).toBe("missing");
    // The next local day has a fresh allowance.
    const tomorrow = await tick(new Date("2026-11-23T00:01:00.000Z"), launcher);
    expect(tomorrow.jobs[0]?.launches).toHaveLength(1);
  });

  test("a launcher that throws makes the tick an error and leaves the claim started", async () => {
    setup();
    writeScheduleHeartbeat(root, { at: at(1), source: "timer", status: "ok" });
    const launcher: ScheduleLauncher = async () => {
      throw new Error("boom\nwith detail");
    };
    const r = await tick(at(61), launcher);
    expect(r.status).toBe("error");
    expect(r.error).toContain("boom with detail");
    expect(r.jobs[0]?.launches[0]?.error).toBe("boom with detail");
    const read = readScheduleClaim(root, "hourly-check", iso(60));
    expect(read.state === "ok" && read.claim.state).toBe("started");
    const hb = readScheduleHeartbeat(root);
    expect(hb).toMatchObject({
      last_tick_status: "error",
      last_ok_at: at(1).toISOString(),
      last_timer_tick_at: at(1).toISOString(),
    });
  });

  test("an invalid job file is an error tick", async () => {
    writeFileSync(scheduleJobFilePath(root), "{ not json");
    const r = await tick(at(1), fakeLauncher().launcher);
    expect(r.status).toBe("error");
    expect(readScheduleHeartbeat(root)?.last_tick_status).toBe("error");
  });

  test("a missing job file is an ok tick that still writes the heartbeat", async () => {
    const r = await tick(at(1), fakeLauncher().launcher, { source: "timer" });
    expect(r).toMatchObject({ status: "ok", jobs: [] });
    expect(readScheduleHeartbeat(root)).toMatchObject({
      source: "timer",
      last_timer_tick_at: at(1).toISOString(),
    });
  });

  test("timer and activity ticks carry the timer time forward", async () => {
    await tick(at(1), fakeLauncher().launcher, { source: "timer" });
    await tick(at(3), fakeLauncher().launcher, { source: "activity" });
    expect(readScheduleHeartbeat(root)).toMatchObject({
      source: "activity",
      last_tick_at: at(3).toISOString(),
      last_timer_tick_at: at(1).toISOString(),
    });
  });

  test("a running timer tick keeps recording that the timer is alive", async () => {
    setup();
    const slow = fakeLauncher("ok", 80);
    const seen: (string | undefined)[] = [];
    const launcher: ScheduleLauncher = async (request) => {
      // No heartbeat existed before this tick; it wrote one when it started.
      seen.push(readScheduleHeartbeat(root)?.last_timer_tick_at);
      const out = await slow.launcher(request);
      seen.push(readScheduleHeartbeat(root)?.last_timer_tick_at);
      return out;
    };
    const result = await tick(at(61), launcher, { source: "timer", timerKeepAliveMs: 10 });
    expect(result.status).toBe("ok");
    expect(seen[0]).toBe(at(61).toISOString());
    expect(typeof seen[1]).toBe("string");
    expect(seen[1]).not.toBe(seen[0]);
    expect(readScheduleHeartbeat(root)).toMatchObject({
      source: "timer",
      last_tick_status: "ok",
      last_tick_at: at(61).toISOString(),
      last_ok_at: at(61).toISOString(),
    });
  });

  test("an activity tick never records a timer time by itself", async () => {
    setup();
    await tick(at(61), fakeLauncher("ok", 30).launcher, {
      source: "activity",
      timerKeepAliveMs: 5,
    });
    expect(readScheduleHeartbeat(root)?.last_timer_tick_at).toBeUndefined();
  });

  test("a busy timer tick records only that the timer fired", async () => {
    setup();
    writeScheduleHeartbeat(root, { at: at(1), source: "activity", status: "ok" });
    const slow = fakeLauncher("ok", 40);
    const running = tick(at(61), slow.launcher, { source: "activity" });
    const busy = await tick(at(62), slow.launcher, { source: "timer" });
    expect(busy.status).toBe("busy");
    expect(readScheduleHeartbeat(root)?.last_timer_tick_at).toBe(at(62).toISOString());
    await running;
    expect(readScheduleHeartbeat(root)).toMatchObject({
      source: "activity",
      last_tick_at: at(61).toISOString(),
      last_timer_tick_at: at(62).toISOString(),
    });
  });

  test("inside a scheduled run's child the tick does nothing and writes nothing", async () => {
    setup();
    const { launcher, calls } = fakeLauncher();
    const r = await tick(at(61), launcher, { env: { HARNERY_SCHEDULE_CHILD: "1" } });
    expect(r.status).toBe("child");
    expect(calls).toHaveLength(0);
    expect(existsSync(scheduleHeartbeatPath(root))).toBe(false);
    expect(existsSync(join(scheduleStateDir(root), "claims"))).toBe(false);
  });

  test("pings the owner when a run needs attention", async () => {
    setup(job({ owner: "agent-Owner" }));
    const pings: { owner: string; message: string }[] = [];
    await tick(at(61), fakeLauncher("attention").launcher, {
      notify: ({ owner, message }) => pings.push({ owner, message }),
    });
    expect(pings).toHaveLength(1);
    expect(pings[0]?.owner).toBe("agent-Owner");
    expect(pings[0]?.message).toContain("ended attention");
    expect(pings[0]?.message).toContain("report.md");
  });

  test("an owner ping that cannot be delivered does not break the tick", async () => {
    setup(job({ owner: "agent-Nobody" }));
    const r = await tick(at(61), fakeLauncher("failed").launcher, { notify: undefined });
    expect(r.status).toBe("ok");
    expect(r.jobs[0]?.launches[0]?.result).toBe("failed");
  });
});

describe("runScheduleJobManually", () => {
  test("runs now as a manual claim without touching the cursor", async () => {
    setup();
    const { launcher, calls } = fakeLauncher();
    const r = await runScheduleJobManually({
      coordRoot: root,
      jobId: "hourly-check",
      now: at(30),
      launcher,
      machine: MACHINE,
      env: {},
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.kind).toBe("manual");
    expect(r.record.scheduled_for).toBe(iso(30));
    expect(readFileSync(r.reportPath, "utf8")).toContain("report");
    expect(calls).toHaveLength(1);
    expect(readScheduleCursor(root, "hourly-check")).toBeNull();
    // The scheduled time still runs later.
    const t = await tick(at(61), launcher);
    expect(t.jobs[0]?.launches.map((l) => l.scheduled_for)).toEqual([iso(60)]);
  });

  test("moves one millisecond on when the instant is already claimed", async () => {
    setup();
    createScheduleClaim({
      coordRoot: root,
      jobId: "hourly-check",
      scheduledFor: iso(30),
      kind: "manual",
      now: at(30),
    });
    const r = await runScheduleJobManually({
      coordRoot: root,
      jobId: "hourly-check",
      now: at(30),
      launcher: fakeLauncher().launcher,
      machine: MACHINE,
      env: {},
    });
    expect(r.ok && r.record.scheduled_for).toBe(new Date(at(30).getTime() + 1).toISOString());
  });

  test("refuses an unknown, unenrolled or over-limit job", async () => {
    const opts = { coordRoot: root, launcher: fakeLauncher().launcher, machine: MACHINE, env: {} };
    expect(await runScheduleJobManually({ ...opts, jobId: "hourly-check" })).toMatchObject({
      ok: false,
    });
    writeJobs([job()]);
    const unenrolled = await runScheduleJobManually({ ...opts, jobId: "hourly-check" });
    expect(unenrolled.ok === false && unenrolled.reason).toContain("not-enrolled");
    const missing = await runScheduleJobManually({ ...opts, jobId: "nope" });
    expect(missing.ok === false && missing.reason).toContain('no job "nope"');

    rmSync(scheduleJobFilePath(root));
    setup(job({ max_launches_per_day: 1 }));
    expect((await runScheduleJobManually({ ...opts, jobId: "hourly-check", now: at(1) })).ok).toBe(
      true,
    );
    const over = await runScheduleJobManually({ ...opts, jobId: "hourly-check", now: at(2) });
    expect(over.ok === false && over.reason).toContain("daily-limit");
  });
});

describe("activity throttle and detached start", () => {
  test("shouldRunActivityTick costs one stat of the heartbeat", () => {
    expect(shouldRunActivityTick(root)).toBe(true);
    writeScheduleHeartbeat(root, { at: new Date(), source: "activity", status: "ok" });
    expect(shouldRunActivityTick(root)).toBe(false);
    const old = new Date(Date.now() - 6 * MIN);
    utimesSync(scheduleHeartbeatPath(root), old, old);
    expect(shouldRunActivityTick(root)).toBe(true);
    expect(shouldRunActivityTick(root, new Date(), 10 * MIN)).toBe(false);
  });

  test("spawnDetachedScheduleTick starts a detached, silent, hidden child", () => {
    const seen: { cmd: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
    let unrefs = 0;
    const spawnImpl = ((cmd: string, args: readonly string[], options: Record<string, unknown>) => {
      seen.push({ cmd, args, options });
      return { once: () => {}, unref: () => unrefs++ };
    }) as unknown as typeof import("node:child_process").spawn;
    expect(spawnDetachedScheduleTick(root, { cliEntry: "/entry.js", spawnImpl })).toEqual({
      launched: true,
    });
    expect(seen[0]?.cmd).toBe(process.execPath);
    expect(seen[0]?.args).toEqual([
      "/entry.js",
      "schedule",
      "tick",
      "--source",
      "activity",
      "--root",
      root,
    ]);
    expect(seen[0]?.options).toMatchObject({
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    expect(unrefs).toBe(1);
  });
});
