/**
 * Schedules from every source, read through `harn schedule list` and
 * `harn schedule history` so the dashboard and the CLI share one
 * implementation. The pure helpers below (source names, plain-English
 * triggers, page sections, relative times, run durations) are what the
 * Schedules page renders with.
 */

import type { ScheduleRunResult } from "../../src/core/schedule/job-types";
import type {
  ScheduleCoverageState,
  ScheduleRecord,
  ScheduleRunStatus,
  ScheduleSource,
  ScheduleSourceCoverage,
  ScheduleTrigger,
} from "../../src/core/schedule/types";
import { runHarn } from "./run-harn";

export type {
  ScheduleCoverageState,
  ScheduleRecord,
  ScheduleRunStatus,
  ScheduleSource,
  ScheduleSourceCoverage,
  ScheduleTrigger,
} from "../../src/core/schedule/types";
export type { ScheduleRunResult };
export type {
  ScheduleHarneryAgent,
  ScheduleHarneryCommand,
  ScheduleHarneryJob,
} from "../../src/core/schedule/types";
export {
  describeScheduleAgent,
  describeScheduleEnrollment,
  describeScheduleJobWork,
  formatScheduleArgv,
} from "../../src/core/schedule/describe-job";

export interface ScheduleList {
  records: ScheduleRecord[];
  coverage: ScheduleSourceCoverage[];
}

/** One row of `harn schedule history <job-id> --json`. */
export interface ScheduleHistoryRow {
  run_id: string;
  scheduled_for: string;
  kind: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  result: ScheduleRunResult;
  report_path: string | null;
}

export interface ScheduleHistory {
  job_id: string;
  defined: boolean | null;
  rows: ScheduleHistoryRow[];
  meta?: { total: number; shown: number };
}

/** The CLI prints a JSON error envelope on stderr for a refusal; show its message. */
function cliError(stderr: string, fallback: string): string {
  const text = stderr.trim();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // stderr is plain text
  }
  return text || fallback;
}

export async function readScheduleList(): Promise<{ list?: ScheduleList; error?: string }> {
  const result = await runHarn(["schedule", "list", "--json"]);
  try {
    const parsed = JSON.parse(result.stdout) as Partial<ScheduleList>;
    if (!Array.isArray(parsed.records) || !Array.isArray(parsed.coverage)) throw new Error();
    return { list: { records: parsed.records, coverage: parsed.coverage } };
  } catch {
    return { error: cliError(result.stderr, "could not read the schedule list") };
  }
}

/** Mirrors the CLI's job id rule, so a bad id never reaches argv. */
const JOB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function readScheduleHistory(
  jobId: string,
  limit = 5,
): Promise<{ history?: ScheduleHistory; error?: string }> {
  if (!JOB_ID.test(jobId)) return { error: `"${jobId}" is not a valid job id` };
  const result = await runHarn(["schedule", "history", jobId, "--limit", String(limit), "--json"]);
  try {
    const parsed = JSON.parse(result.stdout) as ScheduleHistory;
    if (!Array.isArray(parsed.rows)) throw new Error();
    return { history: parsed };
  } catch {
    return { error: cliError(result.stderr, "could not read this job's runs") };
  }
}

// ---------------------------------------------------------------------------
// Source names
// ---------------------------------------------------------------------------

export interface SourceMeta {
  /** The name a card shows for one schedule from this source. */
  label: string;
  /** The name the coverage strip shows for the whole source. */
  coverageLabel: string;
  /** One sentence on what the source is. */
  hint: string;
}

export const SOURCE_META: Record<ScheduleSource, SourceMeta> = {
  harnery: {
    label: "Harnery",
    coverageLabel: "Harnery jobs",
    hint: "A job in this project's Harnery schedule file.",
  },
  "os-timer": {
    label: "System timer",
    coverageLabel: "System timers",
    hint: "One of this machine's own timers: a systemd user timer or a crontab entry.",
  },
  "t3-code": {
    label: "T3 Code",
    coverageLabel: "T3 Code",
    hint: "A scheduled task in the T3 Code app.",
  },
  "codex-app": {
    label: "Codex",
    coverageLabel: "Codex",
    hint: "An automation in the Codex app.",
  },
  captured: {
    label: "Seen by Harnery",
    coverageLabel: "Seen by Harnery",
    hint: "Created through an agent's tool call that Harnery saw; its current state is not confirmed.",
  },
};

