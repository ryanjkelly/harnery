/**
 * Reader for the machine's own schedules: systemd user timers and the user's
 * crontab. Every system call goes through `ctx.runCommand`; the reader never
 * touches `process`, `os` or the filesystem itself.
 *
 * Each record's `work` says what the timer or line runs (ADR 0281): for a
 * systemd timer, every ExecStart= of the unit it triggers, in order, as the
 * argv systemd prints inside its `{ path=… ; argv[]=… }` wrapper; for a
 * crontab line, the command text after the schedule fields. Both go through
 * the shared secret redactor before they enter a record. The reader asks
 * systemd for no other Exec*= property and never for Environment= or
 * EnvironmentFile=, so environment values are never read; `env` stays empty.
 * Crontab variable assignments (`NAME=value` lines) are not kept either,
 * apart from the time zone.
 */

import type {
  ScheduleCommandResult,
  ScheduleCoverageState,
  ScheduleLastRun,
  ScheduleReadContext,
  ScheduleReader,
  ScheduleReadResult,
  ScheduleRecord,
  ScheduleTrigger,
} from "../types.ts";
import { validateScheduleRecord } from "../types.ts";
import { buildScheduleWork } from "../work.ts";

const SOURCE = "os-timer" as const;

/** Units passed to one `systemctl show` call. */
const SHOW_BATCH = 40;

const SHOW_PROPERTIES = [
  "Id",
  "Description",
  "TimersCalendar",
  "TimersMonotonic",
  "UnitFileState",
  "ActiveState",
  "Result",
  "ExecMainStatus",
  "ExecStart",
].join(",");

export const SYSTEMD_LIST_JSON_ARGV = [
  "systemctl",
  "--user",
  "list-timers",
  "--all",
  "--output=json",
  "--no-pager",
] as const;

export const SYSTEMD_LIST_TEXT_ARGV = [
  "systemctl",
  "--user",
  "list-timers",
  "--all",
  "--no-pager",
  "--no-legend",
] as const;

export const CRONTAB_LIST_ARGV = ["crontab", "-l"] as const;

/** The `systemctl show` argv for a batch of units. */
export function systemdShowArgv(units: readonly string[]): string[] {
  return ["systemctl", "--user", "show", ...units, `--property=${SHOW_PROPERTIES}`, "--no-pager"];
}

// ---------------------------------------------------------------------------
// Tool outcomes
// ---------------------------------------------------------------------------

type ToolOutcome =
  | { kind: "ok"; records: ScheduleRecord[] }
  | { kind: "absent" }
  | { kind: "failed"; detail: string };

function isAbsent(result: ScheduleCommandResult): boolean {
  return result.error === "ENOENT";
}

/** A short, single-line description of a failed command for coverage detail. */
function describeFailure(result: ScheduleCommandResult): string {
  if (result.error) return result.error;
  const line = result.stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const exit = result.exitCode === null ? "no exit code" : `exit ${result.exitCode}`;
  if (!line) return exit;
  return `${exit}: ${line.length > 120 ? `${line.slice(0, 117)}...` : line}`;
}

// ---------------------------------------------------------------------------
// systemd timers
// ---------------------------------------------------------------------------

interface TimerRow {
  unit: string;
  activates: string | null;
  /** ISO instant; null when none or unknown. */
  next: string | null;
  /** ISO instant of the last trigger; null when unknown. */
  last: string | null;
  /** True when the list says the timer has never fired. */
  neverRan: boolean;
}

function usecToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = Math.floor(value / 1000);
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

const UNIT_NAME = /^[A-Za-z0-9:_.\\@-]+\.[a-z]+$/;

/** Parse the JSON list. Returns null when the output is not the shape we know. */
export function parseTimerListJson(stdout: string): TimerRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: TimerRow[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.unit !== "string" || !UNIT_NAME.test(e.unit)) return null;
    const last = usecToIso(e.last);
    rows.push({
      unit: e.unit,
      activates:
        typeof e.activates === "string" && UNIT_NAME.test(e.activates) ? e.activates : null,
      next: usecToIso(e.next),
      last,
      neverRan: last === null,
    });
  }
  return rows;
}

