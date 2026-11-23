import { describe, expect, test } from "bun:test";
import type { ScheduleJobTrigger } from "./job-types.ts";
import { parseScheduleCron, scheduleDueTimes, scheduleNextDueTime } from "./triggers.ts";

const ms = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString();
const cron = (expr: string): ScheduleJobTrigger => ({ type: "cron", expr });

function due(
  trigger: ScheduleJobTrigger,
  zone: string,
  after: string,
  until: string,
  extra: { enrolled?: string; limit?: number } = {},
) {
  const r = scheduleDueTimes(trigger, {
    zone,
    enrolledAtMs: ms(extra.enrolled ?? "2000-01-01T00:00:00Z"),
    afterMs: ms(after),
    untilMs: ms(until),
    ...(extra.limit !== undefined ? { limit: extra.limit } : {}),
  });
  return { times: r.times.map(iso), capped: r.capped };
}

describe("parseScheduleCron", () => {
  test("lists, ranges, steps and Sunday as 7", () => {
    const s = parseScheduleCron("0,30 9-11 1-5/2 */6 7");
    expect(s.minutes).toEqual([0, 30]);
    expect(s.hours).toEqual([9, 10, 11]);
    expect([...s.daysOfMonth].sort((a, b) => a - b)).toEqual([1, 3, 5]);
    expect([...s.months].sort((a, b) => a - b)).toEqual([1, 7]);
    expect([...s.daysOfWeek]).toEqual([0]);
    expect(s.domRestricted).toBe(true);
    expect(s.dowRestricted).toBe(true);
  });
  test("a start with a step runs to the end of the range", () => {
    expect(parseScheduleCron("50/5 * * * *").minutes).toEqual([50, 55]);
  });
  test("rejects a bad expression", () => {
    expect(() => parseScheduleCron("0 0 * *")).toThrow();
    expect(() => parseScheduleCron("60 0 * * *")).toThrow();
  });
});

