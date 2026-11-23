/**
 * When a scheduler job is due. Pure functions over epoch milliseconds: no
 * file, process or clock access, and nothing beyond `Intl` for time zones.
 *
 * Rules (see `ScheduleJobTrigger`):
 * - `once`: due at its instant, if that is at or after enrollment.
 * - `every`: due at `enrolledAtMs + k * minutes` for k >= 1.
 * - `cron`: 5-field semantics in the job's IANA zone. When both day of month
 *   and day of week are restricted (the field does not start with `*`), a day
 *   matching either one fires. A day of week of 7 means Sunday, like 0.
 *   A local time that a clock change skips runs once, at the first valid
 *   minute after the gap; a local time that repeats runs once, at its first
 *   occurrence.
 *
 * Cron times are found by stepping one local day at a time and computing the
 * candidate minutes of that day, so a long window costs one step per day.
 */

import type { ScheduleJobTrigger } from "./job-types.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Default cap on the number of due times one call returns. */
export const SCHEDULE_DUE_TIMES_LIMIT = 1000;

/** How far ahead `scheduleNextDueTime` looks for a cron match: covers a leap day on a given weekday. */
const CRON_NEXT_SEARCH_DAYS = 366 * 29;

// ---------------------------------------------------------------------------
// Cron parsing
// ---------------------------------------------------------------------------

/** A parsed 5-field cron expression. */
export interface ScheduleCronSpec {
  minutes: readonly number[];
  hours: readonly number[];
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 to 6, Sunday is 0 (a 7 in the expression is folded into 0). */
  daysOfWeek: ReadonlySet<number>;
  /** The day-of-month field does not start with `*`. */
  domRestricted: boolean;
  /** The day-of-week field does not start with `*`. */
  dowRestricted: boolean;
}

const FIELD_RANGES: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(field: string, min: number, max: number): number[] {
  const out = new Set<number>();
  for (const item of field.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
    if (!m) throw new Error(`bad cron item "${item}"`);
    let lo = min;
    let hi = max;
    if (m[2] !== undefined) {
      lo = Number(m[2]);
      // `5/15` means from 5 to the end of the range in steps of 15.
      hi = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
    }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (lo < min || hi > max || hi < lo || step < 1) throw new Error(`bad cron item "${item}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Parse a 5-field cron expression (minute hour day-of-month month
 * day-of-week). Throws on an expression `scheduleCronErrors` rejects.
 */
export function parseScheduleCron(expr: string): ScheduleCronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron expression needs 5 fields: "${expr}"`);
  const parsed = fields.map((f, i) => {
    const range = FIELD_RANGES[i] as [number, number];
    return parseField(f, range[0], range[1]);
  });
  return {
    minutes: parsed[0] as number[],
    hours: parsed[1] as number[],
    daysOfMonth: new Set(parsed[2]),
    months: new Set(parsed[3]),
    daysOfWeek: new Set((parsed[4] as number[]).map((d) => (d === 7 ? 0 : d))),
    domRestricted: !(fields[2] as string).startsWith("*"),
    dowRestricted: !(fields[4] as string).startsWith("*"),
  };
}

function cronDayMatches(spec: ScheduleCronSpec, month: number, day: number, dow: number): boolean {
  if (!spec.months.has(month)) return false;
  const domOk = spec.daysOfMonth.has(day);
  const dowOk = spec.daysOfWeek.has(dow);
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

// ---------------------------------------------------------------------------
// Zone arithmetic
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, f);
  }
  return f;
}

interface LocalFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localFields(ms: number, zone: string): LocalFields {
  const out: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year as number,
    month: out.month as number,
    day: out.day as number,
    hour: (out.hour as number) % 24,
    minute: out.minute as number,
    second: out.second as number,
  };
}

