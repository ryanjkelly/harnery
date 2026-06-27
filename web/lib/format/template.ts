/**
 * Tokenized datetime template renderer. Powers the user's "preferred datetime
 * format" setting (see [`prefs.ts`](./prefs.ts)); every UI surface that
 * renders a timestamp resolves the user's chosen template through here.
 *
 * Token grammar (case-sensitive, longest match wins):
 *
 *   YYYY  4-digit year                       2026
 *   YY    2-digit year                       26
 *   MMMM  long month name                    May
 *   MMM   short month name                   May
 *   MM    2-digit month                      05
 *   M     numeric month                      5
 *   DD    2-digit day                        28
 *   D     numeric day                        28
 *   dddd  long weekday                       Thursday
 *   ddd   short weekday                      Thu
 *   HH    24-hour, 2-digit                   08
 *   H     24-hour, numeric                   8
 *   hh    12-hour, 2-digit                   08
 *   h     12-hour, numeric                   8
 *   mm    2-digit minute                     56
 *   m     numeric minute                     56
 *   ss    2-digit second                     23
 *   s     numeric second                     23
 *   SSS   3-digit millisecond                123
 *   A     AM / PM                            AM
 *   a     am / pm                            am
 *   zzzz  long timezone name                 Central Daylight Time
 *   zzz   short timezone name                CDT
 *   zz    short timezone name                CDT
 *   z     short timezone name                CDT
 *   [..]  literal escape (drops the brackets) "at"
 *
 * Anything outside a token (and outside `[...]` literal escapes) renders
 * literally. Comma, slash, colon, dash, whitespace pass through.
 *
 * Built on `Intl.DateTimeFormat().formatToParts()` so timezone-aware output
 * matches `formatDateTime()` byte-for-byte. The token alternation is ordered
 * longest-first because JS regex alternation tries leftmost-first, not
 * longest-first: `M|MM` would match a single `M` inside `MM` and produce the
 * wrong output. See [`__tests__/template.test.ts`](./__tests__/template.test.ts)
 * for the lock-in cases.
 */

import { NO_DATA } from "./no-data";

export interface ParsedToken {
  kind: "token" | "literal";
  value: string;
}

const TOKEN_PATTERN =
  /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|SSS|ss|s|zzzz|zzz|zz|z|A|a/g;

/** Tokenize a template string into a sequence of `{ kind, value }` pairs. */
export function parseTemplate(template: string): ParsedToken[] {
  const out: ParsedToken[] = [];
  let lastIdx = 0;
  // Reset the regex's lastIndex: TOKEN_PATTERN is module-scoped + has /g flag.
  TOKEN_PATTERN.lastIndex = 0;
  while (true) {
    const m = TOKEN_PATTERN.exec(template);
    if (m === null) break;
    if (m.index > lastIdx) {
      out.push({ kind: "literal", value: template.slice(lastIdx, m.index) });
    }
    if (m[1] !== undefined) {
      // `[literal]` escape: drop the brackets, keep the body.
      out.push({ kind: "literal", value: m[1] });
    } else {
      out.push({ kind: "token", value: m[0] });
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < template.length) {
    out.push({ kind: "literal", value: template.slice(lastIdx) });
  }
  return out;
}

/**
 * `Intl.DateTimeFormat` construction is the expensive part of Intl (it loads
 * locale + timezone data); `formatToParts` on an existing instance is cheap.
 * The three option-sets `formatTemplate` needs are fixed, so the only thing
 * that varies across calls is the timeZone. Cache one trio of formatters per
 * timeZone and reuse them: a log table rendering N rows in a single zone then
 * builds each formatter once instead of `3 × N` times per render. This is the
 * single hottest path in the live log viewer (a profile attributed ~57% of
 * interaction scripting time to the un-cached construction here). The cache is
 * keyed by the small, finite set of IANA zone strings the UI ever passes
 * (realistically one), so it never grows unbounded.
 */
interface ZoneFormatters {
  long: Intl.DateTimeFormat;
  short: Intl.DateTimeFormat;
  numeric: Intl.DateTimeFormat;
}

const zoneFormatterCache = new Map<string, ZoneFormatters>();

function formattersFor(timeZone: string): ZoneFormatters {
  const cached = zoneFormatterCache.get(timeZone);
  if (cached) return cached;
  const built: ZoneFormatters = {
    long: new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "long",
    }),
    short: new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      timeZoneName: "short",
    }),
    numeric: new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }),
  };
  zoneFormatterCache.set(timeZone, built);
  return built;
}

/**
 * Render a Date / ISO / null against a token template in the given timezone.
 * Returns the NO_DATA placeholder for null/undefined/NaN, matching `formatDateTime`'s contract
 * so the two helpers are drop-in interchangeable at callsites.
 */
