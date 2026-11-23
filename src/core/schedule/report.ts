/**
 * The run's record and report, written by Harnery (never by the agent), plus
 * reading and pruning a job's run folders. A run folder is complete once its
 * `run.json` exists: the report is written first, the record last.
 */

import {
  chmodSync,
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateJsonAtomic } from "../storage/atomic-json.ts";
import { stateDirMode, stateFileMode } from "../storage/modes.ts";
import {
  parseScheduleTimeStamp,
  SCHEDULE_RUNS_KEPT,
  type ScheduleRunRecord,
  validateScheduleRunRecord,
} from "./job-types.ts";
import { scheduleRunRecordPath, scheduleRunReportPath, scheduleRunsDir } from "./paths.ts";

export interface ScheduleRunReportOptions {
  runDir: string;
  record: ScheduleRunRecord;
  /** The job's title, for the first line. */
  title: string;
  /** The agent's final message, verbatim. Null or absent when no agent ran. */
  agentText?: string | null;
}

function writePrivateTextAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: stateDirMode() });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(temporary, text, { encoding: "utf8", mode: stateFileMode() });
  try {
    chmodSync(temporary, stateFileMode());
  } catch {
    // Windows does not expose POSIX modes. The atomic write still applies.
  }
  renameSync(temporary, path);
}

function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/** The person-facing Markdown report for one run. */
export function renderScheduleRunReport(
  record: ScheduleRunRecord,
  title: string,
  agentText?: string | null,
): string {
  const lines: string[] = [];
  lines.push(`# ${title.replace(/\r?\n/g, " ")}: ${record.result}`);
  lines.push("");
  lines.push(
    `Due ${record.scheduled_for}; ran ${record.started_at} to ${record.finished_at}` +
      ` (${record.kind} run, id ${record.run_id}).`,
  );
  lines.push("");
  lines.push("## Gather commands");
  lines.push("");
  if (record.gather.length === 0) {
    lines.push("No gather commands.");
  } else {
    lines.push("| Command | State | Exit code | Duration | Output |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const g of record.gather) {
      lines.push(
        `| ${cell(g.name)} | ${g.state} | ${g.exit_code ?? "none"} | ${g.duration_ms} ms | ${cell(g.output_file)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Agent");
  lines.push("");
  if (record.agent === null) {
    lines.push("No agent ran.");
  } else {
    lines.push(
      `Adapter ${record.agent.adapter}; ${record.agent.ok ? "finished" : "did not finish"}; status line ${record.agent.status_line}.`,
    );
    lines.push("");
    lines.push("### Final message");
    lines.push("");
    const text = agentText ?? "";
    lines.push(text.trim().length > 0 ? text : "(no final message)");
  }
  const errors: string[] = [];
  for (const g of record.gather) if (g.error) errors.push(`- ${g.name}: ${g.error}`);
  if (record.agent?.error) errors.push(`- agent: ${record.agent.error}`);
  if (errors.length > 0) {
    lines.push("");
    lines.push("## Errors");
    lines.push("");
    lines.push(...errors);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Write `report.md` then `run.json` in the run folder, atomically and private.
 * Throws when the record does not validate, which is a caller bug.
 */
export function writeScheduleRunReport(opts: ScheduleRunReportOptions): void {
  const check = validateScheduleRunRecord(opts.record);
  if (!check.ok) {
    throw new Error(`writeScheduleRunReport: invalid run record: ${check.errors.join("; ")}`);
  }
  writePrivateTextAtomic(
    scheduleRunReportPath(opts.runDir),
    renderScheduleRunReport(opts.record, opts.title, opts.agentText),
  );
  writePrivateJsonAtomic(scheduleRunRecordPath(opts.runDir), opts.record);
}

/** Run folder names directly in the job's runs folder, oldest first. Symlinks and files are ignored. */
function runFolderNames(coordRoot: string, jobId: string): string[] {
  const dir = scheduleRunsDir(coordRoot, jobId);
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && parseScheduleTimeStamp(e.name) !== null)
    .map((e) => e.name)
    .sort();
}

/**
 * Delete the oldest run folders beyond `keep`. Only folders directly inside
 * the job's runs folder whose names parse as run stamps are ever touched.
 * Returns the deleted folder names.
 */
export function pruneScheduleRuns(
  coordRoot: string,
  jobId: string,
  keep: number = SCHEDULE_RUNS_KEPT,
): string[] {
  const names = runFolderNames(coordRoot, jobId);
  const excess = names.length - Math.max(0, Math.floor(keep));
  if (excess <= 0) return [];
  const dir = scheduleRunsDir(coordRoot, jobId);
  const removed: string[] = [];
  for (const name of names.slice(0, excess)) {
    rmSync(join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** A job's run records, newest first. Folders with a missing or invalid `run.json` are skipped. */
export function listScheduleRuns(coordRoot: string, jobId: string): ScheduleRunRecord[] {
  const dir = scheduleRunsDir(coordRoot, jobId);
  const records: ScheduleRunRecord[] = [];
  for (const name of runFolderNames(coordRoot, jobId).reverse()) {
    const path = scheduleRunRecordPath(join(dir, name));
    if (!existsSync(path)) continue;
    try {
      const check = validateScheduleRunRecord(JSON.parse(readFileSync(path, "utf8")));
      if (check.ok) records.push(check.value);
    } catch {
      // Unreadable or not JSON: skipped like any other invalid record.
    }
  }
  return records;
}

/** The newest valid run record, or null. */
export function latestScheduleRun(coordRoot: string, jobId: string): ScheduleRunRecord | null {
  return listScheduleRuns(coordRoot, jobId)[0] ?? null;
}