/** The card label for one record: a system timer names its kind when its id says. */
export function sourceLabel(record: Pick<ScheduleRecord, "source" | "id">): string {
  if (record.source === "os-timer") {
    if (record.id.startsWith("systemd-user:")) return "Systemd timer";
    if (record.id.startsWith("crontab:")) return "Cron";
  }
  return SOURCE_META[record.source].label;
}

/** A systemd unit's title without its ".timer" or ".service" suffix; other titles unchanged. */
export function cleanTitle(record: Pick<ScheduleRecord, "source" | "id" | "title">): string {
  const title = record.title || record.id;
  if (record.source === "os-timer" && record.id.startsWith("systemd-user:")) {
    return title.replace(/\.(timer|service)$/, "");
  }
  return title;
}

// ---------------------------------------------------------------------------
// Plain-English triggers
// ---------------------------------------------------------------------------

const UNITS: Array<[ms: number, singular: string, plural: string]> = [
  [86_400_000, "day", "days"],
  [3_600_000, "hour", "hours"],
  [60_000, "minute", "min"],
  [1_000, "second", "sec"],
];

/** "Every 5 min", "Every 2 hours", "Every day", "Every minute", "Every 90 sec". */
export function formatInterval(everyMs: number): string {
  for (const [unit, singular, plural] of UNITS) {
    if (everyMs >= unit && everyMs % unit === 0) {
      const n = everyMs / unit;
      return n === 1 ? `Every ${singular}` : `Every ${n} ${plural}`;
    }
  }
  return `Every ${everyMs} ms`;
}

function every(n: number, singular: string, plural: string): string {
  return n === 1 ? `Every ${singular}` : `Every ${n} ${plural}`;
}

function clock(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** "a", "a and b", "a, b and c". */
function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function times(hours: number[], minutes: number[]): string {
  const list: string[] = [];
  for (const h of hours) for (const m of minutes) list.push(clock(h, m));
  return joinAnd(list);
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ABBR: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  su: 0,
  mo: 1,
  tu: 2,
  we: 3,
  th: 4,
  fr: 5,
  sa: 6,
};

/** "Daily", "Weekdays", "Weekends", "Mondays", "Monday and Friday"; null for days it can't read. */
function describeDays(days: Set<number> | null): string | null {
  if (days === null || days.size === 7 || days.size === 0) return "Daily";
  const sorted = [...days].sort((a, b) => a - b);
  const key = sorted.join(",");
  if (key === "1,2,3,4,5") return "Weekdays";
  if (key === "0,6") return "Weekends";
  if (sorted.length === 1) return `${DAY_NAMES[sorted[0]]}s`;
  // Monday first reads more naturally than Sunday first.
  const mondayFirst = [...sorted.filter((d) => d !== 0), ...sorted.filter((d) => d === 0)];
  return joinAnd(mondayFirst.map((d) => DAY_NAMES[d]));
}

function dayIndex(token: string): number | null {
  const t = token.toLowerCase();
  if (/^\d$/.test(t)) {
    const n = Number(t);
    return n === 7 ? 0 : n <= 6 ? n : null;
  }
  return DAY_ABBR[t.slice(0, 3)] ?? DAY_ABBR[t] ?? null;
}

/**
 * Read a day-of-week field: cron ("1-5", "0,6", "mon,wed"), systemd
 * ("Mon..Fri", "Sat,Sun") or RRULE BYDAY ("MO,TU"). Null for "every day";
 * undefined when it can't be read.
 */
function parseDays(field: string): Set<number> | null | undefined {
  if (field === "*" || field === "") return null;
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^([a-z0-9]+)(?:-|\.\.)([a-z0-9]+)$/i.exec(part);
    if (range) {
      const from = dayIndex(range[1]);
      let to = dayIndex(range[2]);
      if (from === null || to === null) return undefined;
      if (to === 0 && from > 0) to = 7; // "1-7" and "Mon..Sun" end on Sunday
      if (to < from) return undefined;
      for (let d = from; d <= to; d++) days.add(d % 7);
      continue;
    }
    const d = dayIndex(part);
    if (d === null) return undefined;
    days.add(d);
  }
  return days;
}

