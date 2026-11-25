/**
 * Reader for the Codex app's automations.
 *
 * The app keeps them in the `automations` and `automation_runs` tables of its
 * private `sqlite/codex.db` store under the Codex home folder, and mirrors
 * each automation to `automations/<id>/automation.toml`. Neither layout is
 * documented, so the reader checks that every table and column it selects
 * exists and reports `unsupported` otherwise. From a copy made by the
 * shared SQLite helper it selects the schedule columns, the automation's
 * `prompt`, and, when the columns exist, `model`, `reasoning_effort` and
 * `cwds` (the folders it runs in, used as the project when `project_id` is
 * empty). The prompt becomes the record's `work.agent.prompt` after the
 * shared secret redactor (ADR 0281). From `automation_runs` it selects only
 * the automation id, status and time, so inbox titles and summaries and
 * archived message text never leave the store.
 *
 * When the database cannot be copied or opened, the reader falls back to the
 * TOML files and reports `stale`, since the app treats those files as a copy
 * that can lag. It reads only a few named keys from them (the prompt, model
 * and effort among them) and skips every other value. A prompt written as a
 * multi-line string is skipped too, so such a record has no `work`.
 *
 * Under WSL the app is a Windows program, so its home folder is on the
 * Windows side (`<drive>/Users/<name>/.codex`); the reader looks there when
 * the Linux home folder holds no store.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isWslKernel, isWslRuntime } from "../../../lib/op/detect.ts";
import { openScheduleSqliteCopy } from "../sqlite.ts";
import {
  isScheduleIsoInstant,
  type ScheduleCoverageState,
  type ScheduleLastRun,
  type ScheduleReadContext,
  type ScheduleReader,
  type ScheduleReadResult,
  type ScheduleRecord,
  type ScheduleRunStatus,
  type ScheduleRunsOn,
  type ScheduleTrigger,
} from "../types.ts";
import { buildScheduleWork } from "../work.ts";

/** The tables the reader reads. */
export const CODEX_APP_AUTOMATIONS_TABLE = "automations";
export const CODEX_APP_RUNS_TABLE = "automation_runs";

/** The only columns the reader selects from `automations`. */
export const CODEX_APP_AUTOMATION_COLUMNS = [
  "id",
  "name",
  "status",
  "rrule",
  "next_run_at",
  "last_run_at",
  "project_id",
  "target_thread_id",
  "prompt",
] as const;

/** Columns of `automations` selected only when the table has them. */
export const CODEX_APP_OPTIONAL_COLUMNS = ["model", "reasoning_effort", "cwds"] as const;

/** The only columns the reader selects from `automation_runs`. */
export const CODEX_APP_RUN_COLUMNS = ["automation_id", "status", "created_at"] as const;

/** The automations statement, given which optional columns exist. */
export function codexAppAutomationsSql(
  optional: readonly string[] = CODEX_APP_OPTIONAL_COLUMNS,
): string {
  const columns = [
    ...CODEX_APP_AUTOMATION_COLUMNS,
    ...CODEX_APP_OPTIONAL_COLUMNS.filter((c) => optional.includes(c)),
  ];
  return `SELECT ${columns.join(", ")} FROM ${CODEX_APP_AUTOMATIONS_TABLE} ORDER BY id`;
}

/** The newest run of each automation (ties are settled in code). */
export const CODEX_APP_RUNS_SQL = `SELECT r.automation_id, r.status, r.created_at FROM ${CODEX_APP_RUNS_TABLE} r WHERE r.created_at = (SELECT MAX(n.created_at) FROM ${CODEX_APP_RUNS_TABLE} n WHERE n.automation_id = r.automation_id) ORDER BY r.automation_id`;

/** The only keys the TOML fallback reads. */
export const CODEX_APP_TOML_KEYS = [
  "id",
  "name",
  "status",
  "rrule",
  "target_thread_id",
  "prompt",
  "model",
  "reasoning_effort",
] as const;

type AutomationRow = Record<
  (typeof CODEX_APP_AUTOMATION_COLUMNS)[number] | (typeof CODEX_APP_OPTIONAL_COLUMNS)[number],
  unknown
>;
type RunRow = Record<(typeof CODEX_APP_RUN_COLUMNS)[number], unknown>;
type TomlFields = Partial<Record<(typeof CODEX_APP_TOML_KEYS)[number], string>>;

