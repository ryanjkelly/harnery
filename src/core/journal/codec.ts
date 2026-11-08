/**
 * Journal codec: the one reader and writer of the journal file format, shared
 * by the CLI and the dashboard. Pure (no fs), so the dashboard can import it
 * without touching coordination state.
 *
 * Format:
 *
 *   # Journal: agent-<name>
 *   session_id: <id>
 *   machine: <label>
 *   started: 2026-11-07 9:49 PM -06:00
 *   last_updated: 2026-11-07 10:38 PM -06:00
 *
 *   ---
 *
 *   ## 2026-11-07 10:38 PM -06:00 · note
 *   <body>
 *
 * A timestamp is the wall-clock time in the writer's resolved zone plus that
 * zone's numeric UTC offset at that instant. The offset makes every stamp an
 * exact instant, so parsing never consults a zone database and two writers in
 * different zones still order correctly.
 */

export const JOURNAL_CATEGORIES = [
  "note",
  "plan",
  "decision",
  "blocker",
  "question",
  "done",
  "handoff",
] as const;

export type JournalCategory = (typeof JOURNAL_CATEGORIES)[number];

/** First line of every journal file: this prefix followed by the agent name. */
export const JOURNAL_HEADER_PREFIX = "# Journal: agent-";

/** The separator line between the metadata block and the entries. */
export const JOURNAL_METADATA_END = "---";

/** Metadata keys whose values are journal timestamps. */
export const JOURNAL_TIMESTAMP_KEYS = ["started", "last_updated"] as const;

export interface JournalEntry {
  /** Canonical ISO 8601 instant with the stamp's own offset. */
  ts_iso: string;
  /** The stamp exactly as written in the file, e.g. `2026-11-07 10:38 PM -06:00`. */
  ts_display: string;
  category: JournalCategory;
  body: string;
}

export interface JournalHeader {
  name: string;
  session_id: string;
  machine: string;
  started: string;
  last_updated: string;
}

export interface JournalDoc {
  path: string;
  header: JournalHeader;
  entries: JournalEntry[];
  bytes: number;
  /**
   * 1-based line numbers of timestamps this codec cannot read: entry-header
   * lines that carry a date and a category but no valid stamp, and date-like
   * `started` / `last_updated` values. Writers refuse such a file, because
   * rewriting it would fold those entries into their neighbours.
   */
  unreadable_lines: number[];
}

export interface ParsedJournalTimestamp {
  /** The stamp as written. */
  display: string;
  /** ISO 8601 with the stamp's offset, e.g. `2026-11-07T22:38:00-06:00`. */
  iso: string;
  /** Milliseconds since the epoch. */
  epoch_ms: number;
}

const CATEGORY_PATTERN = JOURNAL_CATEGORIES.join("|");

/**
 * A line shaped like an entry header: `## `, something that starts with a
 * date, ` · `, and a known category. Whether it IS a header depends on the
 * stamp parsing; a line of this shape whose stamp does not parse is unreadable.
 */
const HEADER_SHAPE_RE = new RegExp(`^## (\\d{4}-\\d{2}-\\d{2} [^\\n]*) · (${CATEGORY_PATTERN})$`);

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2}) (AM|PM) ([+-])(\d{2}):(\d{2})$/;

/** A metadata value that claims to be a timestamp (starts with a date). */
const DATE_LIKE_RE = /^\d{4}-\d{2}-\d{2}\b/;