/** "at 6:00 AM" phrases joined to the days: "Daily at 6:00 AM", "Weekdays at 9:00 AM". */
function onDays(days: Set<number> | null, at: string): string | null {
  const d = describeDays(days);
  return d ? `${d} at ${at}` : null;
}

const NUM = /^\d{1,2}$/;
const NUM_LIST = /^\d{1,2}(,\d{1,2})*$/;

function numList(field: string, max: number): number[] | null {
  if (!NUM_LIST.test(field)) return null;
  const list = field.split(",").map(Number);
  return list.some((n) => n > max) ? null : list;
}

/** A "*\/N" or "0/N" step from zero; null otherwise. */
function stepFromZero(field: string): number | null {
  const m = /^(?:\*|0{1,2})\/(\d+)$/.exec(field);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/**
 * Plain text for a 5-field cron expression, or null for one it can't read
 * faithfully. Times are wall-clock times in the cron's own zone.
 */
export function describeCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;
  if (month !== "*") return null;
  const days = parseDays(dow);
  if (days === undefined) return null;

  if (dom !== "*") {
    // Monthly on a day of the month, at fixed times.
    const doms = numList(dom, 31);
    const ms = numList(minute, 59);
    const hs = numList(hour, 23);
    if (!doms || !ms || !hs || days !== null) return null;
    return `Monthly on day ${joinAnd(doms.map(String))} at ${times(hs, ms)}`;
  }

  if (hour === "*") {
    if (days !== null) return null;
    if (minute === "*") return "Every minute";
    const step = stepFromZero(minute);
    if (step) return every(step, "minute", "min");
    if (NUM.test(minute) && Number(minute) <= 59) {
      const m = Number(minute);
      return m === 0 ? "Every hour" : `Hourly at :${String(m).padStart(2, "0")}`;
    }
    return null;
  }

  const hourStep = stepFromZero(hour);
  if (hourStep) {
    if (days !== null || !NUM.test(minute) || Number(minute) > 59) return null;
    const m = Number(minute);
    const base = every(hourStep, "hour", "hours");
    return m === 0 ? base : `${base} at :${String(m).padStart(2, "0")}`;
  }

  const hs = numList(hour, 23);
  const ms = numList(minute, 59);
  if (!hs || !ms) return null;
  return onDays(days, times(hs, ms));
}

const SYSTEMD_SHORTHAND: Record<string, string> = {
  minutely: "Every minute",
  hourly: "Every hour",
  daily: "Daily at 12:00 AM",
  weekly: "Mondays at 12:00 AM",
  monthly: "Monthly on day 1 at 12:00 AM",
  quarterly: "Every 3 months",
  semiannually: "Every 6 months",
  yearly: "Yearly on January 1",
  annually: "Yearly on January 1",
};

/** One systemd OnCalendar= spec, or null for one it can't read faithfully. */
export function describeSystemdCalendar(spec: string): string | null {
  const trimmed = spec.trim();
  const shorthand = SYSTEMD_SHORTHAND[trimmed.toLowerCase()];
  if (shorthand) return shorthand;
  const tokens = trimmed.split(/\s+/);
  let days: Set<number> | null = null;
  let time: string | null = null;
  for (const token of tokens) {
    if (/^\*-\*-\*$/.test(token)) continue;
    if (/:/.test(token) && time === null) {
      time = token;
      continue;
    }
    if (/^[a-z]/i.test(token) && days === null) {
      const parsed = parseDays(token);
      if (!parsed) return null;
      days = parsed;
      continue;
    }
    return null; // a date, a zone, or anything else
  }
  if (time === null) return null;
  const parts = time.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const [h, m, s = "00"] = parts;
  if (!/^0{1,2}$/.test(s)) return null;

  if (h === "*") {
    if (days !== null) return null;
    const step = stepFromZero(m);
    if (step) return `${every(step, "minute", "min")} on the clock`;
    if (m === "*") return "Every minute";
    if (NUM.test(m) && Number(m) <= 59) {
      const mm = Number(m);
      return mm === 0 ? "Every hour on the hour" : `Hourly at :${String(mm).padStart(2, "0")}`;
    }
    return null;
  }
  const hourStep = stepFromZero(h);
  if (hourStep) {
    if (days !== null || !NUM.test(m) || Number(m) > 59) return null;
    const mm = Number(m);
    const base = every(hourStep, "hour", "hours");
    return mm === 0 ? `${base} on the clock` : `${base} at :${String(mm).padStart(2, "0")}`;
  }
  const hs = numList(h, 23);
  const ms = numList(m, 59);
  if (!hs || !ms) return null;
  return onDays(days, times(hs, ms));
}

