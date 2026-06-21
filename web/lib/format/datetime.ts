/**
 * Timezone-aware datetime helpers. Produces a stable, locale-fixed string for
 * a given `(iso, opts)` pair so every surface renders timestamps identically.
 *
 * Canonical reference style:
 *   `Wed, May 13, 2026, 4:30 PM CDT`
 */

import { NO_DATA } from "./no-data";

export interface FormatDateTimeOpts {
  timeZone?: string;
  /** Prepend the short weekday (e.g. `Sun, `). Default true so every surface
   * matches the canonical reference style above. */
  withWeekday?: boolean;
  withYear?: boolean;
  withSeconds?: boolean;
  withZoneName?: boolean;
  hour12?: boolean;
  monthFormat?: "short" | "long" | "numeric" | "2-digit";
}

/**
 * Format a Date / ISO / null as a deterministic en-US datetime string.
 *
 * **Canonical output template** (matches CLAUDE.md → Time format reference
 * style `Wed, May 13, 2026, 4:30 PM CDT`):
 *
 *   - default                   → `Sun, May 24, 7:52 PM`
 *   - +withYear                 → `Sun, May 24, 2026, 7:52 PM`
 *   - +withZoneName             → `Sun, May 24, 7:52 PM CDT`
 *   - withWeekday: false        → `May 24, 7:52 PM`
 *   - monthFormat: "numeric"    → `5/24, 7:52 PM` (drops weekday by default
 *                                 in numeric mode to keep slash-date compact)
 *
 * Built from `formatToParts` + a literal join rather than `toLocaleString`'s
 * built-in date↔time separator, because Node V8 and Safari WebKit ship
 * different CLDR data: Node renders `May 23, 2026, 4:00 AM` while iOS Safari
 * renders `May 23, 2026 at 4:00 AM` for identical inputs. When SSR happens
 * on Node and hydration runs on Safari, React reports a hydration mismatch
 * and regenerates the subtree on the client. Building the separator literal
 * here pins both runtimes to the same output.
 */
export function formatDateTime(
  d: Date | string | null | undefined,
  opts: FormatDateTimeOpts = {},
): string {
  if (d === null || d === undefined) return NO_DATA;
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return NO_DATA;

  const {
    timeZone = "America/Chicago",
    withYear = false,
    withSeconds = false,
    withZoneName = false,
    hour12 = true,
    monthFormat = "short",
  } = opts;

  const numericMonth = monthFormat === "numeric" || monthFormat === "2-digit";
  // Default-on for word-form months ("Sun, May 24"); default-off for slash-
  // form ("5/24") because the slash form is typically used in dense compact
  // contexts where prepending a weekday adds noise.
  const withWeekday = opts.withWeekday ?? !numericMonth;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    ...(withWeekday ? { weekday: "short" as const } : {}),
    month: monthFormat,
    day: "numeric",
    ...(withYear ? { year: "numeric" as const } : {}),
    hour: hour12 ? ("numeric" as const) : ("2-digit" as const),
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" as const } : {}),
    hour12,
    ...(withZoneName ? { timeZoneName: "short" as const } : {}),
  }).formatToParts(dt);

  const m = (t: string) => parts.find((p) => p.type === t)?.value ?? "";

  const monthDay = numericMonth
    ? withYear
      ? `${m("month")}/${m("day")}/${m("year")}`
      : `${m("month")}/${m("day")}`
    : `${m("month")} ${m("day")}${withYear ? `, ${m("year")}` : ""}`;
  const weekdayPart = withWeekday ? `${m("weekday")}, ` : "";
  const secondPart = withSeconds ? `:${m("second")}` : "";
  const ampmPart = hour12 ? ` ${m("dayPeriod")}` : "";
  const zonePart = withZoneName ? ` ${m("timeZoneName")}` : "";

  return `${weekdayPart}${monthDay}, ${m("hour")}:${m("minute")}${secondPart}${ampmPart}${zonePart}`;
}

