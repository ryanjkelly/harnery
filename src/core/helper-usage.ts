/**
 * Machine-wide record of helper agents: what each asked for, what it was sent
 * with, and, where the adapter reports it, which model answered. One JSON line
 * per helper turn or `run` worker, in one file per UTC day under
 * `~/.cache/harnery/helpers/` (honors `XDG_CACHE_HOME`). A writer that cannot
 * append to a shared file keeps its own `usage-YYYY-MM-DD.<writer>.jsonl`.
 *
 * It is deliberately not a coordination event: a helper limit covers every
 * project on the machine, and a project's event ledger covers one.
 *
 * This module imports only Node built-ins, so an adapter plugin can bundle it.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HelperUsageLine {
  /** ISO time the line was written. */
  ts: string;
  /** Adapter id, such as `claude-code`. */
  tool: string;
  /** A helper the adapter started itself, or a worker `run` started. */
  kind: "helper" | "run-worker";
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  /** What the request stated before the limit was applied. */
  asked_model?: string;
  asked_effort?: string;
  /** What was sent after the limit was applied. */
  sent_model?: string;
  sent_effort?: string;
  /** The model that answered, when the adapter reports it. */
  answered_model?: string;
  input_tokens?: number;
  output_tokens?: number;
  /** True when the limit changed this helper's model or effort. */
  lowered: boolean;
}

export interface HelperUsageSummary {
  since: string;
  /** Helpers and run workers recorded since `since`. */
  helpers: number;
  lowered: number;
  /** Count per model family or id: the answering model when known, otherwise
   * the model it was sent with, otherwise `unknown`. */
  by_model: Record<string, number>;
}

/** `~/.cache/harnery/helpers`. */
export function helperUsageDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg?.trim() ? xdg : join(homedir(), ".cache");
  return join(base, "harnery", "helpers");
}

/** `usage-YYYY-MM-DD.jsonl` for the UTC day of `ts`. */
export function helperUsageFile(ts: string, dir = helperUsageDir()): string {
  return join(dir, `usage-${ts.slice(0, 10)}.jsonl`);
}

/** Append one line. Never throws: a usage record must not break a helper. */
export function appendHelperUsage(line: HelperUsageLine, dir = helperUsageDir()): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(helperUsageFile(line.ts, dir), `${JSON.stringify(line)}\n`);
  } catch {
    // Best effort by design.
  }
}

/** How long daily files are kept before a read removes them. */
export const HELPER_USAGE_RETENTION_DAYS = 7;

export interface SummarizeHelperUsageOptions {
  /** Directory to read; defaults to `helperUsageDir()`. */
  dir?: string;
  /** The current time, for retention; defaults to `new Date()`. */
  now?: Date;
  /** Count only lines from this adapter id. */
  tool?: string;
  /** Maps a model id to a family name for `by_model`; `null` keeps the id. */
  family?: (model: string) => string | null;
}

// `usage-YYYY-MM-DD.jsonl`, or `usage-YYYY-MM-DD.<writer>.jsonl` for a writer
// that cannot append to a shared file and so keeps a file of its own.
const USAGE_FILE = /^usage-(\d{4}-\d{2}-\d{2})(?:\.[A-Za-z0-9_-]+)?\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseLine(raw: string): HelperUsageLine | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const line = value as HelperUsageLine;
    if (typeof line.ts !== "string" || Number.isNaN(Date.parse(line.ts))) return null;
    return line;
  } catch {
    return null;
  }
}

function lineModel(line: HelperUsageLine): string {
  for (const model of [line.answered_model, line.sent_model, line.asked_model]) {
    if (typeof model === "string" && model.trim()) return model;
  }
  return "unknown";
}

/**
 * Totals since a time, across every project on this machine. Also removes daily
 * files older than `HELPER_USAGE_RETENTION_DAYS`. Never throws on unreadable
 * files or malformed lines; a missing directory reads as zero helpers.
 */
export function summarizeHelperUsage(
  since: Date,
  options: SummarizeHelperUsageOptions = {},
): HelperUsageSummary {
  const dir = options.dir ?? helperUsageDir();
  const now = options.now ?? new Date();
  const summary: HelperUsageSummary = {
    since: since.toISOString(),
    helpers: 0,
    lowered: 0,
    by_model: {},
  };

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return summary;
  }

  const firstDay = utcDay(since);
  const sinceMs = since.getTime();
  const todayMs = Date.parse(`${utcDay(now)}T00:00:00Z`);
  const files: { day: string; name: string }[] = [];
  for (const name of names) {
    const match = USAGE_FILE.exec(name);
    if (!match) continue;
    const day = match[1] as string;
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isNaN(dayMs) && todayMs - dayMs > HELPER_USAGE_RETENTION_DAYS * DAY_MS) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // Best effort.
      }
      continue;
    }
    if (day >= firstDay) files.push({ day, name });
  }
  files.sort((a, b) => a.day.localeCompare(b.day));

  // One entry per helper: its latest line and whether any line was lowered.
  const helpers = new Map<
    string,
    { latest: HelperUsageLine; latestMs: number; lowered: boolean }
  >();
  let anonymous = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file.name), "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split("\n")) {
      const line = parseLine(raw);
      if (!line) continue;
      const ms = Date.parse(line.ts);
      if (ms < sinceMs) continue;
      if (options.tool !== undefined && line.tool !== options.tool) continue;
      const key =
        line.session_id && line.agent_id
          ? `${line.session_id}\u0000${line.agent_id}`
          : `\u0001${anonymous++}`;
      const seen = helpers.get(key);
      if (!seen) {
        helpers.set(key, { latest: line, latestMs: ms, lowered: line.lowered === true });
        continue;
      }
      if (line.lowered === true) seen.lowered = true;
      if (ms >= seen.latestMs) {
        seen.latest = line;
        seen.latestMs = ms;
      }
    }
  }

  for (const helper of helpers.values()) {
    summary.helpers += 1;
    if (helper.lowered) summary.lowered += 1;
    const model = lineModel(helper.latest);
    const key = (model !== "unknown" && options.family?.(model)) || model;
    summary.by_model[key] = (summary.by_model[key] ?? 0) + 1;
  }
  return summary;
}
