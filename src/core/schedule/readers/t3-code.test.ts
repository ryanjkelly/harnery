import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ScheduleReadContext,
  validateScheduleReadResult,
  validateScheduleRecord,
} from "../types.ts";
import {
  T3_CODE_SCHEDULE_SQL,
  t3CodeLastRun,
  t3CodeScheduleReader,
  t3CodeScheduleTrigger,
  t3CodeStorePath,
} from "./t3-code.ts";

/** The table's full column list as T3 Code stores it. */
const REAL_COLUMNS = [
  "task_id",
  "title",
  "prompt",
  "enabled",
  "schedule_json",
  "project_id",
  "thread_id",
  "workspace_strategy_json",
  "model_selection_json",
  "runtime_mode",
  "interaction_mode",
  "created_by",
  "creation_source",
  "created_at",
  "updated_at",
  "next_run_at",
  "last_run_at",
  "last_run_status",
  "last_run_error",
  "run_count",
  "webhook_token",
  "webhook_secret",
  "last_run_webhook_delivery_id",
  "thread_mode",
];

const NEVER_SELECTED = [
  "prompt",
  "webhook_token",
  "webhook_secret",
  "last_run_error",
  "workspace_strategy_json",
  "model_selection_json",
  "last_run_webhook_delivery_id",
  "created_by",
  "creation_source",
];

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnery-t3-reader-test-"));
  home = join(root, "home");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(overrides: Partial<ScheduleReadContext> = {}): ScheduleReadContext {
  return {
    coordRoot: join(root, "project"),
    env: {},
    homeDir: home,
    platform: "linux",
    machine: "box-1",
    now: () => Date.parse("2026-11-22T12:00:00.000Z"),
    runCommand: async () => ({ exitCode: null, stdout: "", stderr: "", error: "not used" }),
    tmpDir: join(root, "tmp"),
    ...overrides,
  };
}

type Row = Record<string, string | number | null>;

function baseRow(overrides: Row): Row {
  return {
    task_id: "scheduled-task:x",
    title: "A task",
    prompt: "SECRET-PROMPT text",
    enabled: 1,
    schedule_json: '{"type":"interval","everyMs":60000}',
    project_id: "project-1",
    thread_id: "thread-1",
    workspace_strategy_json: '{"mode":"SECRET-WORKSPACE"}',
    model_selection_json: '{"model":"SECRET-MODEL"}',
    runtime_mode: "full",
    interaction_mode: "default",
    created_by: "SECRET-CREATOR",
    creation_source: "SECRET-SOURCE",
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    next_run_at: null,
    last_run_at: null,
    last_run_status: "never",
    last_run_error: "SECRET-ERROR",
    run_count: 0,
    webhook_token: "SECRET-TOKEN",
    webhook_secret: "SECRET-WEBHOOK",
    last_run_webhook_delivery_id: "SECRET-DELIVERY",
    thread_mode: "existing",
    ...overrides,
  };
}

function writeStore(path: string, columns: string[], rows: Row[], wal = false): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE scheduled_tasks (${columns.map((c) => `${c}`).join(", ")})`);
  for (const row of rows) {
    const names = columns.filter((c) => c in row);
    db.query(
      `INSERT INTO scheduled_tasks (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    ).run(...names.map((n) => row[n] ?? null));
  }
  db.close();
}

const KNOWN_ROWS: Row[] = [
  baseRow({
    task_id: "scheduled-task:once",
    title: "Run once",
    schedule_json: '{"type":"once","runAt":"2026-11-08T05:45:00.000Z"}',
    enabled: 0,
    next_run_at: null,
    last_run_at: "2026-11-08T05:45:00.641Z",
    last_run_status: "succeeded",
  }),
  baseRow({
    task_id: "scheduled-task:interval",
    title: "Hourly",
    schedule_json: '{"type":"interval","everyMs":3600000}',
    next_run_at: "2026-11-22T13:00:00.000Z",
    last_run_at: "2026-11-22T12:00:00.000Z",
    last_run_status: "failed",
  }),
  baseRow({
    task_id: "scheduled-task:fixed",
    title: "Weekday morning",
    schedule_json: '{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}',
    project_id: null,
    thread_id: "",
    next_run_at: "not a time",
    last_run_status: "never",
  }),
  baseRow({
    task_id: "scheduled-task:webhook",
    title: "On push",
    schedule_json: '{"type":"webhook","filter":{"branch":"SECRET-FILTER"},"secret":"SECRET-JSON"}',
    enabled: null,
    last_run_status: "queued",
    last_run_at: "garbage",
  }),
  baseRow({
    task_id: "scheduled-task:mystery",
    title: "Mystery",
    schedule_json: "{not json SECRET-BROKEN",
    last_run_status: null,
  }),
];

