/**
 * Reader for T3 Code's scheduled tasks.
 *
 * T3 Code keeps them in the `scheduled_tasks` table of its private
 * `statev2.sqlite` store. The layout is undocumented, so the reader checks
 * that the table and every column it selects exist and reports `unsupported`
 * otherwise. It selects named schedule columns only, from a copy of the store
 * made by the shared SQLite helper; no other column of the table is ever
 * named in SQL, so task text and webhook credentials never leave the store.
 */

import { join } from "node:path";
import { openScheduleSqliteCopy } from "../sqlite.ts";
import {
  isScheduleIsoInstant,
  type ScheduleCoverageState,
  type ScheduleLastRun,
  type ScheduleReadContext,
  type ScheduleReader,
  type ScheduleReadResult,
  type ScheduleRecord,
  type ScheduleRunsOn,
  type ScheduleTrigger,
} from "../types.ts";

/** The table the reader reads. */
export const T3_CODE_SCHEDULE_TABLE = "scheduled_tasks";

/** The only columns the reader selects. */
export const T3_CODE_SCHEDULE_COLUMNS = [
  "task_id",
  "title",
  "enabled",
  "schedule_json",
  "project_id",
  "thread_id",
  "next_run_at",
  "last_run_at",
  "last_run_status",
] as const;

/** The one statement the reader runs against the copy. */
export const T3_CODE_SCHEDULE_SQL = `SELECT ${T3_CODE_SCHEDULE_COLUMNS.join(", ")} FROM ${T3_CODE_SCHEDULE_TABLE} ORDER BY task_id`;

type T3Row = Record<(typeof T3_CODE_SCHEDULE_COLUMNS)[number], unknown>;

/** Where T3 Code keeps its store, unless a test overrides it. */
export function t3CodeStorePath(ctx: Pick<ScheduleReadContext, "homeDir" | "storePaths">): string {
  return ctx.storePaths?.["t3-code"] ?? join(ctx.homeDir, ".t3", "userdata", "statev2.sqlite");
}

const UNKNOWN_SCHEDULE: ScheduleTrigger = {
  kind: "event",
  description: "unknown schedule type",
  raw: "unknown schedule type",
};

const TIME_OF_DAY = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Map a stored `schedule_json` value to a trigger. `raw` is a short summary
 * built from the known fields, never the stored JSON, because a webhook
 * schedule's JSON can hold filter values and secrets.
 */
export function t3CodeScheduleTrigger(scheduleJson: unknown): ScheduleTrigger {
  if (typeof scheduleJson !== "string") return UNKNOWN_SCHEDULE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(scheduleJson);
  } catch {
    return UNKNOWN_SCHEDULE;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return UNKNOWN_SCHEDULE;
  const s = parsed as Record<string, unknown>;
  switch (s.type) {
    case "once":
      if (!isScheduleIsoInstant(s.runAt)) return UNKNOWN_SCHEDULE;
      return { kind: "once", at: s.runAt, raw: `once at ${s.runAt}` };
    case "interval": {
      const everyMs = s.everyMs;
      if (typeof everyMs !== "number" || !Number.isSafeInteger(everyMs) || everyMs < 1) {
        return UNKNOWN_SCHEDULE;
      }
      return { kind: "interval", everyMs, raw: `every ${everyMs} ms` };
    }
    case "fixed_time": {
      const match = typeof s.timeOfDay === "string" ? TIME_OF_DAY.exec(s.timeOfDay) : null;
      if (!match) return UNKNOWN_SCHEDULE;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      let days = "*";
      if (s.weekdays !== undefined && s.weekdays !== null) {
        if (!Array.isArray(s.weekdays)) return UNKNOWN_SCHEDULE;
        const list = s.weekdays as unknown[];
        if (!list.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)) {
          return UNKNOWN_SCHEDULE;
        }
        const unique = [...new Set(list as number[])].sort((a, b) => a - b);
        if (unique.length > 0 && unique.length < 7) days = unique.join(",");
      }
      const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      return {
        kind: "cron",
        expr: `${minute} ${hour} * * ${days}`,
        raw:
          days === "*" ? `fixed time ${time} every day` : `fixed time ${time} on weekdays ${days}`,
      };
    }
    case "webhook":
      return { kind: "event", description: "webhook", raw: "webhook" };
    default:
      return UNKNOWN_SCHEDULE;
  }
}