describe("cron in a zone", () => {
  test("*/15 in UTC", () => {
    const r = due(cron("*/15 * * * *"), "UTC", "2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z");
    expect(r.times).toEqual([
      "2026-01-01T00:15:00.000Z",
      "2026-01-01T00:30:00.000Z",
      "2026-01-01T00:45:00.000Z",
      "2026-01-01T01:00:00.000Z",
    ]);
    expect(r.capped).toBe(false);
  });

  test("lists and ranges in America/Chicago (CST is UTC-6)", () => {
    const r = due(
      cron("0,30 9-10 * * 1-5"),
      "America/Chicago",
      "2026-01-09T00:00:00Z", // Friday
      "2026-01-13T00:00:00Z", // Tuesday
    );
    expect(r.times).toEqual([
      "2026-01-09T15:00:00.000Z",
      "2026-01-09T15:30:00.000Z",
      "2026-01-09T16:00:00.000Z",
      "2026-01-09T16:30:00.000Z",
      "2026-01-12T15:00:00.000Z",
      "2026-01-12T15:30:00.000Z",
      "2026-01-12T16:00:00.000Z",
      "2026-01-12T16:30:00.000Z",
    ]);
  });

  test("spring forward: 02:30 on 2026-03-08 runs once, at 03:00 local", () => {
    const r = due(
      cron("30 2 * * *"),
      "America/Chicago",
      "2026-03-07T00:00:00Z",
      "2026-03-10T00:00:00Z",
    );
    expect(r.times).toEqual([
      "2026-03-07T08:30:00.000Z", // 02:30 CST
      "2026-03-08T08:00:00.000Z", // skipped; 03:00 CDT
      "2026-03-09T07:30:00.000Z", // 02:30 CDT
    ]);
  });

  test("spring forward: several skipped minutes and 03:00 itself run once", () => {
    const r = due(
      cron("0,30 2,3 8 3 *"),
      "America/Chicago",
      "2026-03-08T00:00:00Z",
      "2026-03-09T00:00:00Z",
    );
    expect(r.times).toEqual(["2026-03-08T08:00:00.000Z", "2026-03-08T08:30:00.000Z"]);
  });

  test("fall back: 01:30 on 2026-11-01 runs once, at the first 01:30", () => {
    const r = due(
      cron("30 1 * * *"),
      "America/Chicago",
      "2026-10-31T00:00:00Z",
      "2026-11-03T00:00:00Z",
    );
    expect(r.times).toEqual([
      "2026-10-31T06:30:00.000Z", // 01:30 CDT
      "2026-11-01T06:30:00.000Z", // first 01:30, CDT; the CST repeat at 07:30Z does not run
      "2026-11-02T07:30:00.000Z", // 01:30 CST
    ]);
  });

  test("half-hour offset: Asia/Kolkata is UTC+5:30", () => {
    const r = due(
      cron("0 9 * * *"),
      "Asia/Kolkata",
      "2026-05-01T00:00:00Z",
      "2026-05-03T00:00:00Z",
    );
    expect(r.times).toEqual(["2026-05-01T03:30:00.000Z", "2026-05-02T03:30:00.000Z"]);
  });

  test("day of month and day of week both restricted: either fires", () => {
    // The 1st of the month, or any Monday. June 2026: Mondays are 1, 8, 15, 22, 29.
    const r = due(cron("0 12 1 * 1"), "UTC", "2026-06-01T00:00:00Z", "2026-07-02T00:00:00Z");
    expect(r.times.map((t) => t.slice(0, 10))).toEqual([
      "2026-06-01",
      "2026-06-08",
      "2026-06-15",
      "2026-06-22",
      "2026-06-29",
      "2026-07-01",
    ]);
  });

  test("only one of them restricted: both must match", () => {
    const r = due(cron("0 12 * * 1"), "UTC", "2026-06-01T00:00:00Z", "2026-06-15T00:00:00Z");
    expect(r.times.map((t) => t.slice(0, 10))).toEqual(["2026-06-01", "2026-06-08"]);
  });

  test("the 31st never fires in a 30-day month", () => {
    const r = due(cron("0 0 31 * *"), "UTC", "2026-03-01T00:00:00Z", "2026-08-01T00:00:00Z");
    expect(r.times.map((t) => t.slice(0, 10))).toEqual(["2026-03-31", "2026-05-31", "2026-07-31"]);
  });

  test("a leap day", () => {
    const r = due(cron("0 0 29 2 *"), "UTC", "2026-01-01T00:00:00Z", "2033-01-01T00:00:00Z");
    expect(r.times).toEqual(["2028-02-29T00:00:00.000Z", "2032-02-29T00:00:00.000Z"]);
    expect(
      iso(
        scheduleNextDueTime(cron("0 0 29 2 *"), {
          zone: "UTC",
          enrolledAtMs: 0,
          afterMs: ms("2028-03-01T00:00:00Z"),
        }) as number,
      ),
    ).toBe("2032-02-29T00:00:00.000Z");
  });

  test("a date that never exists has no next time", () => {
    expect(
      scheduleNextDueTime(cron("0 0 31 2 *"), {
        zone: "UTC",
        enrolledAtMs: 0,
        afterMs: ms("2026-01-01T00:00:00Z"),
      }),
    ).toBeNull();
  });

  test("a seven-day window of every minute stays cheap and is capped to the newest", () => {
    const started = performance.now();
    const r = due(
      cron("* * * * *"),
      "America/Chicago",
      "2026-11-01T00:00:00Z",
      "2026-11-08T00:00:00Z",
    );
    expect(r.capped).toBe(true);
    expect(r.times).toHaveLength(1000);
    expect(r.times[999]).toBe("2026-11-08T00:00:00.000Z");
    expect(r.times[0]).toBe("2026-11-07T07:21:00.000Z");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("the bounds: after is exclusive, until is inclusive", () => {
    const r = due(cron("0 * * * *"), "UTC", "2026-01-01T00:00:00Z", "2026-01-01T02:00:00Z");
    expect(r.times).toEqual(["2026-01-01T01:00:00.000Z", "2026-01-01T02:00:00.000Z"]);
  });

  test("nothing before enrollment", () => {
    const r = due(cron("0 * * * *"), "UTC", "2026-01-01T00:00:00Z", "2026-01-01T05:00:00Z", {
      enrolled: "2026-01-01T03:00:00Z",
    });
    expect(r.times).toEqual([
      "2026-01-01T03:00:00.000Z",
      "2026-01-01T04:00:00.000Z",
      "2026-01-01T05:00:00.000Z",
    ]);
  });

  test("next due time in a zone", () => {
    const next = scheduleNextDueTime(cron("0 9 * * *"), {
      zone: "America/Chicago",
      enrolledAtMs: 0,
      afterMs: ms("2026-11-22T16:00:00Z"),
    });
    expect(iso(next as number)).toBe("2026-11-23T15:00:00.000Z");
  });
});

describe("every", () => {
  const enrolled = "2026-01-01T00:07:00Z";
  test("counts from enrollment, not from the clock", () => {
    const r = due(
      { type: "every", minutes: 30 },
      "UTC",
      "2026-01-01T00:00:00Z",
      "2026-01-01T01:40:00Z",
      {
        enrolled,
      },
    );
    expect(r.times).toEqual([
      "2026-01-01T00:37:00.000Z",
      "2026-01-01T01:07:00.000Z",
      "2026-01-01T01:37:00.000Z",
    ]);
  });
  test("the enrollment instant itself is not a due time", () => {
    const r = due({ type: "every", minutes: 30 }, "UTC", "2026-01-01T00:00:00Z", enrolled, {
      enrolled,
    });
    expect(r.times).toEqual([]);
  });
  test("a cap keeps the newest", () => {
    const r = due(
      { type: "every", minutes: 5 },
      "UTC",
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z",
      {
        enrolled: "2026-01-01T00:00:00Z",
        limit: 3,
      },
    );
    expect(r.capped).toBe(true);
    expect(r.times).toEqual([
      "2026-01-01T23:50:00.000Z",
      "2026-01-01T23:55:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ]);
  });
  test("next due time", () => {
    const next = scheduleNextDueTime(
      { type: "every", minutes: 30 },
      { zone: "UTC", enrolledAtMs: ms(enrolled), afterMs: ms("2026-01-01T01:07:00Z") },
    );
    expect(iso(next as number)).toBe("2026-01-01T01:37:00.000Z");
    const first = scheduleNextDueTime(
      { type: "every", minutes: 30 },
      { zone: "UTC", enrolledAtMs: ms(enrolled), afterMs: 0 },
    );
    expect(iso(first as number)).toBe("2026-01-01T00:37:00.000Z");
  });
});

describe("once", () => {
  const trigger: ScheduleJobTrigger = { type: "once", at: "2026-06-01T12:00:00-05:00" };
  test("due inside the window", () => {
    expect(due(trigger, "UTC", "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z").times).toEqual([
      "2026-06-01T17:00:00.000Z",
    ]);
  });
  test("not due when it is before enrollment", () => {
    expect(
      due(trigger, "UTC", "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z", {
        enrolled: "2026-06-01T18:00:00Z",
      }).times,
    ).toEqual([]);
  });
  test("due when enrolled at the same instant", () => {
    expect(
      due(trigger, "UTC", "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z", {
        enrolled: "2026-06-01T17:00:00Z",
      }).times,
    ).toEqual(["2026-06-01T17:00:00.000Z"]);
  });
  test("next is null once past", () => {
    expect(
      scheduleNextDueTime(trigger, {
        zone: "UTC",
        enrolledAtMs: 0,
        afterMs: ms("2026-06-01T17:00:00Z"),
      }),
    ).toBeNull();
    expect(
      scheduleNextDueTime(trigger, {
        zone: "UTC",
        enrolledAtMs: 0,
        afterMs: ms("2026-06-01T16:59:59Z"),
      }),
    ).toBe(ms("2026-06-01T17:00:00Z"));
  });
});