/** Greatest absolute UTC offset any zone uses (UTC+14:00). */
const MAX_OFFSET_MINUTES = 14 * 60;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** True when `year-month-day` names a real calendar date. */
export function isCalendarDate(year: number, month: number, day: number): boolean {
  return (
    Number.isInteger(year) &&
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

/** `[1-9]` or `1[0-2]`, as the formatter writes it (no leading zero). */
function parseHour12(raw: string): number | null {
  if (!/^(?:[1-9]|1[0-2])$/.test(raw)) return null;
  return Number(raw);
}

function to24Hour(hour12: number, period: "AM" | "PM"): number {
  if (period === "AM") return hour12 === 12 ? 0 : hour12;
  return hour12 === 12 ? 12 : hour12 + 12;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `+05:30`, `-06:00`, `+00:00`. */
export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * Build the ISO instant for a validated wall-clock time and offset. Exposed for
 * the bounded migration, which maps legacy zone abbreviations to offsets.
 */
export function wallClockToIso(
  date: string,
  hour24: number,
  minute: number,
  offsetMinutes: number,
): string {
  return `${date}T${pad2(hour24)}:${pad2(minute)}:00${formatUtcOffset(offsetMinutes)}`;
}

/**
 * Parse a journal timestamp such as `2026-11-07 10:38 PM -06:00`. Exact and
 * zone-independent: the calendar date, the 1-12 hour, the minute, AM/PM, and
 * the offset (up to ±14:00, including +05:30 and +05:45) must all be valid.
 * Returns null for anything else, including `-00:00`, which the writer never
 * produces.
 */
export function parseJournalTimestamp(stamp: string): ParsedJournalTimestamp | null {
  const m = STAMP_RE.exec(stamp);
  if (!m) return null;
  const [, y, mo, d, h, mi, period, sign, oh, om] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (!isCalendarDate(year, month, day)) return null;
  const hour12 = parseHour12(h!);
  if (hour12 === null) return null;
  const minute = Number(mi);
  if (minute > 59) return null;
  const offsetHours = Number(oh);
  const offsetMins = Number(om);
  if (offsetMins > 59) return null;
  const magnitude = offsetHours * 60 + offsetMins;
  if (magnitude > MAX_OFFSET_MINUTES) return null;
  if (sign === "-" && magnitude === 0) return null;
  const offsetMinutes = sign === "-" ? -magnitude : magnitude;
  const hour24 = to24Hour(hour12, period as "AM" | "PM");
  const iso = wallClockToIso(`${y}-${mo}-${d}`, hour24, minute, offsetMinutes);
  const epoch_ms = Date.UTC(year, month - 1, day, hour24, minute) - offsetMinutes * 60_000;
  return { display: stamp, iso, epoch_ms };
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let fmt = partsFormatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partsFormatters.set(zone, fmt);
  }
  return fmt;
}

/**
 * Format `date` as a journal timestamp in `zone` (an IANA name the caller has
 * already resolved), e.g. `2026-11-07 10:38 PM -06:00`. The offset is
 * computed from the wall clock itself, so it is exact on DST transition days.
 */
export function formatJournalTimestamp(date: Date, zone: string): string {
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("formatJournalTimestamp: invalid date");
  const wholeSecondMs = Math.floor(ms / 1000) * 1000;
  const parts = partsFormatter(zone).formatToParts(new Date(wholeSecondMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour") % 24;
  const minute = get("minute");
  const second = get("second");
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMinutes = Math.round((wallAsUtc - wholeSecondMs) / 60_000);
  const period = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const datePart = `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
  return `${datePart} ${hour12}:${pad2(minute)} ${period} ${formatUtcOffset(offsetMinutes)}`;
}

/** The entry-header line for a stamp and category. */
export function formatEntryHeader(stamp: string, category: JournalCategory): string {
  return `## ${stamp} · ${category}`;
}

export interface ParsedEntryHeader {
  timestamp: ParsedJournalTimestamp;
  category: JournalCategory;
}

/** Parse an entry-header line, or null when the line is not a valid header. */
export function parseEntryHeader(line: string): ParsedEntryHeader | null {
  if (!line.startsWith("## ")) return null;
  const m = HEADER_SHAPE_RE.exec(line);
  if (!m) return null;
  const timestamp = parseJournalTimestamp(m[1]!);
  if (!timestamp) return null;
  return { timestamp, category: m[2] as JournalCategory };
}

/**
 * True for a line shaped like an entry header (date, ` · `, known category)
 * whose stamp this codec cannot read, such as a stamp written before journal
 * timestamps carried numeric offsets.
 */
export function isUnreadableEntryHeader(line: string): boolean {
  if (!line.startsWith("## ")) return false;
  const m = HEADER_SHAPE_RE.exec(line);
  return m !== null && parseJournalTimestamp(m[1]!) === null;
}

/** True for a metadata timestamp value that starts with a date but does not parse. */
export function isUnreadableMetadataTimestamp(value: string): boolean {
  return DATE_LIKE_RE.test(value) && parseJournalTimestamp(value) === null;
}

/** Parse a journal file (or empty content) into a structured doc. */
export function parseJournal(path: string, content: string): JournalDoc {
  const lines = content.split("\n");
  const header: JournalHeader = {
    name: "unknown",
    session_id: "",
    machine: "",
    started: "",
    last_updated: "",
  };
  const entries: JournalEntry[] = [];
  const unreadable_lines: number[] = [];

  let i = 0;
  // ── metadata ──
  if (lines[i]?.startsWith(JOURNAL_HEADER_PREFIX)) {
    header.name = lines[i]!.replace(JOURNAL_HEADER_PREFIX, "").trim();
    i++;
  }
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === JOURNAL_METADATA_END) {
      i++;
      break;
    }
    const separator = line.indexOf(":");
    if (separator > 0) {
      const key = line.slice(0, separator);
      if (
        key === "session_id" ||
        key === "machine" ||
        key === "started" ||
        key === "last_updated"
      ) {
        const value = line.slice(separator + 1).trim();
        if (value) header[key] = value;
        if ((key === "started" || key === "last_updated") && isUnreadableMetadataTimestamp(value)) {
          unreadable_lines.push(i + 1);
        }
      }
    }
  }

  // ── entries ──
  let current: { header: ParsedEntryHeader } | null = null;
  let bodyLines: string[] = [];
  const flush = () => {
    if (!current) return;
    entries.push({
      ts_iso: current.header.timestamp.iso,
      ts_display: current.header.timestamp.display,
      category: current.header.category,
      body: bodyLines.join("\n").trim(),
    });
    current = null;
    bodyLines = [];
  };

  for (; i < lines.length; i++) {
    const line = lines[i]!;
    // Only a line that parses as an entry header starts a new entry. A body
    // line that merely begins with "## " (a markdown heading inside a
    // multi-line note) stays in the current entry; treating it as a header
    // would drop it and everything after it on the next rewrite.
    const parsed = parseEntryHeader(line);
    if (parsed) {
      flush();
      current = { header: parsed };
      continue;
    }
    if (isUnreadableEntryHeader(line)) unreadable_lines.push(i + 1);
    if (current) bodyLines.push(line);
  }
  flush();

  return {
    path,
    header,
    entries,
    bytes: Buffer.byteLength(content, "utf8"),
    unreadable_lines,
  };
}

/** Serialize a parsed doc back to markdown. */
export function serializeJournal(doc: JournalDoc): string {
  const lines: string[] = [];
  lines.push(`${JOURNAL_HEADER_PREFIX}${doc.header.name}`);
  if (doc.header.session_id) lines.push(`session_id: ${doc.header.session_id}`);
  if (doc.header.machine) lines.push(`machine: ${doc.header.machine}`);
  if (doc.header.started) lines.push(`started: ${doc.header.started}`);
  if (doc.header.last_updated) lines.push(`last_updated: ${doc.header.last_updated}`);
  lines.push("");
  lines.push(JOURNAL_METADATA_END);
  lines.push("");
  for (const entry of doc.entries) {
    lines.push(formatEntryHeader(entry.ts_display, entry.category));
    if (entry.body.length > 0) {
      lines.push(entry.body);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