/** Where Windows keeps user folders when seen from WSL. */
export const WSL_WINDOWS_USERS_DIR = "/mnt/c/Users";

const WINDOWS_SHARED_PROFILES = new Set(["all users", "default", "default user", "public"]);

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasStore(home: string): boolean {
  return existsSync(join(home, "sqlite", "codex.db")) || isDir(join(home, "automations"));
}

/**
 * Codex home folders found on the Windows side under `usersDir`, in name
 * order, skipping the shared profiles.
 */
export function codexAppWindowsHomes(usersDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(usersDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => !WINDOWS_SHARED_PROFILES.has(name.toLowerCase()))
    .sort()
    .map((name) => join(usersDir, name, ".codex"))
    .filter(hasStore);
}

/**
 * The Codex home folder to read, or null when none holds a store.
 *
 * Order: the test override (`storePaths["codex-app"]`, a `.db` file or a home
 * folder), then `CODEX_HOME`, then `<home>/.codex`, then, under WSL, the
 * first Windows profile with a store. An override or `CODEX_HOME` is used
 * as given, store or not.
 */
export function codexAppHome(
  ctx: Pick<ScheduleReadContext, "env" | "homeDir" | "platform" | "storePaths">,
  windowsUsersDir: string = WSL_WINDOWS_USERS_DIR,
  wslKernel: () => boolean = isWslKernel,
): string | null {
  const override = ctx.storePaths?.["codex-app"];
  if (override !== undefined) {
    return basename(override).endsWith(".db") ? dirname(dirname(override)) : override;
  }
  const fromEnv = ctx.env.CODEX_HOME;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const local = join(ctx.homeDir, ".codex");
  if (hasStore(local)) return local;
  // A process started by systemd, such as the dashboard service, has no WSL_*
  // variables, so the kernel release decides as well.
  if (isWslRuntime(ctx.env, ctx.platform, wslKernel)) {
    return codexAppWindowsHomes(windowsUsersDir)[0] ?? null;
  }
  return null;
}

/** The database file inside a Codex home, honouring a `.db` override. */
function databasePath(home: string, ctx: Pick<ScheduleReadContext, "storePaths">): string {
  const override = ctx.storePaths?.["codex-app"];
  if (override !== undefined && basename(override).endsWith(".db")) return override;
  return join(home, "sqlite", "codex.db");
}

