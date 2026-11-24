import { describe, expect, test } from "bun:test";
import {
  cleanTitle,
  commonHost,
  coverageGaps,
  coverageLabel,
  describeCron,
  describeRrule,
  describeSystemdCalendar,
  fileViewerHref,
  formatInterval,
  formatRunDuration,
  formatTrigger,
  groupSchedules,
  problemRank,
  relativeLabel,
  type ScheduleRecord,
  type ScheduleSourceCoverage,
  scheduleState,
  shortZone,
  sortSchedules,
  sourceLabel,
} from "./schedules";

describe("formatInterval", () => {
  test("picks the largest whole unit", () => {
    expect(formatInterval(300_000)).toBe("Every 5 min");
    expect(formatInterval(1_800_000)).toBe("Every 30 min");
    expect(formatInterval(60_000)).toBe("Every minute");
    expect(formatInterval(3_600_000)).toBe("Every hour");
    expect(formatInterval(7_200_000)).toBe("Every 2 hours");
    expect(formatInterval(86_400_000)).toBe("Every day");
    expect(formatInterval(90_000)).toBe("Every 90 sec");
    expect(formatInterval(1_500)).toBe("Every 1500 ms");
  });
});

describe("describeCron", () => {
  test("daily times", () => {
    expect(describeCron("50 6,13 * * *")).toBe("Daily at 6:50 AM and 1:50 PM");
    expect(describeCron("0 0 * * *")).toBe("Daily at 12:00 AM");
  });
  test("steps and hourly", () => {
    expect(describeCron("*/5 * * * *")).toBe("Every 5 min");
    expect(describeCron("*/1 * * * *")).toBe("Every minute");
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("0 */2 * * *")).toBe("Every 2 hours");
    expect(describeCron("15 */3 * * *")).toBe("Every 3 hours at :15");
    expect(describeCron("30 * * * *")).toBe("Hourly at :30");
    expect(describeCron("0 * * * *")).toBe("Every hour");
  });
  test("days of the week", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 9:00 AM");
    expect(describeCron("0 10 * * 0,6")).toBe("Weekends at 10:00 AM");
    expect(describeCron("0 10 * * 6,7")).toBe("Weekends at 10:00 AM");
    expect(describeCron("30 8 * * mon,wed,fri")).toBe("Monday, Wednesday and Friday at 8:30 AM");
    expect(describeCron("0 18 * * 0")).toBe("Sundays at 6:00 PM");
    expect(describeCron("0 9 1 * *")).toBe("Monthly on day 1 at 9:00 AM");
  });
  test("leaves what it cannot read faithfully", () => {
    expect(describeCron("0 25 * * *")).toBeNull();
    expect(describeCron("0 9 * *")).toBeNull();
    expect(describeCron("0 9 * 1 *")).toBeNull();
    expect(describeCron("5-10 9 * * *")).toBeNull();
    expect(describeCron("*/5 * * * 1-5")).toBeNull();
  });
});

describe("describeSystemdCalendar", () => {
  test("clock-aligned steps", () => {
    expect(describeSystemdCalendar("*-*-* *:00/5:00")).toBe("Every 5 min on the clock");
    expect(describeSystemdCalendar("*-*-* *:0/15")).toBe("Every 15 min on the clock");
    expect(describeSystemdCalendar("*-*-* 00/2:00:00")).toBe("Every 2 hours on the clock");
    expect(describeSystemdCalendar("*-*-* *:00:00")).toBe("Every hour on the hour");
  });
  test("daily and weekday times", () => {
    expect(describeSystemdCalendar("*-*-* 06:00:00")).toBe("Daily at 6:00 AM");
    expect(describeSystemdCalendar("Mon..Fri *-*-* 09:00:00")).toBe("Weekdays at 9:00 AM");
    expect(describeSystemdCalendar("Sat,Sun 10:30")).toBe("Weekends at 10:30 AM");
    expect(describeSystemdCalendar("*-*-* 06,18:00:00")).toBe("Daily at 6:00 AM and 6:00 PM");
  });
  test("shorthands", () => {
    expect(describeSystemdCalendar("daily")).toBe("Daily at 12:00 AM");
    expect(describeSystemdCalendar("hourly")).toBe("Every hour");
    expect(describeSystemdCalendar("weekly")).toBe("Mondays at 12:00 AM");
  });
  test("anything else is null", () => {
    expect(describeSystemdCalendar("2026-01-01 06:00:00")).toBeNull();
    expect(describeSystemdCalendar("*-*-* 06:00:30")).toBeNull();
    expect(describeSystemdCalendar("*-*-* 06:00:00 Europe/Paris")).toBeNull();
  });
});

