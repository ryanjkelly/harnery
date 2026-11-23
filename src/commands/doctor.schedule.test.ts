import { describe, expect, test } from "bun:test";
import type { ScheduleHealth, ScheduleProblem } from "../core/schedule/cue.ts";
import { scheduleDoctorChecks } from "./doctor.ts";

function health(over: Partial<ScheduleHealth> = {}): ScheduleHealth {
  return {
    assessed_at: "2026-11-22T12:00:00.000Z",
    problems: [],
    jobs: [],
    job_file: false,
    heartbeat: null,
    timer: null,
    ...over,
  };
}

const timer = {
  schema_version: 1 as const,
  installed_at: "2026-11-22T00:00:00.000Z",
  interval_minutes: 5,
  unit: "harnery-schedule-abc.timer",
  command: ["harn", "schedule", "tick"],
};

describe("doctor schedule rows", () => {
  test("absent when nothing is set up", () => {
    expect(scheduleDoctorChecks(health(), "harn")).toEqual([]);
  });

  test("a job file without a timer is a neutral note", () => {
    const rows = scheduleDoctorChecks(health({ job_file: true }), "harn");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "schedule clock",
      severity: "info",
      hint: "harn schedule install",
    });
  });

  test("a healthy timer and jobs are ok rows", () => {
    const rows = scheduleDoctorChecks(
      health({ timer, jobs: ["nightly"], job_file: true, unit_state: { status: "active" } }),
      "harn",
    );
    expect(rows.map((r) => `${r.name}:${r.severity}`)).toEqual([
      "schedule clock:ok",
      "schedule runs:ok",
    ]);
  });

  test("clock and run problems are warnings with hints", () => {
    const problems: ScheduleProblem[] = [
      { kind: "timer-overdue", area: "clock", message: "the schedule timer last ticked 2h ago" },
      { kind: "timer-unit", area: "clock", message: "schedule timer x.timer is disabled" },
      {
        kind: "run-failed",
        area: "runs",
        job_id: "nightly",
        message: "scheduled job nightly failed 1h ago",
        report: ".harnery/private/schedule/runs/nightly/20261122T110000000Z/report.md",
      },
      {
        kind: "run-uncertain",
        area: "runs",
        job_id: "check",
        message: "scheduled job check started 3h ago",
      },
    ];
    const rows = scheduleDoctorChecks(
      health({ timer, jobs: ["check", "nightly"], problems }),
      "harn",
    );
    expect(rows.map((r) => `${r.name}:${r.severity}`)).toEqual([
      "schedule clock:warn",
      "schedule runs:warn",
    ]);
    expect(rows[0]?.detail).toContain("last ticked 2h ago");
    expect(rows[0]?.detail).toContain("is disabled");
    expect(rows[1]?.hint).toContain("harn schedule history nightly");
    expect(rows[1]?.hint).toContain("report.md");
    expect(rows[1]?.hint).toContain("harn schedule history check");
  });
});