export function formatTemplate(
  d: Date | string | null | undefined,
  template: string,
  opts: { timeZone?: string } = {},
): string {
  if (d === null || d === undefined) return NO_DATA;
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return NO_DATA;
  const timeZone = opts.timeZone ?? "America/Chicago";

  // Reuse the per-timeZone formatter trio (construction is the costly part).
  // One `formatToParts` call per formatter grabs every field we might need.
  const fmt = formattersFor(timeZone);
  const parts = fmt.long.formatToParts(dt);
  const partsShort = fmt.short.formatToParts(dt);

  const get = (list: Intl.DateTimeFormatPart[], t: Intl.DateTimeFormatPartTypes) =>
    list.find((p) => p.type === t)?.value ?? "";

  const yearLong = get(parts, "year");
  const monthLong = get(parts, "month");
  const monthShort = get(partsShort, "month");
  const monthNumStr = String(dt.getMonth() + 1); // month tokens are tz-stable enough
  const weekdayLong = get(parts, "weekday");
  const weekdayShort = get(partsShort, "weekday");
  const dayStr = get(parts, "day");
  const tzLong = get(parts, "timeZoneName");
  const tzShort = get(partsShort, "timeZoneName");

  // Hour/minute/second: take from the long-form 24-hour parts; derive 12-hour
  // by modulo. Intl returns "24" for midnight in some locales; normalize.
  let h24 = Number.parseInt(get(parts, "hour"), 10);
  if (h24 === 24) h24 = 0;
  const minStr = get(parts, "minute");
  const secStr = get(parts, "second");
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ampm = h24 < 12 ? "AM" : "PM";

  // Re-derive numeric day/month/year in target tz via the numeric formatter,
  // because `dt.getMonth()` is the host-tz month, not the target-tz month.
  const numericParts = fmt.numeric.formatToParts(dt);
  const numMonth = get(numericParts, "month");
  const numDay = get(numericParts, "day");

  const pad2 = (n: number | string) => String(n).padStart(2, "0");
  const millis = String(dt.getMilliseconds()).padStart(3, "0");

  const replace = (token: string): string => {
    switch (token) {
      case "YYYY":
        return yearLong;
      case "YY":
        return yearLong.slice(-2);
      case "MMMM":
        return monthLong;
      case "MMM":
        return monthShort;
      case "MM":
        return pad2(numMonth);
      case "M":
        return numMonth;
      case "DD":
        return pad2(numDay);
      case "D":
        return numDay;
      case "dddd":
        return weekdayLong;
      case "ddd":
        return weekdayShort;
      case "HH":
        return pad2(h24);
      case "H":
        return String(h24);
      case "hh":
        return pad2(h12);
      case "h":
        return String(h12);
      case "mm":
        return minStr;
      case "m":
        return String(Number.parseInt(minStr, 10));
      case "ss":
        return secStr;
      case "s":
        return String(Number.parseInt(secStr, 10));
      case "SSS":
        return millis;
      case "A":
        return ampm;
      case "a":
        return ampm.toLowerCase();
      case "z":
      case "zz":
      case "zzz":
        return tzShort;
      case "zzzz":
        return tzLong;
      default:
        return token;
    }
  };

  return parseTemplate(template)
    .map((p) => (p.kind === "literal" ? p.value : replace(p.value)))
    .join("");
}

/**
 * Derive a time-only template by extracting the contiguous run of time tokens
 * (and the timezone token if present) from a full datetime template. Used by
 * the dense log-row timestamp surface: log rows show just the time portion
 * while the tooltip carries the full template.
 *
 * Examples:
 *   "ddd, MMM D, YYYY, h:mm A z"  →  "h:mm A z"
 *   "YYYY-MM-DD HH:mm:ss"          →  "HH:mm:ss"
 *   "M/D/YYYY h:mm A"              →  "h:mm A"
 *   "dddd, MMMM D"                 →  ""   (no time tokens → caller falls back)
 *
 * Leading separators (whitespace, commas) on the extracted slice are trimmed.
 * If `opts.ensureSeconds` is set, missing `s`/`ss` tokens get appended as
 * `:ss`. If `opts.ensureMillis` is set, `.SSS` is appended.
 */
export function deriveTimeOnlyTemplate(
  template: string,
  opts: { ensureSeconds?: boolean; ensureMillis?: boolean } = {},
): string {
  const tokens = parseTemplate(template);
  const isTimeToken = (t: ParsedToken) =>
    t.kind === "token" && /^(H{1,2}|h{1,2}|m{1,2}|s{1,2}|SSS|A|a)$/.test(t.value);
  const isZoneToken = (t: ParsedToken) => t.kind === "token" && /^z{1,4}$/.test(t.value);

  const firstTime = tokens.findIndex(isTimeToken);
  if (firstTime === -1) return "";

  // Walk forward to find the last time-or-zone token.
  let lastKeep = firstTime;
  for (let i = firstTime; i < tokens.length; i++) {
    if (isTimeToken(tokens[i]) || isZoneToken(tokens[i])) lastKeep = i;
  }

  const slice = tokens.slice(firstTime, lastKeep + 1);
  let result = slice.map((t) => t.value).join("");

  if (opts.ensureSeconds && !/[s]/.test(result)) {
    // Insert :ss after the minute group. The simple regex looks for `mm` or
    // `m` followed by a non-time char and inserts before that boundary.
    result = result.replace(/(mm|m)/, "$1:ss");
  }
  if (opts.ensureMillis && !/SSS/.test(result)) {
    // Insert .SSS after the second group, or after minute if no second exists.
    if (/ss?/.test(result)) {
      result = result.replace(/(ss|s)/, "$1.SSS");
    } else if (/mm?/.test(result)) {
      result = result.replace(/(mm|m)/, "$1.SSS");
    }
  }
  return result;
}