describe("describeRrule", () => {
  test("minutely and hourly", () => {
    expect(describeRrule("FREQ=MINUTELY;INTERVAL=1")).toBe("Every minute");
    expect(describeRrule("FREQ=MINUTELY;INTERVAL=5")).toBe("Every 5 min");
    expect(describeRrule("RRULE:FREQ=HOURLY;INTERVAL=2")).toBe("Every 2 hours");
    expect(describeRrule("FREQ=HOURLY;BYMINUTE=15")).toBe("Every hour at :15");
  });
  test("daily and weekly", () => {
    expect(describeRrule("FREQ=DAILY")).toBe("Daily");
    expect(describeRrule("FREQ=DAILY;BYHOUR=7;BYMINUTE=30")).toBe("Daily at 7:30 AM");
    expect(describeRrule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0")).toBe(
      "Weekdays at 9:00 AM",
    );
    expect(describeRrule("FREQ=WEEKLY;BYDAY=MO")).toBe("Mondays");
    expect(describeRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR")).toBe("Every 2 weeks on Fridays");
  });
  test("unreadable rules are null", () => {
    expect(describeRrule("FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR")).toBeNull();
    expect(describeRrule("not a rule")).toBeNull();
  });
});

test("shortZone", () => {
  expect(shortZone("America/Chicago")).toBe("CT");
  expect(shortZone("Etc/UTC")).toBe("UTC");
  expect(shortZone("Not/A_Zone")).toBe("A Zone");
});

describe("formatTrigger", () => {
  test("cron keeps a short zone and its raw text", () => {
    const t = formatTrigger({
      kind: "cron",
      expr: "50 6,13 * * *",
      zone: "America/Chicago",
      raw: "R",
    });
    expect(t).toEqual({ text: "Daily at 6:50 AM and 1:50 PM CT", icon: "calendar", raw: "R" });
    expect(formatTrigger({ kind: "cron", expr: "0 9 * 1 *", raw: "" })).toEqual({
      text: "Custom schedule",
      icon: "calendar",
      raw: "0 9 * 1 *",
      custom: true,
    });
  });
  test("interval, once and rrule", () => {
    expect(formatTrigger({ kind: "interval", everyMs: 600_000, raw: "x" })).toEqual({
      text: "Every 10 min",
      icon: "repeat",
      raw: "x",
    });
    expect(formatTrigger({ kind: "once", at: "2026-01-01T06:00:00Z", raw: "" })).toEqual({
      text: "Once",
      icon: "once",
      at: "2026-01-01T06:00:00Z",
      raw: "",
    });
    expect(formatTrigger({ kind: "rrule", rule: "FREQ=MINUTELY;INTERVAL=5", raw: "" }).text).toBe(
      "Every 5 min",
    );
  });
  test("events", () => {
    const ev = (description: string) => formatTrigger({ kind: "event", description, raw: "r" });
    expect(ev("calendar: *-*-* *:00/5:00")).toEqual({
      text: "Every 5 min on the clock",
      icon: "calendar",
      raw: "r",
    });
    expect(ev("calendar: *-*-* 06:00:00; Mon..Fri *-*-* 09:00:00").text).toBe(
      "Daily at 6:00 AM; Weekdays at 9:00 AM",
    );
    expect(ev("calendar: *-*-* 06:00:00; 2026-01-01").text).toBe("Custom schedule");
    expect(ev("webhook")).toEqual({ text: "On webhook", icon: "event", raw: "r" });
    expect(ev("cron macro: @reboot")).toEqual({ text: "On startup", icon: "event", raw: "r" });
    expect(ev("cron macro: @daily").text).toBe("Daily at 12:00 AM");
    expect(ev("after boot: 5min").text).toBe("Once after startup");
    expect(ev("something new")).toEqual({
      text: "Custom schedule",
      icon: "event",
      raw: "r",
      custom: true,
    });
  });
});

describe("source names and titles", () => {
  test("system timers name their kind", () => {
    expect(sourceLabel({ source: "os-timer", id: "systemd-user:a.timer" })).toBe("Systemd timer");
    expect(sourceLabel({ source: "os-timer", id: "crontab:3" })).toBe("Cron");
    expect(sourceLabel({ source: "os-timer", id: "other" })).toBe("System timer");
    expect(sourceLabel({ source: "codex-app", id: "x" })).toBe("Codex");
    expect(sourceLabel({ source: "captured", id: "x" })).toBe("Seen by Harnery");
  });
  test("systemd suffixes are dropped", () => {
    const id = "systemd-user:dev-heal.timer";
    expect(cleanTitle({ source: "os-timer", id, title: "dev-heal.timer" })).toBe("dev-heal");
    expect(cleanTitle({ source: "os-timer", id, title: "x.service" })).toBe("x");
    expect(cleanTitle({ source: "harnery", id: "a", title: "Job.timer" })).toBe("Job.timer");
    expect(cleanTitle({ source: "harnery", id: "a", title: "" })).toBe("a");
  });
});

const base: ScheduleRecord = {
  source: "os-timer",
  account: "host-a",
  id: "x",
  title: "x",
  trigger: { kind: "interval", everyMs: 60_000, raw: "" },
  runs_on: { host: "host-a" },
  enabled: true,
  next_run_at: null,
  last_run: null,
  created_by: null,
};
const rec = (over: Partial<ScheduleRecord>): ScheduleRecord => ({ ...base, ...over });
const NOW = Date.parse("2026-01-01T12:00:00Z");

describe("sortSchedules", () => {
  test("failed, then attention, then by next run with none last", () => {
    const sorted = sortSchedules([
      rec({ title: "later", next_run_at: "2026-01-02T00:00:00Z" }),
      rec({ title: "no-next" }),
      rec({ title: "attn", last_run: { at: null, status: "attention" } }),
      rec({ title: "soon", next_run_at: "2026-01-01T00:00:00Z" }),
      rec({ title: "failed", last_run: { at: null, status: "failed" } }),
    ]);
    expect(sorted.map((r) => r.title)).toEqual(["failed", "attn", "soon", "later", "no-next"]);
  });
  test("ties break by title and the input is not mutated", () => {
    const input = [rec({ title: "b" }), rec({ title: "a" })];
    expect(sortSchedules(input).map((r) => r.title)).toEqual(["a", "b"]);
    expect(input.map((r) => r.title)).toEqual(["b", "a"]);
  });
  test("problemRank", () => {
    expect(problemRank({ last_run: { at: null, status: "failed" } })).toBe(0);
    expect(problemRank({ last_run: { at: null, status: "attention" } })).toBe(1);
    expect(problemRank({ last_run: { at: null, status: "skipped" } })).toBe(2);
    expect(problemRank({ last_run: null })).toBe(2);
  });
});

describe("scheduleState and groupSchedules", () => {
  test("states", () => {
    expect(scheduleState(rec({}), NOW)).toBe("active");
    expect(scheduleState(rec({ enabled: null }), NOW)).toBe("active");
    expect(scheduleState(rec({ enabled: false }), NOW)).toBe("paused");
    expect(
      scheduleState(rec({ enabled: false, last_run: { at: null, status: "failed" } }), NOW),
    ).toBe("paused");
    expect(scheduleState(rec({ last_run: { at: null, status: "failed" } }), NOW)).toBe("failed");
    const once = (at: string) => rec({ trigger: { kind: "once", at, raw: "" } });
    expect(scheduleState(once("2025-12-01T00:00:00Z"), NOW)).toBe("finished");
    expect(scheduleState(once("2026-02-01T00:00:00Z"), NOW)).toBe("active");
  });
  test("sections", () => {
    const groups = groupSchedules(
      [
        rec({ title: "a", next_run_at: "2026-01-01T13:00:00Z" }),
        rec({ title: "p", enabled: false }),
        rec({ title: "f", last_run: { at: null, status: "failed" } }),
        rec({ title: "t", last_run: { at: null, status: "attention" } }),
        rec({ title: "b", next_run_at: "2026-01-01T12:30:00Z" }),
        rec({ title: "n" }),
      ],
      NOW,
    );
    expect(groups.attention.map((r) => r.title)).toEqual(["f", "t"]);
    expect(groups.active.map((r) => r.title)).toEqual(["b", "a", "n"]);
    expect(groups.inactive.map((r) => r.title)).toEqual(["p"]);
  });
  test("commonHost", () => {
    const h = (host: string) => rec({ runs_on: { host } });
    expect(commonHost([h("a"), h("b"), h("b")])).toBe("b");
    expect(commonHost([])).toBeNull();
  });
});

test("relativeLabel", () => {
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  expect(relativeLabel(at(4 * 60_000), NOW)).toBe("in 4 min");
  expect(relativeLabel(at(-3 * 60_000), NOW)).toBe("3 min ago");
  expect(relativeLabel(at(20_000), NOW)).toBe("in under a min");
  expect(relativeLabel(at(-20_000), NOW)).toBe("just now");
  expect(relativeLabel(at(80 * 60_000), NOW)).toBe("in 1 hr 20 min");
  expect(relativeLabel(at(-8.4 * 3_600_000), NOW)).toBe("8 hr ago");
  expect(relativeLabel(at(-3 * 86_400_000), NOW)).toBe("3 days ago");
  expect(relativeLabel("nope", NOW)).toBe("");
});

describe("coverage", () => {
  const cov = (
    state: ScheduleSourceCoverage["state"],
    detail?: string,
  ): ScheduleSourceCoverage => ({
    source: "t3-code",
    account: "a",
    state,
    detail,
    read_at: "2026-01-01T00:00:00Z",
  });
  test("labels", () => {
    expect(coverageLabel(cov("unsupported", "The store was not found."))).toBe("not installed");
    expect(coverageLabel(cov("unsupported", "Unknown layout."))).toBe("not supported here");
    expect(coverageLabel(cov("disabled"))).toBe("switched off");
    expect(coverageLabel(cov("stale"))).toBe("may be out of date");
  });
  test("gaps exclude current and unsupported", () => {
    const gaps = coverageGaps([
      cov("current"),
      cov("unsupported"),
      cov("stale"),
      cov("unreadable"),
      cov("disabled"),
    ]);
    expect(gaps.map((c) => c.state)).toEqual(["stale", "unreadable", "disabled"]);
  });
});

describe("formatRunDuration", () => {
  test("seconds, minutes, hours", () => {
    expect(formatRunDuration(46_689)).toBe("47s");
    expect(formatRunDuration(192_000)).toBe("3m 12s");
    expect(formatRunDuration(3_900_000)).toBe("1h 5m");
    expect(formatRunDuration(null)).toBe("");
  });
});

test("fileViewerHref encodes the path", () => {
  expect(fileViewerHref(".harnery/private/runs/a b/report.md")).toBe(
    "/files?path=.harnery%2Fprivate%2Fruns%2Fa%20b%2Freport.md",
  );
});