/** An epoch-millisecond integer or an ISO string, as an ISO instant. */
export function codexAppInstant(value: unknown): string | null {
  if (isScheduleIsoInstant(value)) return value;
  const ms = typeof value === "bigint" ? Number(value) : value;
  if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Map an automation's `status` to `enabled`. */
export function codexAppEnabled(status: unknown): boolean | null {
  if (typeof status !== "string") return null;
  const s = status.trim().toUpperCase();
  if (s === "ACTIVE") return true;
  if (s === "PAUSED" || s === "DISABLED" || s === "ARCHIVED") return false;
  return null;
}

const RUN_STATUS_MAP: Record<string, ScheduleRunStatus> = {
  SUCCEEDED: "succeeded",
  SUCCESS: "succeeded",
  COMPLETED: "succeeded",
  COMPLETE: "succeeded",
  DONE: "succeeded",
  ACCEPTED: "succeeded",
  FAILED: "failed",
  FAILURE: "failed",
  ERROR: "failed",
  ERRORED: "failed",
  SKIPPED: "skipped",
  CANCELLED: "skipped",
  CANCELED: "skipped",
  PENDING_REVIEW: "attention",
  NEEDS_REVIEW: "attention",
  NEEDS_ATTENTION: "attention",
};

/** Map an `automation_runs.status` value to a run status. */
export function codexAppRunStatus(status: unknown): ScheduleRunStatus {
  if (typeof status !== "string") return "unknown";
  return RUN_STATUS_MAP[status.trim().toUpperCase()] ?? "unknown";
}

function rruleTrigger(rrule: unknown): ScheduleTrigger {
  if (typeof rrule === "string" && rrule.trim().length > 0) {
    return { kind: "rrule", rule: rrule.trim(), raw: rrule };
  }
  return { kind: "event", description: "unknown schedule type", raw: "unknown schedule type" };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function idOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function runsOn(machine: string, project: unknown, thread: unknown): ScheduleRunsOn {
  const out: ScheduleRunsOn = { host: machine };
  const p = nonEmpty(project);
  const t = nonEmpty(thread);
  if (p !== undefined) out.project = p;
  if (t !== undefined) out.thread = t;
  return out;
}

/** The first folder of a stored `cwds` JSON list, when it holds one. */
export function codexAppFirstCwd(cwds: unknown): string | undefined {
  if (typeof cwds !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(cwds);
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && parsed[0].length > 0) {
      return parsed[0];
    }
  } catch {
    // Not a list; leave the project unset.
  }
  return undefined;
}

/** The record's `work` for an automation's prompt, or undefined when there is none. */
export function codexAppWork(
  prompt: unknown,
  model: unknown,
  effort: unknown,
): ScheduleRecord["work"] {
  if (typeof prompt !== "string") return undefined;
  return buildScheduleWork({
    commands: [],
    agent: {
      adapter: "codex",
      model: nonEmpty(model) ?? null,
      effort: nonEmpty(effort) ?? null,
      prompt,
    },
  });
}

function lastRunOf(run: RunRow | undefined, lastRunAt: unknown): ScheduleLastRun | null {
  if (run) return { at: codexAppInstant(run.created_at), status: codexAppRunStatus(run.status) };
  const at = codexAppInstant(lastRunAt);
  return at === null ? null : { at, status: "unknown" };
}

function rowToRecord(
  row: AutomationRow,
  run: RunRow | undefined,
  machine: string,
): ScheduleRecord | null {
  const id = idOf(row.id);
  if (id.length === 0) return null;
  const work = codexAppWork(row.prompt, row.model, row.reasoning_effort);
  return {
    source: "codex-app",
    account: machine,
    id,
    title: typeof row.name === "string" ? row.name : "",
    trigger: rruleTrigger(row.rrule),
    runs_on: runsOn(
      machine,
      nonEmpty(row.project_id) ?? codexAppFirstCwd(row.cwds),
      row.target_thread_id,
    ),
    enabled: codexAppEnabled(row.status),
    next_run_at: codexAppInstant(row.next_run_at),
    last_run: lastRunOf(run, row.last_run_at),
    created_by: null,
    ...(work ? { work } : {}),
  };
}

// ---------------------------------------------------------------------------
// TOML fallback. A deliberately small reader: top-level `key = value` lines
// with a single-line basic or literal string value, for the named keys only.
// Multi-line strings are skipped whole.
// ---------------------------------------------------------------------------

function unescapeBasic(body: string): string | null {
  try {
    const value: unknown = JSON.parse(`"${body}"`);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Read the named keys from an `automation.toml` text. */
export function parseCodexAppToml(text: string): TomlFields {
  const out: TomlFields = {};
  const wanted = new Set<string>(CODEX_APP_TOML_KEYS);
  let inMultiline: '"""' | "'''" | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (inMultiline !== null) {
      if (line.includes(inMultiline)) inMultiline = null;
      continue;
    }
    if (line.startsWith("[")) break; // only top-level keys
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    const value = match[2] as string;
    const fence = value.startsWith('"""') ? '"""' : value.startsWith("'''") ? "'''" : null;
    if (fence !== null) {
      // A multi-line string is never one of the keys kept; skip it whole.
      if (!value.slice(3).includes(fence)) inMultiline = fence;
      continue;
    }
    if (!wanted.has(key)) continue;
    let parsed: string | null = null;
    const basic = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(value);
    const literal = /^'([^']*)'\s*(?:#.*)?$/.exec(value);
    if (basic) parsed = unescapeBasic(basic[1] as string);
    else if (literal) parsed = literal[1] as string;
    if (parsed !== null) out[key as keyof TomlFields] = parsed;
  }
  return out;
}

type TomlRead = { ok: true; records: ScheduleRecord[]; skipped: number } | { ok: false };