/**
 * Format a Date / ISO / null as a compact relative-ago string, e.g.
 * `just now`, `42s ago`, `7m ago`, `3h 12m ago`, `1d 5h ago`, `2mo 4d ago`,
 * `3y ago`. Composed of at most two units (the largest non-zero plus its
 * remainder in the next-smaller unit). Future timestamps return `just now`
 * since the surfaces using this helper render historic events only.
 *
 * Pure function: pass `now` for deterministic tests. Components that want
 * a live-updating label wrap this in `<RelativeTimeAgo>` (which refreshes on a
 * 60s timer so "3m ago" → "4m ago" without a page reload).
 */
export function formatRelativeAgo(
  d: Date | string | null | undefined,
  now: Date = new Date(),
): string {
  if (d === null || d === undefined) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "";

  const diffMs = now.getTime() - dt.getTime();
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;

  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;

  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const remM = min - hr * 60;
    return remM > 0 ? `${hr}h ${remM}m ago` : `${hr}h ago`;
  }

  const day = Math.floor(hr / 24);
  if (day < 30) {
    const remH = hr - day * 24;
    return remH > 0 ? `${day}d ${remH}h ago` : `${day}d ago`;
  }

  // Calendar-aware month/year rollover. Use day count / 30 + day count / 365
  // for compactness; close-enough for "X mo ago" / "X y ago" labels: true
  // calendar boundaries don't matter at this granularity.
  const month = Math.floor(day / 30);
  if (month < 12) {
    const remD = day - month * 30;
    return remD > 0 ? `${month}mo ${remD}d ago` : `${month}mo ago`;
  }
  const year = Math.floor(day / 365);
  return `${year}y ago`;
}

/**
 * Render just the time-of-day portion in `HH:MM:SS` (24-hour) form in the
 * given `timeZone`. Optionally include milliseconds.
 *
 * Designed for dense table/log rows where a full datetime is overkill but
 * the user still needs the time to be in their detected zone, not UTC. Don't
 * use `iso.slice(11, 19)` for this; that returns UTC because ISO strings end
 * with Z, and silently misleads users in non-UTC zones.
 */
export function formatTimeOfDay(
  d: Date | string | null | undefined,
  opts: { timeZone?: string; withMillis?: boolean } = {},
): string {
  if (d === null || d === undefined) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "";
  const { timeZone = "America/Chicago", withMillis = false } = opts;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(dt);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hh = get("hour") === "24" ? "00" : get("hour");
  const base = `${hh}:${get("minute")}:${get("second")}`;
  if (!withMillis) return base;
  const ms = String(dt.getMilliseconds()).padStart(3, "0");
  return `${base}.${ms}`;
}

/**
 * Convert a Harnery changelog wall-clock timestamp ("2026-05-26 00:20 CDT")
 * into an ISO string parseable by JS `Date` + `formatDateTime`. The Plan
 * changelog uses local wall-clock with named zones; without translation,
 * `new Date("2026-05-26 00:20 CDT")` is undefined behavior across runtimes.
 */
export function isoFromChangelogTs(ts: string): string {
  const zoneOffsets: Record<string, string> = {
    UTC: "+00:00",
    GMT: "+00:00",
    EST: "-05:00",
    EDT: "-04:00",
    CST: "-06:00",
    CDT: "-05:00",
    MST: "-07:00",
    MDT: "-06:00",
    PST: "-08:00",
    PDT: "-07:00",
  };
  const m = ts.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*([A-Z]{2,4})?\s*$/,
  );
  if (!m) return ts; // unparseable: return as-is; <FormattedDateTime> renders the NO_DATA placeholder
  const [, y, mo, d, hh, mm, ss = "00", zone] = m;
  const offset = zone && zoneOffsets[zone] ? zoneOffsets[zone] : "+00:00";
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}${offset}`;
}