/** An RFC 5545 RRULE in plain text, or null for one it can't read faithfully. */
export function describeRrule(rule: string): string | null {
  const body = rule
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^(RRULE:)?FREQ=/i.test(line));
  if (!body) return null;
  const parts = new Map<string, string>();
  for (const pair of body.replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = pair.split("=");
    if (k && v !== undefined) parts.set(k.toUpperCase(), v.toUpperCase());
  }
  const known = new Set([
    "FREQ",
    "INTERVAL",
    "BYDAY",
    "BYHOUR",
    "BYMINUTE",
    "BYSECOND",
    "BYMONTHDAY",
    "COUNT",
    "UNTIL",
    "WKST",
  ]);
  for (const k of parts.keys()) if (!known.has(k)) return null;
  const n = Number(parts.get("INTERVAL") ?? "1");
  if (!Number.isInteger(n) || n < 1) return null;
  const byDay = parts.get("BYDAY");
  const days = byDay ? parseDays(byDay) : null;
  if (days === undefined) return null;
  const hs = parts.has("BYHOUR") ? numList(parts.get("BYHOUR") ?? "", 23) : null;
  const ms = parts.has("BYMINUTE") ? numList(parts.get("BYMINUTE") ?? "", 59) : null;
  if ((parts.has("BYHOUR") && !hs) || (parts.has("BYMINUTE") && !ms)) return null;
  const at = hs ? times(hs, ms ?? [0]) : null;

  switch (parts.get("FREQ")) {
    case "MINUTELY":
      return days || hs ? null : every(n, "minute", "min");
    case "HOURLY": {
      if (days || hs) return null;
      const base = every(n, "hour", "hours");
      return ms && ms.length === 1 && ms[0] !== 0
        ? `${base} at :${String(ms[0]).padStart(2, "0")}`
        : base;
    }
    case "DAILY":
      if (n > 1) return at ? `Every ${n} days at ${at}` : `Every ${n} days`;
      return at ? onDays(days, at) : (describeDays(days) ?? "Daily");
    case "WEEKLY": {
      const d = describeDays(days);
      if (n > 1) return `Every ${n} weeks${days ? ` on ${d}` : ""}${at ? ` at ${at}` : ""}`;
      if (!days) return at ? `Weekly at ${at}` : "Weekly";
      return at ? `${d} at ${at}` : `${d}`;
    }
    case "MONTHLY": {
      if (days) return null;
      const dom = parts.get("BYMONTHDAY");
      const base = n === 1 ? "Monthly" : `Every ${n} months`;
      return `${base}${dom ? ` on day ${dom.split(",").join(", ")}` : ""}${at ? ` at ${at}` : ""}`;
    }
    case "YEARLY":
      return days ? null : n === 1 ? "Yearly" : `Every ${n} years`;
    default:
      return null;
  }
}

const CRON_MACROS: Record<string, string> = {
  "@reboot": "On startup",
  "@hourly": "Every hour",
  "@daily": "Daily at 12:00 AM",
  "@midnight": "Daily at 12:00 AM",
  "@weekly": "Sundays at 12:00 AM",
  "@monthly": "Monthly on day 1 at 12:00 AM",
  "@yearly": "Yearly on January 1",
  "@annually": "Yearly on January 1",
};

