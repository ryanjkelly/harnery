import { describe, expect, test } from "bun:test";
import {
  describeDailyCron,
  fileViewerHref,
  formatInterval,
  formatRunDuration,
  formatTrigger,
  problemRank,
  type ScheduleRecord,
  sortSchedules,
} from "./schedules";

describe("formatInterval", () => {
  test("picks the largest whole unit", () => {
    expect(formatInterval(300_000)).toBe("every 5 min");
    expect(formatInterval(60_000)).toBe("every 1 min");
    expect(formatInterval(7_200_000)).toBe("every 2 hours");
    expect(formatInterval(86_400_000)).toBe("every day");
    expect(formatInterval(90_000)).toBe("every 90 sec");
    expect(formatInterval(1_500)).toBe("every 1500 ms");
  });
});

describe("describeDailyCron", () => {
  test("reads a daily cron with one or more hours", () => {
    expect(describeDailyCron("50 6,13 * * *")).toBe("daily at 6:50 AM and 1:50 PM");
    expect(describeDailyCron("0 0 * * *")).toBe("daily at 12:00 AM");
  });
  test("leaves anything else alone", () => {
    expect(describeDailyCron("*/5 * * * *")).toBeNull();
    expect(describeDailyCron("0 9 * * 1-5")).toBeNull();
    expect(describeDailyCron("0 25 * * *")).toBeNull();
    expect(describeDailyCron("0 9 * *")).toBeNull();
  });
});

describe("formatTrigger", () => {
  test("cron keeps its zone and raw text", () => {
    const t = formatTrigger({ kind: "cron", expr: "50 6,13 * * *", zone: "Etc/UTC", raw: "R" });
    expect(t).toEqual({ text: "daily at 6:50 AM and 1:50 PM (Etc/UTC)", raw: "R" });
    expect(formatTrigger({ kind: "cron", expr: "*/5 * * * *", raw: "" }).text).toBe(
      "cron */5 * * * *",
    );
  });
  test("other kinds", () => {
    expect(formatTrigger({ kind: "interval", everyMs: 600_000, raw: "x" }).text).toBe(
      "every 10 min",
    );
    expect(formatTrigger({ kind: "once", at: "2026-01-01T06:00:00Z", raw: "" })).toEqual({
      text: "once at",
      at: "2026-01-01T06:00:00Z",
      raw: "",
    });
    expect(formatTrigger({ kind: "rrule", rule: "RRULE:FREQ=DAILY", raw: "" }).text).toBe(
      "FREQ=DAILY",
    );
    expect(formatTrigger({ kind: "event", description: "on boot", raw: "" }).text).toBe("on boot");
  });
});

type SortInput = Pick<ScheduleRecord, "last_run" | "next_run_at" | "title">;
const rec = (
  title: string,
  next: string | null,
  status?: NonNullable<ScheduleRecord["last_run"]>["status"],
): SortInput => ({
  title,
  next_run_at: next,
  last_run: status ? { at: null, status } : null,
});

describe("sortSchedules", () => {
  test("failed, then attention, then by next run with none last", () => {
    const sorted = sortSchedules([
      rec("later", "2026-01-02T00:00:00Z", "succeeded"),
      rec("no-next", null),
      rec("attn", "2026-01-03T00:00:00Z", "attention"),
      rec("soon", "2026-01-01T00:00:00Z"),
      rec("failed", null, "failed"),
    ]);
    expect(sorted.map((r) => r.title)).toEqual(["failed", "attn", "soon", "later", "no-next"]);
  });
  test("ties break by title and the input is not mutated", () => {
    const input = [rec("b", null), rec("a", null)];
    expect(sortSchedules(input).map((r) => r.title)).toEqual(["a", "b"]);
    expect(input.map((r) => r.title)).toEqual(["b", "a"]);
  });
  test("problemRank", () => {
    expect(problemRank(rec("x", null, "failed"))).toBe(0);
    expect(problemRank(rec("x", null, "attention"))).toBe(1);
    expect(problemRank(rec("x", null, "skipped"))).toBe(2);
    expect(problemRank(rec("x", null))).toBe(2);
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