/** The zone's offset from UTC at an instant, in ms (local minus UTC). */
function offsetAt(ms: number, zone: string): number {
  const f = localFields(ms, zone);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The instant of a local wall-clock minute (given as `wall`, the same fields
 * read as UTC). A repeated minute gives its first occurrence; a skipped
 * minute gives the first valid instant after the gap (the clock change).
 */
function wallToInstant(wall: number, zone: string): number {
  const lo = wall - DAY_MS;
  const hi = wall + DAY_MS;
  const offBefore = offsetAt(lo, zone);
  const offAfter = offsetAt(hi, zone);
  const valid: number[] = [];
  for (const off of offBefore === offAfter ? [offBefore] : [offBefore, offAfter]) {
    const t = wall - off;
    if (offsetAt(t, zone) === off) valid.push(t);
  }
  if (valid.length > 0) return Math.min(...valid);
  // A skipped wall time: find the first minute that has the later offset.
  let a = Math.floor(lo / MINUTE_MS);
  let b = Math.ceil(hi / MINUTE_MS);
  while (b - a > 1) {
    const mid = Math.floor((a + b) / 2);
    if (offsetAt(mid * MINUTE_MS, zone) === offBefore) a = mid;
    else b = mid;
  }
  return b * MINUTE_MS;
}

/** Due instants on one local calendar day (`dayIndex` = days since 1970-01-01), ascending. */
function cronTimesOnDay(spec: ScheduleCronSpec, zone: string, dayIndex: number): number[] {
  const date = new Date(dayIndex * DAY_MS);
  const month = date.getUTCMonth() + 1;
  if (!cronDayMatches(spec, month, date.getUTCDate(), date.getUTCDay())) return [];
  const seen = new Set<number>();
  for (const h of spec.hours) {
    for (const m of spec.minutes) {
      seen.add(wallToInstant(dayIndex * DAY_MS + h * HOUR_MS + m * MINUTE_MS, zone));
    }
  }
  return [...seen].sort((a, b) => a - b);
}

function localDayIndex(ms: number, zone: string): number {
  const f = localFields(ms, zone);
  return Math.floor(Date.UTC(f.year, f.month - 1, f.day) / DAY_MS);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScheduleDueTimesOptions {
  /** IANA zone for `cron`, from `resolveTimeZone()`. */
  zone: string;
  /** Nothing before this instant is ever due; `every` counts from it. */
  enrolledAtMs: number;
  /** Exclusive lower bound. */
  afterMs: number;
  /** Inclusive upper bound. */
  untilMs: number;
  /** At most this many times are returned, the newest ones. Default 1000. */
  limit?: number;
}

export interface ScheduleDueTimes {
  /** Due instants (epoch ms), ascending. */
  times: number[];
  /** True when more times were due than `limit`; only the newest were kept. */
  capped: boolean;
}

/**
 * Every due instant t with `afterMs < t <= untilMs` and `t >= enrolledAtMs`,
 * ascending. When more than `limit` are due, the newest `limit` are returned
 * and `capped` is true.
 */
export function scheduleDueTimes(
  trigger: ScheduleJobTrigger,
  opts: ScheduleDueTimesOptions,
): ScheduleDueTimes {
  const limit = Math.max(0, Math.floor(opts.limit ?? SCHEDULE_DUE_TIMES_LIMIT));
  const lower = Math.max(opts.afterMs, opts.enrolledAtMs - 1); // exclusive
  const upper = opts.untilMs;
  if (upper <= lower) return { times: [], capped: false };

  switch (trigger.type) {
    case "once": {
      const at = Date.parse(trigger.at);
      if (!Number.isFinite(at) || at <= lower || at > upper) return { times: [], capped: false };
      return limit >= 1 ? { times: [at], capped: false } : { times: [], capped: true };
    }
    case "every": {
      const step = trigger.minutes * MINUTE_MS;
      if (!(step > 0)) return { times: [], capped: false };
      const base = opts.enrolledAtMs;
      const kMin = Math.max(1, Math.floor((lower - base) / step) + 1);
      const kMax = Math.floor((upper - base) / step);
      if (kMax < kMin) return { times: [], capped: false };
      const count = kMax - kMin + 1;
      const capped = count > limit;
      const start = capped ? kMax - limit + 1 : kMin;
      const times: number[] = [];
      for (let k = start; k <= kMax; k++) times.push(base + k * step);
      return { times, capped };
    }
    case "cron": {
      const spec = parseScheduleCron(trigger.expr);
      const firstDay = localDayIndex(lower, opts.zone) - 1;
      const lastDay = localDayIndex(upper, opts.zone) + 1;
      // Walk backwards so a capped result stops as soon as it has the newest times.
      const newestFirst: number[] = [];
      let capped = false;
      for (let day = lastDay; day >= firstDay && !capped; day--) {
        const dayTimes = cronTimesOnDay(spec, opts.zone, day);
        for (let i = dayTimes.length - 1; i >= 0; i--) {
          const t = dayTimes[i] as number;
          if (t <= lower || t > upper) continue;
          // Several skipped times map to the same instant; keep it once.
          if (newestFirst[newestFirst.length - 1] === t) continue;
          if (newestFirst.length >= limit) {
            capped = true;
            break;
          }
          newestFirst.push(t);
        }
      }
      return { times: newestFirst.reverse(), capped };
    }
  }
}

export interface ScheduleNextDueOptions {
  zone: string;
  enrolledAtMs: number;
  /** Exclusive lower bound. */
  afterMs: number;
}

/**
 * The first due instant strictly after `afterMs` (and at or after
 * enrollment), or null when there is none: a `once` already past, or a cron
 * expression that never matches a real date (such as the 31st of February).
 */
export function scheduleNextDueTime(
  trigger: ScheduleJobTrigger,
  opts: ScheduleNextDueOptions,
): number | null {
  const lower = Math.max(opts.afterMs, opts.enrolledAtMs - 1);
  switch (trigger.type) {
    case "once": {
      const at = Date.parse(trigger.at);
      return Number.isFinite(at) && at > lower ? at : null;
    }
    case "every": {
      const step = trigger.minutes * MINUTE_MS;
      if (!(step > 0)) return null;
      const k = Math.max(1, Math.floor((lower - opts.enrolledAtMs) / step) + 1);
      return opts.enrolledAtMs + k * step;
    }
    case "cron": {
      const spec = parseScheduleCron(trigger.expr);
      const first = localDayIndex(lower, opts.zone) - 1;
      for (let day = first; day <= first + CRON_NEXT_SEARCH_DAYS; day++) {
        for (const t of cronTimesOnDay(spec, opts.zone, day)) {
          if (t > lower) return t;
        }
      }
      return null;
    }
  }
}
