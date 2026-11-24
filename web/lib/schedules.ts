/**
 * Schedules from every source, read through `harn schedule list` and
 * `harn schedule history` so the dashboard and the CLI share one
 * implementation. The pure helpers below (trigger text, sort order, run
 * durations) are what the Schedules page renders with.
 */

import type { ScheduleRunResult } from "../../src/core/schedule/job-types";
import type {
  ScheduleRecord,
  ScheduleRunStatus,
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
// Pure helpers
// ---------------------------------------------------------------------------

const UNITS: Array<[ms: number, singular: string, plural: string]> = [
  [86_400_000, "day", "days"],
  [3_600_000, "hour", "hours"],
  [60_000, "min", "min"],
  [1_000, "sec", "sec"],
];

/** "every 5 min", "every 2 hours", "every day", "every 90 sec". */
export function formatInterval(everyMs: number): string {
  for (const [unit, singular, plural] of UNITS) {
    if (everyMs >= unit && everyMs % unit === 0) {
      const n = everyMs / unit;
      if (n === 1) return unit === 86_400_000 ? "every day" : `every 1 ${singular}`;
      return `every ${n} ${plural}`;
    }
  }
  return `every ${everyMs} ms`;
}

function clock(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/**
 * Plain text for a daily cron (`M H[,H...] * * *`), or null for anything
 * else. The times are wall-clock times in the cron's own zone.
 */
export function describeDailyCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hours, dom, month, dow] = fields;
  if (dom !== "*" || month !== "*" || dow !== "*") return null;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}(,\d{1,2})*$/.test(hours)) return null;
  const m = Number(minute);
  const hs = hours.split(",").map(Number);
  if (m > 59 || hs.some((h) => h > 23)) return null;
  return `daily at ${hs.map((h) => clock(h, m)).join(" and ")}`;
}

export interface TriggerText {
  /** Human text. For `once` the page appends the formatted `at`. */
  text: string;
  /** Set for a `once` trigger: the instant to render in the viewer's settings. */
  at?: string;
  /** The source's own trigger text, for a hover title. */
  raw: string;
}

export function formatTrigger(trigger: ScheduleTrigger): TriggerText {
  switch (trigger.kind) {
    case "interval":
      return { text: formatInterval(trigger.everyMs), raw: trigger.raw };
    case "cron": {
      const daily = describeDailyCron(trigger.expr);
      const zone = trigger.zone ? ` (${trigger.zone})` : "";
      return { text: `${daily ?? `cron ${trigger.expr}`}${zone}`, raw: trigger.raw };
    }
    case "once":
      return { text: "once at", at: trigger.at, raw: trigger.raw };
    case "rrule":
      return { text: trigger.rule.replace(/^RRULE:/i, ""), raw: trigger.raw };
    case "event":
      return { text: trigger.description, raw: trigger.raw };
  }
}

/** 0 for a failed last run, 1 for one that needs attention, 2 otherwise. */
export function problemRank(record: Pick<ScheduleRecord, "last_run">): number {
  const status = record.last_run?.status;
  if (status === "failed") return 0;
  if (status === "attention") return 1;
  return 2;
}

/** Problems first (failed, then attention), then soonest next run; no next run last. */
export function sortSchedules<T extends Pick<ScheduleRecord, "last_run" | "next_run_at" | "title">>(
  records: readonly T[],
): T[] {
  const next = (r: T): number => {
    const t = r.next_run_at ? Date.parse(r.next_run_at) : Number.NaN;
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return [...records].sort((a, b) => {
    const rank = problemRank(a) - problemRank(b);
    if (rank !== 0) return rank;
    const na = next(a);
    const nb = next(b);
    if (na !== nb) return na < nb ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

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

/** Tones for the shared colour grammar (lib/tone.ts). */
export const LAST_RUN_TONES = {
  succeeded: "done",
  failed: "danger",
  attention: "warn",
  skipped: "neutral",
  unknown: "neutral",
} as const satisfies Record<ScheduleRunStatus, string>;

export const RUN_RESULT_TONES = {
  ok: "done",
  attention: "warn",
  failed: "danger",
} as const satisfies Record<ScheduleRunResult, string>;

export const COVERAGE_TONES = {
  current: "done",
  stale: "warn",
  unreadable: "danger",
  unsupported: "neutral",
  disabled: "neutral",
} as const;