/** A zone as a short label: "CT", "ET", "UTC", else the city ("Kolkata"). */
export function shortZone(zone: string): string {
  if (/^(Etc\/)?(UTC|GMT|Universal|Zulu)$/i.test(zone)) return "UTC";
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortGeneric" })
      .formatToParts(new Date(0))
      .find((p) => p.type === "timeZoneName")?.value;
    if (name && /^[A-Z]{2,5}$/.test(name)) return name;
  } catch {
    // an unknown zone falls through to its city
  }
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ");
}

/** Which icon a trigger shows. */
export type TriggerIcon = "repeat" | "calendar" | "once" | "event";

export interface TriggerText {
  /** Plain-English cadence. For `once` the page appends the formatted `at`. */
  text: string;
  icon: TriggerIcon;
  /** Set for a `once` trigger: the instant to render in the viewer's settings. */
  at?: string;
  /** The source's own trigger text, for the tooltip and the details. */
  raw: string;
  /** True when no plain reading was found and `text` is the fallback. */
  custom?: boolean;
}

const CUSTOM = "Custom schedule";

export function formatTrigger(trigger: ScheduleTrigger): TriggerText {
  const raw = trigger.raw;
  switch (trigger.kind) {
    case "interval":
      return { text: formatInterval(trigger.everyMs), icon: "repeat", raw };
    case "cron": {
      const text = describeCron(trigger.expr);
      const zone = trigger.zone ? ` ${shortZone(trigger.zone)}` : "";
      return text
        ? { text: `${text}${zone}`, icon: "calendar", raw: raw || trigger.expr }
        : { text: CUSTOM, icon: "calendar", raw: raw || trigger.expr, custom: true };
    }
    case "once":
      return { text: "Once", icon: "once", at: trigger.at, raw };
    case "rrule": {
      const text = describeRrule(trigger.rule);
      return text
        ? { text, icon: "calendar", raw: raw || trigger.rule }
        : { text: CUSTOM, icon: "calendar", raw: raw || trigger.rule, custom: true };
    }
    case "event":
      return describeEvent(trigger.description, raw);
  }
}

function describeEvent(description: string, raw: string): TriggerText {
  const shown = raw || description;
  const d = description.trim();
  if (d.startsWith("calendar:")) {
    const specs = d
      .slice("calendar:".length)
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const texts = specs.map(describeSystemdCalendar);
    if (texts.length > 0 && texts.every((t): t is string => t !== null)) {
      return { text: texts.join("; "), icon: "calendar", raw: shown };
    }
    return { text: CUSTOM, icon: "calendar", raw: shown, custom: true };
  }
  if (d.startsWith("cron macro:")) {
    const text = CRON_MACROS[d.slice("cron macro:".length).trim()];
    if (text) return { text, icon: text === "On startup" ? "event" : "calendar", raw: shown };
    return { text: CUSTOM, icon: "calendar", raw: shown, custom: true };
  }
  if (d === "webhook") return { text: "On webhook", icon: "event", raw: shown };
  if (d.startsWith("after boot:")) return { text: "Once after startup", icon: "event", raw: shown };
  if (d.startsWith("after the user manager starts:")) {
    return { text: "Once after sign-in", icon: "event", raw: shown };
  }
  if (d === "not recorded") {
    return { text: "Trigger not recorded", icon: "event", raw: shown, custom: true };
  }
  return { text: CUSTOM, icon: "event", raw: shown, custom: true };
}

// ---------------------------------------------------------------------------
// Sections and sorting
// ---------------------------------------------------------------------------

/** 0 for a failed last run, 1 for one that needs attention, 2 otherwise. */
export function problemRank(record: Pick<ScheduleRecord, "last_run">): number {
  const status = record.last_run?.status;
  if (status === "failed") return 0;
  if (status === "attention") return 1;
  return 2;
}

type SortFields = Pick<ScheduleRecord, "last_run" | "next_run_at" | "title">;