/** Map `last_run_status` and `last_run_at` to the record's last run. */
export function t3CodeLastRun(status: unknown, at: unknown): ScheduleLastRun | null {
  if (status === null || status === undefined || status === "never") return null;
  const when = isScheduleIsoInstant(at) ? at : null;
  if (status === "succeeded") return { at: when, status: "succeeded" };
  if (status === "failed" || status === "error") return { at: when, status: "failed" };
  return { at: when, status: "unknown" };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toRecord(row: T3Row, machine: string): ScheduleRecord | null {
  const id =
    typeof row.task_id === "string"
      ? row.task_id
      : typeof row.task_id === "number"
        ? String(row.task_id)
        : "";
  if (id.trim().length === 0) return null;
  const runsOn: ScheduleRunsOn = { host: machine };
  const project = nonEmpty(row.project_id);
  const thread = nonEmpty(row.thread_id);
  if (project !== undefined) runsOn.project = project;
  if (thread !== undefined) runsOn.thread = thread;
  const enabled =
    row.enabled === 1 || row.enabled === 1n || row.enabled === true
      ? true
      : row.enabled === 0 || row.enabled === 0n || row.enabled === false
        ? false
        : null;
  return {
    source: "t3-code",
    account: machine,
    id,
    title: typeof row.title === "string" ? row.title : "",
    trigger: t3CodeScheduleTrigger(row.schedule_json),
    runs_on: runsOn,
    enabled,
    next_run_at: isScheduleIsoInstant(row.next_run_at) ? row.next_run_at : null,
    last_run: t3CodeLastRun(row.last_run_status, row.last_run_at),
    created_by: null,
  };
}

export const t3CodeScheduleReader: ScheduleReader = {
  id: "t3-code",
  requiresOptIn: true,
  async read(ctx: ScheduleReadContext): Promise<ScheduleReadResult> {
    const readAt = new Date(ctx.now()).toISOString();
    const answer = (
      state: ScheduleCoverageState,
      records: ScheduleRecord[],
      detail?: string,
    ): ScheduleReadResult => ({
      coverage: {
        source: "t3-code",
        account: ctx.machine,
        state,
        ...(detail === undefined ? {} : { detail }),
        read_at: readAt,
      },
      records,
    });

    const opened = openScheduleSqliteCopy({ dbPath: t3CodeStorePath(ctx), tmpDir: ctx.tmpDir });
    if (!opened.ok) {
      switch (opened.reason) {
        case "missing":
          return answer("unsupported", [], "T3 Code's store was not found on this machine.");
        case "no-engine":
          return answer("unsupported", [], `T3 Code's store needs SQLite: ${opened.detail}.`);
        default:
          return answer("unreadable", [], `T3 Code's store could not be read: ${opened.detail}.`);
      }
    }
    try {
      if (!opened.db.tables().includes(T3_CODE_SCHEDULE_TABLE)) {
        return answer(
          "unsupported",
          [],
          `T3 Code's store has no ${T3_CODE_SCHEDULE_TABLE} table; its layout is not one this reader knows.`,
        );
      }
      const present = new Set(opened.db.columns(T3_CODE_SCHEDULE_TABLE));
      const missing = T3_CODE_SCHEDULE_COLUMNS.filter((column) => !present.has(column));
      if (missing.length > 0) {
        return answer(
          "unsupported",
          [],
          `T3 Code's ${T3_CODE_SCHEDULE_TABLE} table lacks ${missing.join(", ")}; its layout is not one this reader knows.`,
        );
      }
      const records: ScheduleRecord[] = [];
      let skipped = 0;
      for (const row of opened.db.all<T3Row>(T3_CODE_SCHEDULE_SQL)) {
        const record = toRecord(row, ctx.machine);
        if (record) records.push(record);
        else skipped += 1;
      }
      return skipped === 0
        ? answer("current", records)
        : answer(
            "current",
            records,
            `${skipped} row${skipped === 1 ? "" : "s"} had no task id and ${skipped === 1 ? "was" : "were"} left out.`,
          );
    } catch (err) {
      const code = err instanceof Error ? err.name : "error";
      return answer("unreadable", [], `T3 Code's store could not be queried (${code}).`);
    } finally {
      opened.close();
    }
  },
};