function readTomlFallback(home: string, machine: string): TomlRead {
  const dir = join(home, "automations");
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return { ok: false };
  }
  const records: ScheduleRecord[] = [];
  let skipped = 0;
  let readAny = false;
  for (const entry of entries) {
    const file = join(dir, entry, "automation.toml");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      if (existsSync(file)) skipped += 1;
      continue;
    }
    readAny = true;
    const fields = parseCodexAppToml(text);
    const id = (fields.id ?? entry).trim();
    if (id.length === 0) {
      skipped += 1;
      continue;
    }
    const work = codexAppWork(fields.prompt, fields.model, fields.reasoning_effort);
    records.push({
      source: "codex-app",
      account: machine,
      id,
      title: fields.name ?? "",
      trigger: rruleTrigger(fields.rrule),
      runs_on: runsOn(machine, undefined, fields.target_thread_id),
      enabled: codexAppEnabled(fields.status),
      next_run_at: null,
      last_run: null,
      created_by: null,
      ...(work ? { work } : {}),
    });
  }
  if (!readAny && skipped > 0) return { ok: false };
  return { ok: true, records, skipped };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const codexAppScheduleReader: ScheduleReader = {
  id: "codex-app",
  async read(ctx: ScheduleReadContext): Promise<ScheduleReadResult> {
    const readAt = new Date(ctx.now()).toISOString();
    const answer = (
      state: ScheduleCoverageState,
      records: ScheduleRecord[],
      detail?: string,
    ): ScheduleReadResult => ({
      coverage: {
        source: "codex-app",
        account: ctx.machine,
        state,
        ...(detail === undefined ? {} : { detail }),
        read_at: readAt,
      },
      records,
    });

    const home = codexAppHome(ctx);
    if (home === null) {
      return answer("unsupported", [], "The Codex app's store was not found on this machine.");
    }

    const fallback = (why: string): ScheduleReadResult => {
      const toml = readTomlFallback(home, ctx.machine);
      if (!toml.ok) {
        return answer(
          "unreadable",
          [],
          `The Codex app's store could not be read (${why}) and no automation files were readable.`,
        );
      }
      const left =
        toml.skipped === 0 ? "" : ` ${plural(toml.skipped, "file was", "files were")} left out.`;
      return answer(
        "stale",
        toml.records,
        `The Codex app's database could not be read (${why}); these come from its automation files, which can lag.${left}`,
      );
    };

    const opened = openScheduleSqliteCopy({ dbPath: databasePath(home, ctx), tmpDir: ctx.tmpDir });
    if (!opened.ok) {
      if (opened.reason === "missing" && !isDir(join(home, "automations"))) {
        return answer("unsupported", [], "The Codex app's store was not found on this machine.");
      }
      return fallback(opened.detail);
    }

    let records: ScheduleRecord[];
    let skipped = 0;
    try {
      const tables = opened.db.tables();
      for (const table of [CODEX_APP_AUTOMATIONS_TABLE, CODEX_APP_RUNS_TABLE]) {
        if (!tables.includes(table)) {
          return answer(
            "unsupported",
            [],
            `The Codex app's store has no ${table} table; its layout is not one this reader knows.`,
          );
        }
      }
      const checks: [string, readonly string[]][] = [
        [CODEX_APP_AUTOMATIONS_TABLE, CODEX_APP_AUTOMATION_COLUMNS],
        [CODEX_APP_RUNS_TABLE, CODEX_APP_RUN_COLUMNS],
      ];
      for (const [table, wanted] of checks) {
        const present = new Set(opened.db.columns(table));
        const missing = wanted.filter((column) => !present.has(column));
        if (missing.length > 0) {
          return answer(
            "unsupported",
            [],
            `The Codex app's ${table} table lacks ${missing.join(", ")}; its layout is not one this reader knows.`,
          );
        }
      }
      const newest = new Map<string, RunRow>();
      for (const run of opened.db.all<RunRow>(CODEX_APP_RUNS_SQL)) {
        const key = idOf(run.automation_id);
        if (key.length > 0 && !newest.has(key)) newest.set(key, run);
      }
      records = [];
      const present = new Set(opened.db.columns(CODEX_APP_AUTOMATIONS_TABLE));
      const sql = codexAppAutomationsSql(CODEX_APP_OPTIONAL_COLUMNS.filter((c) => present.has(c)));
      for (const row of opened.db.all<AutomationRow>(sql)) {
        const record = rowToRecord(row, newest.get(idOf(row.id)), ctx.machine);
        if (record) records.push(record);
        else skipped += 1;
      }
    } catch (err) {
      const code = err instanceof Error ? err.name : "error";
      return fallback(`a query failed (${code})`);
    } finally {
      opened.close();
    }
    return skipped === 0
      ? answer("current", records)
      : answer(
          "current",
          records,
          `${plural(skipped, "row", "rows")} had no automation id and ${skipped === 1 ? "was" : "were"} left out.`,
        );
  },
};