function nextMs(r: Pick<ScheduleRecord, "next_run_at">): number {
  const t = r.next_run_at ? Date.parse(r.next_run_at) : Number.NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/** Problems first (failed, then attention), then soonest next run; no next run last. */
export function sortSchedules<T extends SortFields>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => {
    const rank = problemRank(a) - problemRank(b);
    if (rank !== 0) return rank;
    const na = nextMs(a);
    const nb = nextMs(b);
    if (na !== nb) return na < nb ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

export type ScheduleState = "failed" | "attention" | "active" | "paused" | "finished";

type StateFields = Pick<ScheduleRecord, "enabled" | "last_run" | "next_run_at" | "trigger">;

/**
 * Where a schedule sits on the page. Switched off wins (a paused job's old
 * failure is not news); then a failed or attention last run; then a one-off
 * whose time has passed with no next run is finished; everything else is active.
 */
export function scheduleState(record: StateFields, now: number): ScheduleState {
  if (record.enabled === false) return "paused";
  const rank = problemRank(record);
  if (rank === 0) return "failed";
  if (rank === 1) return "attention";
  if (record.trigger.kind === "once" && !record.next_run_at) {
    const at = Date.parse(record.trigger.at);
    if (!Number.isFinite(at) || at <= now) return "finished";
  }
  return "active";
}

export interface ScheduleSections<T> {
  attention: T[];
  active: T[];
  inactive: T[];
}

/** Split records into the page's three sections, each in display order. */
export function groupSchedules<T extends StateFields & SortFields>(
  records: readonly T[],
  now: number,
): ScheduleSections<T> {
  const out: ScheduleSections<T> = { attention: [], active: [], inactive: [] };
  for (const r of sortSchedules(records)) {
    const state = scheduleState(r, now);
    if (state === "failed" || state === "attention") out.attention.push(r);
    else if (state === "active") out.active.push(r);
    else out.inactive.push(r);
  }
  return out;
}

/** The host most records run on, shown once in the page header. */
export function commonHost(records: readonly Pick<ScheduleRecord, "runs_on">[]): string | null {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.runs_on.host, (counts.get(r.runs_on.host) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [host, n] of counts) {
    if (n > bestN) {
      best = host;
      bestN = n;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Times and runs
// ---------------------------------------------------------------------------

export { relativeLabel } from "../components/schedules/relative-label";

/** "47s", "3m 12s", "1h 5m"; empty for a run with no duration. */
export function formatRunDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The dashboard's file viewer link for a repo-relative path. */
export function fileViewerHref(relPath: string): string {
  return `/files?path=${encodeURIComponent(relPath)}`;
}

// ---------------------------------------------------------------------------
// Words and tones
// ---------------------------------------------------------------------------

/** Tones for the shared colour grammar (lib/tone.ts). */
export const LAST_RUN_TONES = {
  succeeded: "done",
  failed: "danger",
  attention: "warn",
  skipped: "neutral",
  unknown: "neutral",
} as const satisfies Record<ScheduleRunStatus, string>;

export const LAST_RUN_LABELS: Record<ScheduleRunStatus, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  attention: "Needs attention",
  skipped: "Skipped",
  unknown: "Outcome not reported",
};

export const RUN_RESULT_TONES = {
  ok: "done",
  attention: "warn",
  failed: "danger",
} as const satisfies Record<ScheduleRunResult, string>;

export const RUN_RESULT_LABELS: Record<ScheduleRunResult, string> = {
  ok: "OK",
  attention: "Needs attention",
  failed: "Failed",
};

export const COVERAGE_TONES = {
  current: "done",
  stale: "warn",
  unreadable: "danger",
  unsupported: "neutral",
  disabled: "neutral",
} as const satisfies Record<ScheduleCoverageState, string>;

/** The pill text for a coverage state that is not `current`. */
export function coverageLabel(c: Pick<ScheduleSourceCoverage, "state" | "detail">): string {
  switch (c.state) {
    case "current":
      return "read";
    case "stale":
      return "may be out of date";
    case "unreadable":
      return "could not read";
    case "unsupported":
      return /not found/i.test(c.detail ?? "") ? "not installed" : "not supported here";
    case "disabled":
      return "switched off";
  }
}

/** Sources that may be hiding schedules, for the notice above the cards. */
export function coverageGaps(
  coverage: readonly ScheduleSourceCoverage[],
): ScheduleSourceCoverage[] {
  return coverage.filter(
    (c) => c.state === "unreadable" || c.state === "stale" || c.state === "disabled",
  );
}