describe("t3CodeScheduleReader", () => {
  test("is the opt-in t3-code reader", () => {
    expect(t3CodeScheduleReader.id).toBe("t3-code");
    expect(t3CodeScheduleReader.requiresOptIn).toBe(true);
  });

  test("the SQL names only schedule columns", () => {
    const named = T3_CODE_SCHEDULE_SQL.toLowerCase();
    for (const column of NEVER_SELECTED) {
      expect(named.includes(column)).toBe(false);
    }
    expect(named).not.toContain("*");
  });

  test("reads a known layout from the default store path", async () => {
    const storePath = join(home, ".t3", "userdata", "statev2.sqlite");
    expect(t3CodeStorePath(ctx())).toBe(storePath);
    writeStore(storePath, REAL_COLUMNS, KNOWN_ROWS, true);
    const result = await t3CodeScheduleReader.read(ctx());
    expect(validateScheduleReadResult(result)).toEqual({ ok: true, value: result });
    for (const record of result.records) {
      expect(validateScheduleRecord(record).ok).toBe(true);
    }
    expect(result.coverage).toEqual({
      source: "t3-code",
      account: "box-1",
      state: "current",
      read_at: "2026-11-22T12:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    const byId = Object.fromEntries(result.records.map((r) => [r.id, r]));
    expect(result.records.map((r) => r.id)).toEqual([
      "scheduled-task:fixed",
      "scheduled-task:interval",
      "scheduled-task:mystery",
      "scheduled-task:once",
      "scheduled-task:webhook",
    ]);
    expect(byId["scheduled-task:once"]).toEqual({
      source: "t3-code",
      account: "box-1",
      id: "scheduled-task:once",
      title: "Run once",
      trigger: {
        kind: "once",
        at: "2026-11-08T05:45:00.000Z",
        raw: "once at 2026-11-08T05:45:00.000Z",
      },
      runs_on: { host: "box-1", project: "project-1", thread: "thread-1" },
      enabled: false,
      next_run_at: null,
      last_run: { at: "2026-11-08T05:45:00.641Z", status: "succeeded" },
      created_by: null,
    });
    expect(byId["scheduled-task:interval"]).toMatchObject({
      trigger: { kind: "interval", everyMs: 3600000, raw: "every 3600000 ms" },
      enabled: true,
      next_run_at: "2026-11-22T13:00:00.000Z",
      last_run: { at: "2026-11-22T12:00:00.000Z", status: "failed" },
    });
    expect(byId["scheduled-task:fixed"]).toMatchObject({
      trigger: {
        kind: "cron",
        expr: "0 9 * * 1,2,3,4,5",
        raw: "fixed time 09:00 on weekdays 1,2,3,4,5",
      },
      runs_on: { host: "box-1" },
      next_run_at: null,
      last_run: null,
    });
    expect(byId["scheduled-task:fixed"]?.trigger).not.toHaveProperty("zone");
    expect(byId["scheduled-task:webhook"]).toMatchObject({
      trigger: { kind: "event", description: "webhook", raw: "webhook" },
      enabled: null,
      last_run: { at: null, status: "unknown" },
    });
    expect(byId["scheduled-task:mystery"]).toMatchObject({
      trigger: { kind: "event", description: "unknown schedule type" },
      last_run: null,
    });
    // The copy is gone after the read.
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  });

  test("honours a store path override", async () => {
    const storePath = join(root, "elsewhere", "store.sqlite");
    writeStore(storePath, REAL_COLUMNS, [baseRow({})]);
    const result = await t3CodeScheduleReader.read(ctx({ storePaths: { "t3-code": storePath } }));
    expect(result.coverage.state).toBe("current");
    expect(result.records.map((r) => r.id)).toEqual(["scheduled-task:x"]);
  });

  test("a renamed column is an unsupported layout with no records", async () => {
    const storePath = join(home, ".t3", "userdata", "statev2.sqlite");
    const columns = REAL_COLUMNS.map((c) => (c === "schedule_json" ? "schedule_spec" : c));
    writeStore(storePath, columns, [baseRow({ schedule_spec: '{"type":"webhook"}' })]);
    const result = await t3CodeScheduleReader.read(ctx());
    expect(result.records).toEqual([]);
    expect(result.coverage.state).toBe("unsupported");
    expect(result.coverage.detail).toContain("schedule_json");
    expect(validateScheduleReadResult(result).ok).toBe(true);
  });

  test("a store without the table is unsupported", async () => {
    const storePath = join(home, ".t3", "userdata", "statev2.sqlite");
    mkdirSync(dirname(storePath), { recursive: true });
    const db = new Database(storePath);
    db.exec("CREATE TABLE something_else (id TEXT)");
    db.close();
    const result = await t3CodeScheduleReader.read(ctx());
    expect(result.coverage.state).toBe("unsupported");
    expect(result.records).toEqual([]);
  });

  test("a missing store is unsupported, not an empty current list", async () => {
    const result = await t3CodeScheduleReader.read(ctx());
    expect(result.records).toEqual([]);
    expect(result.coverage.state).toBe("unsupported");
    expect(result.coverage.detail).toContain("not found");
    expect(validateScheduleReadResult(result).ok).toBe(true);
  });

  test("a store that is not a database is unreadable", async () => {
    const storePath = join(home, ".t3", "userdata", "statev2.sqlite");
    mkdirSync(storePath, { recursive: true });
    const result = await t3CodeScheduleReader.read(ctx());
    expect(result.coverage.state).toBe("unreadable");
    expect(result.records).toEqual([]);
    expect(validateScheduleReadResult(result).ok).toBe(true);
  });

  test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "a store that cannot be read is unreadable",
    async () => {
      const storePath = join(home, ".t3", "userdata", "statev2.sqlite");
      writeStore(storePath, REAL_COLUMNS, [baseRow({})]);
      chmodSync(storePath, 0o000);
      try {
        const result = await t3CodeScheduleReader.read(ctx());
        expect(result.coverage.state).toBe("unreadable");
        expect(result.records).toEqual([]);
      } finally {
        chmodSync(storePath, 0o600);
      }
    },
  );

  test("a row without a task id is left out and counted", async () => {
    const storePath = join(home, ".t3", "userdata", "statev2.sqlite");
    writeStore(storePath, REAL_COLUMNS, [baseRow({}), baseRow({ task_id: null })]);
    const result = await t3CodeScheduleReader.read(ctx());
    expect(result.coverage.state).toBe("current");
    expect(result.records).toHaveLength(1);
    expect(result.coverage.detail).toContain("1 row");
  });
});

describe("t3CodeScheduleTrigger", () => {
  test("maps every weekday, or none, to a star", () => {
    expect(
      t3CodeScheduleTrigger('{"type":"fixed_time","timeOfDay":"7:05","weekdays":[0,1,2,3,4,5,6]}'),
    ).toEqual({ kind: "cron", expr: "5 7 * * *", raw: "fixed time 07:05 every day" });
    expect(t3CodeScheduleTrigger('{"type":"fixed_time","timeOfDay":"23:59"}')).toMatchObject({
      expr: "59 23 * * *",
    });
  });

  test("rejects malformed fields instead of guessing", () => {
    for (const json of [
      '{"type":"fixed_time","timeOfDay":"25:00"}',
      '{"type":"fixed_time","timeOfDay":"09:00","weekdays":[7]}',
      '{"type":"interval","everyMs":0}',
      '{"type":"interval","everyMs":"60000"}',
      '{"type":"once","runAt":"tomorrow"}',
      '{"type":"cron","expr":"* * * * *"}',
      "[]",
      "null",
    ]) {
      expect(t3CodeScheduleTrigger(json)).toEqual({
        kind: "event",
        description: "unknown schedule type",
        raw: "unknown schedule type",
      });
    }
    expect(t3CodeScheduleTrigger(null).kind).toBe("event");
  });
});

describe("t3CodeLastRun", () => {
  test("maps the stored statuses", () => {
    expect(t3CodeLastRun("never", "2026-11-01T00:00:00Z")).toBeNull();
    expect(t3CodeLastRun(null, null)).toBeNull();
    expect(t3CodeLastRun("error", "2026-11-01T00:00:00Z")).toEqual({
      at: "2026-11-01T00:00:00Z",
      status: "failed",
    });
    expect(t3CodeLastRun("running", null)).toEqual({ at: null, status: "unknown" });
  });
});