/** A text-table date we can read without guessing a zone: only UTC/GMT. */
function textDateToIso(tokens: readonly string[]): string | null {
  // Expected: <weekday> YYYY-MM-DD HH:MM:SS <zone>
  if (tokens.length !== 4) return null;
  const [, day, time, zone] = tokens;
  if (zone !== "UTC" && zone !== "GMT") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "") || !/^\d{2}:\d{2}:\d{2}$/.test(time ?? "")) {
    return null;
  }
  const ms = Date.parse(`${day}T${time}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isNone(token: string | undefined): boolean {
  return token === "n/a" || token === "-";
}

/**
 * Parse the text table (NEXT, LEFT, LAST, PASSED, UNIT, ACTIVATES) from the
 * right. NEXT and LAST are read only when they are plainly UTC; any other zone
 * gives null rather than a guess.
 */
export function parseTimerListText(stdout: string): TimerRow[] {
  const rows: TimerRow[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const tokens = rawLine.trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) continue;
    const activates = tokens[tokens.length - 1] as string;
    const unit = tokens[tokens.length - 2] as string;
    if (!unit.endsWith(".timer") || !UNIT_NAME.test(unit)) continue;
    const before = tokens.slice(0, -2);
    // A timer that never fired ends with LAST and PASSED both "n/a" (or "-").
    const neverRan =
      before.length >= 2 && isNone(before[before.length - 1]) && isNone(before[before.length - 2]);
    let next: string | null = null;
    let last: string | null = null;
    // When both dates are present: 4 tokens NEXT, LEFT (1+ tokens), 4 tokens LAST, PASSED.
    // LEFT and PASSED vary in width, so read NEXT from the front only.
    if (before.length >= 4 && !isNone(before[0])) next = textDateToIso(before.slice(0, 4));
    if (!neverRan) {
      // LAST ends right before PASSED, whose width also varies ("41s ago",
      // "3min 41s ago"). Find the 4-token date by its YYYY-MM-DD anchor
      // after NEXT.
      for (let i = before.length - 1; i >= 5; i--) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(before[i] ?? "")) {
          last = textDateToIso(before.slice(i - 1, i + 3));
          break;
        }
      }
    }
    rows.push({
      unit,
      activates: UNIT_NAME.test(activates) ? activates : null,
      next,
      last,
      neverRan,
    });
  }
  return rows;
}

/** One unit's properties from `systemctl show`. Multi-valued keys keep every value. */
type UnitProps = Map<string, string[]>;

/** Parse `systemctl show` output: blocks separated by blank lines, keyed by `Id`. */
export function parseShowOutput(stdout: string): Map<string, UnitProps> {
  const units = new Map<string, UnitProps>();
  for (const block of stdout.split(/\r?\n\s*\r?\n/)) {
    const props: UnitProps = new Map();
    for (const line of block.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      // Keep ExecStart only; never another command or any environment value,
      // even if a systemd version returned one unasked.
      if (key.startsWith("Exec") && key !== "ExecMainStatus" && key !== "ExecStart") continue;
      if (key.startsWith("Environment") || key.startsWith("PassEnvironment")) continue;
      const list = props.get(key) ?? [];
      list.push(line.slice(eq + 1));
      props.set(key, list);
    }
    const id = props.get("Id")?.[0];
    if (id) units.set(id, props);
  }
  return units;
}

/**
 * The argv text of each command in a unit's ExecStart values, in order.
 * systemd prints each as `{ path=/bin/x ; argv[]=/bin/x a b ; ignore_errors=no ; … }`;
 * only the `argv[]` part is kept. systemd joins the arguments with spaces
 * and does not quote them, so the text is kept as one line, not split.
 */
export function parseExecStart(values: readonly string[]): string[] {
  const lines: string[] = [];
  for (const value of values) {
    for (const m of value.matchAll(/argv\[\]=(.*?) ; (?:ignore_errors|flags)=/g)) {
      const line = (m[1] ?? "").trim();
      if (line.length > 0) lines.push(line);
    }
  }
  return lines;
}

function first(props: UnitProps | undefined, key: string): string | undefined {
  const v = props?.get(key)?.[0];
  return v === undefined || v.length === 0 ? undefined : v;
}

const TIMESPAN_UNITS: Record<string, number> = {
  us: 0.001,
  usec: 0.001,
  ms: 1,
  msec: 1,
  s: 1000,
  sec: 1000,
  min: 60_000,
  m: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  month: 2_629_800_000,
  y: 31_557_600_000,
};

/** Parse a systemd timespan such as `5min` or `1h 30min`. Null when unknown. */
export function parseSystemdTimespan(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let consumed = "";
  for (const m of trimmed.matchAll(re)) {
    const factor = TIMESPAN_UNITS[m[2] ?? ""];
    if (factor === undefined) return null;
    total += Number(m[1]) * factor;
    consumed += m[0];
  }
  if (consumed.replace(/\s+/g, "") !== trimmed.replace(/\s+/g, "")) return null;
  const ms = Math.round(total);
  return ms >= 1 ? ms : null;
}

interface TimerSpec {
  key: string;
  value: string;
}

/** `{ OnUnitActiveUSec=5min ; next_elapse=... }` -> { key, value }. */
function parseTimerProperty(raw: string): TimerSpec | null {
  const m = /^\{\s*([A-Za-z]+)=(.*?)\s*;\s*next_elapse=/.exec(raw);
  if (m?.[1] && m[2] !== undefined && m[2].trim().length > 0) {
    return { key: m[1], value: m[2].trim() };
  }
  const bare = /^\{\s*([A-Za-z]+)=(.*?)\s*\}\s*$/.exec(raw);
  if (bare?.[1] && bare[2] !== undefined && bare[2].trim().length > 0) {
    return { key: bare[1], value: bare[2].trim() };
  }
  return null;
}

const REPEATING_MONOTONIC = new Set(["OnUnitActiveUSec", "OnUnitInactiveUSec"]);

const ONE_SHOT_MONOTONIC: Record<string, string> = {
  OnBootUSec: "after boot",
  OnStartupUSec: "after the user manager starts",
  OnActiveUSec: "after the timer starts",
};

/**
 * Map a timer's trigger properties to one trigger. A repeating monotonic
 * value wins (it is the cadence), then a calendar spec, then a one-shot
 * monotonic value. `raw` keeps every spec so a person can check the mapping.
 */
export function timerTrigger(props: UnitProps | undefined): ScheduleTrigger {
  const specs: TimerSpec[] = [];
  for (const key of ["TimersMonotonic", "TimersCalendar"]) {
    for (const raw of props?.get(key) ?? []) {
      const spec = parseTimerProperty(raw);
      if (spec) specs.push(spec);
    }
  }
  const raw = specs.map((s) => `${s.key}=${s.value}`).join("; ");
  for (const s of specs) {
    if (!REPEATING_MONOTONIC.has(s.key)) continue;
    const everyMs = parseSystemdTimespan(s.value);
    if (everyMs !== null) return { kind: "interval", everyMs, raw };
  }
  const calendars = specs.filter((s) => s.key === "OnCalendar").map((s) => s.value);
  if (calendars.length > 0) {
    return { kind: "event", description: `calendar: ${calendars.join("; ")}`, raw };
  }
  for (const s of specs) {
    const when = ONE_SHOT_MONOTONIC[s.key] ?? (REPEATING_MONOTONIC.has(s.key) ? "repeating" : null);
    if (when) return { kind: "event", description: `${when}: ${s.value}`, raw };
  }
  return { kind: "event", description: "systemd timer (trigger not reported)", raw };
}

function timerEnabled(props: UnitProps | undefined): boolean | null {
  const state = first(props, "UnitFileState");
  if (state === "enabled" || state === "static" || state === "enabled-runtime") return true;
  if (state === "disabled") return false;
  return null;
}

function timerLastRun(row: TimerRow, service: UnitProps | undefined): ScheduleLastRun | null {
  if (row.neverRan) return null;
  const result = first(service, "Result");
  const status = result === undefined ? "unknown" : result === "success" ? "succeeded" : "failed";
  if (row.last === null && status === "unknown") return null;
  return { at: row.last, status };
}

async function listTimers(
  ctx: ScheduleReadContext,
): Promise<
  { kind: "rows"; rows: TimerRow[] } | { kind: "absent" } | { kind: "failed"; detail: string }
> {
  const json = await ctx.runCommand(SYSTEMD_LIST_JSON_ARGV);
  if (isAbsent(json)) return { kind: "absent" };
  if (json.exitCode === 0 && !json.error) {
    const rows = parseTimerListJson(json.stdout);
    if (rows) return { kind: "rows", rows };
  }
  // The flag was refused or the output was not the JSON we know: read the table.
  const text = await ctx.runCommand(SYSTEMD_LIST_TEXT_ARGV);
  if (isAbsent(text)) return { kind: "absent" };
  if (text.exitCode === 0 && !text.error)
    return { kind: "rows", rows: parseTimerListText(text.stdout) };
  return {
    kind: "failed",
    detail: `systemctl could not list user timers (${describeFailure(text)})`,
  };
}

/**
 * A unit's Description=, or undefined when it has none. systemd falls back to
 * the unit's own name when Description= is unset, which says nothing new.
 */
export function unitDescription(
  props: UnitProps | undefined,
  unit: string | null | undefined,
): string | undefined {
  const text = first(props, "Description")?.trim();
  if (!text || text === unit) return undefined;
  return text;
}

async function readSystemd(ctx: ScheduleReadContext): Promise<ToolOutcome> {
  const listed = await listTimers(ctx);
  if (listed.kind !== "rows") return listed;
  const units: string[] = [];
  for (const row of listed.rows) {
    units.push(row.unit);
    if (row.activates) units.push(row.activates);
  }
  const props = new Map<string, UnitProps>();
  for (let i = 0; i < units.length; i += SHOW_BATCH) {
    const shown = await ctx.runCommand(systemdShowArgv(units.slice(i, i + SHOW_BATCH)));
    // A failed show leaves those units with unknown details, not a failed read.
    if (shown.exitCode !== 0 || shown.error) continue;
    for (const [id, p] of parseShowOutput(shown.stdout)) props.set(id, p);
  }
  const records: ScheduleRecord[] = listed.rows.map((row) => {
    const timer = props.get(row.unit);
    const service = row.activates ? props.get(row.activates) : undefined;
    const description = unitDescription(service, row.activates) ?? unitDescription(timer, row.unit);
    const exec = parseExecStart(service?.get("ExecStart") ?? []);
    const work =
      exec.length > 0
        ? buildScheduleWork({
            commands: exec.map((line) => ({ name: "ExecStart", line })),
            agent: null,
          })
        : undefined;
    return {
      source: SOURCE,
      account: ctx.machine,
      id: `systemd-user:${row.unit}`,
      title: row.unit,
      ...(description ? { description } : {}),
      trigger: timerTrigger(timer),
      runs_on: { host: ctx.machine },
      enabled: timerEnabled(timer),
      next_run_at: row.next,
      last_run: timerLastRun(row, service),
      created_by: null,
      ...(work ? { work } : {}),
    };
  });
  return { kind: "ok", records };
}

// ---------------------------------------------------------------------------
// crontab
// ---------------------------------------------------------------------------

const CRON_FIELD = /^[0-9A-Za-z*?/,#LW-]+$/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * Parse crontab text into records: the schedule fields become the trigger and
 * the command text after them becomes `work`, after the secret redactor.
 * Variable assignments are skipped (only CRON_TZ/TZ is read, for the zone).
 */
export function parseCrontab(text: string, machine: string): ScheduleRecord[] {
  const records: ScheduleRecord[] = [];
  let zone: string | undefined;
  let n = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const assignment = ASSIGNMENT.exec(line);
    if (assignment) {
      if (assignment[1] === "CRON_TZ" || assignment[1] === "TZ") {
        const value = (assignment[2] ?? "").trim().replace(/^["']|["']$/g, "");
        zone = IANA_ZONE.test(value) ? value : undefined;
      }
      continue;
    }
    n += 1;
    const tokens = line.split(/\s+/);
    let trigger: ScheduleTrigger;
    let command: string | null = null;
    const head = tokens[0] ?? "";
    if (head.startsWith("@")) {
      const macro = /^@[a-z]+$/.test(head) ? head : "@?";
      trigger = { kind: "event", description: `cron macro: ${macro}`, raw: macro };
      command = commandAfter(line, 1);
    } else {
      const fields = tokens.slice(0, 5);
      if (fields.length === 5 && tokens.length > 5 && fields.every((f) => CRON_FIELD.test(f))) {
        const expr = fields.join(" ");
        command = commandAfter(line, 5);
        trigger = zone
          ? { kind: "cron", expr, zone, raw: expr }
          : { kind: "cron", expr, raw: expr };
      } else {
        trigger = {
          kind: "event",
          description: "crontab line the reader does not recognise",
          raw: "",
        };
      }
    }
    records.push({
      source: SOURCE,
      account: machine,
      id: `crontab:${n}`,
      title: `crontab entry ${n}`,
      trigger,
      runs_on: { host: machine },
      enabled: true,
      next_run_at: null,
      last_run: null,
      created_by: null,
      ...(command
        ? { work: buildScheduleWork({ commands: [{ name: null, line: command }], agent: null }) }
        : {}),
    });
  }
  return records;
}

/** The text of a crontab line after its first `fields` whitespace-separated fields. */
function commandAfter(line: string, fields: number): string | null {
  const m = new RegExp(`^(?:\\S+\\s+){${fields}}(.*)$`).exec(line);
  const text = m?.[1]?.trim() ?? "";
  return text.length > 0 ? text : null;
}

async function readCrontab(ctx: ScheduleReadContext): Promise<ToolOutcome> {
  const result = await ctx.runCommand(CRONTAB_LIST_ARGV);
  if (isAbsent(result)) return { kind: "absent" };
  if (result.exitCode === 0 && !result.error) {
    return { kind: "ok", records: parseCrontab(result.stdout, ctx.machine) };
  }
  if (result.exitCode === 1 && !result.error && /no crontab for/i.test(result.stderr)) {
    return { kind: "ok", records: [] };
  }
  return { kind: "failed", detail: `crontab could not be read (${describeFailure(result)})` };
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

function settle(outcome: PromiseSettledResult<ToolOutcome>, tool: string): ToolOutcome {
  if (outcome.status === "fulfilled") return outcome.value;
  return { kind: "failed", detail: `${tool} could not be read (unexpected error)` };
}

function coverageFor(
  systemd: ToolOutcome,
  crontab: ToolOutcome,
): { state: ScheduleCoverageState; detail?: string } {
  if (systemd.kind === "absent" && crontab.kind === "absent") {
    return {
      state: "unsupported",
      detail: "Neither systemctl nor crontab is installed on this machine.",
    };
  }
  const notes: string[] = [];
  const failed: string[] = [];
  if (systemd.kind === "absent")
    notes.push("systemctl is not installed, so no systemd timers were read.");
  if (crontab.kind === "absent") notes.push("crontab is not installed, so no crontab was read.");
  if (systemd.kind === "failed") failed.push(`${systemd.detail}.`);
  if (crontab.kind === "failed") failed.push(`${crontab.detail}.`);
  if (failed.length > 0) return { state: "unreadable", detail: [...failed, ...notes].join(" ") };
  return notes.length > 0 ? { state: "current", detail: notes.join(" ") } : { state: "current" };
}

async function readOsTimers(ctx: ScheduleReadContext): Promise<ScheduleReadResult> {
  const readAt = new Date(ctx.now()).toISOString();
  const [systemdSettled, crontabSettled] = await Promise.allSettled([
    readSystemd(ctx),
    readCrontab(ctx),
  ]);
  const systemd = settle(systemdSettled, "systemctl");
  const crontab = settle(crontabSettled, "crontab");
  const records = [
    ...(systemd.kind === "ok" ? systemd.records : []),
    ...(crontab.kind === "ok" ? crontab.records : []),
  ].filter((r) => validateScheduleRecord(r).ok);
  const { state, detail } = coverageFor(systemd, crontab);
  return {
    coverage: {
      source: SOURCE,
      account: ctx.machine,
      state,
      ...(detail ? { detail } : {}),
      read_at: readAt,
    },
    records,
  };
}

export const osTimersScheduleReader: ScheduleReader = {
  id: SOURCE,
  async read(ctx) {
    try {
      return await readOsTimers(ctx);
    } catch {
      let readAt: string;
      try {
        readAt = new Date(ctx.now()).toISOString();
      } catch {
        readAt = new Date(0).toISOString();
      }
      return {
        coverage: {
          source: SOURCE,
          account: ctx.machine,
          state: "unreadable",
          detail: "The machine's timers could not be read because of an unexpected error.",
          read_at: readAt,
        },
        records: [],
      };
    }
  },
};
