import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ScheduleReadContext,
  validateScheduleReadResult,
  validateScheduleRecord,
} from "../types.ts";
import {
  CODEX_APP_RUNS_SQL,
  codexAppAutomationsSql,
  codexAppEnabled,
  codexAppHome,
  codexAppInstant,
  codexAppRunStatus,
  codexAppScheduleReader,
  codexAppWindowsHomes,
  parseCodexAppToml,
} from "./codex-app.ts";

/** The tables' full column lists as the app stores them. */
const AUTOMATION_COLUMNS = [
  "id",
  "name",
  "prompt",
  "status",
  "next_run_at",
  "last_run_at",
  "cwds",
  "rrule",
  "model",
  "reasoning_effort",
  "created_at",
  "updated_at",
  "target_type",
  "project_id",
  "kind",
  "target_thread_id",
  "execution_environment",
  "local_environment_config_path",
  "plugin_template_id",
  "notification_policy",
  "account_id",
  "user_id",
  "installation_id",
  "legacy_automation_id",
  "auto_archive",
  "next_run_nominal_at",
  "remote_host",
  "model_authored_prompt",
];

const RUN_COLUMNS = [
  "thread_id",
  "automation_id",
  "status",
  "read_at",
  "thread_title",
  "source_cwd",
  "inbox_title",
  "inbox_summary",
  "created_at",
  "updated_at",
  "archived_user_message",
  "archived_assistant_message",
  "archived_reason",
];

const NEVER_SELECTED = [
  "account_id",
  "user_id",
  "installation_id",
  "local_environment_config_path",
  "remote_host",
  "execution_environment",
  "thread_title",
  "source_cwd",
  "inbox_title",
  "inbox_summary",
  "archived_user_message",
  "archived_assistant_message",
  "archived_reason",
];

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnery-codex-reader-test-"));
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

function insertAll(db: Database, table: string, columns: string[], rows: Row[]): void {
  db.exec(`CREATE TABLE ${table} (${columns.join(", ")})`);
  for (const row of rows) {
    const names = columns.filter((c) => c in row);
    db.query(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    ).run(...names.map((n) => row[n] ?? null));
  }
}

function writeStore(
  path: string,
  automations: Row[],
  runs: Row[],
  opts: { automationColumns?: string[]; wal?: boolean } = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (opts.wal) db.exec("PRAGMA journal_mode = WAL");
  insertAll(db, "automations", opts.automationColumns ?? AUTOMATION_COLUMNS, automations);
  insertAll(db, "automation_runs", RUN_COLUMNS, runs);
  db.close();
}

function automation(overrides: Row): Row {
  return {
    id: "automation-x",
    name: "An automation",
    prompt: "Review open issues.\nUse ghp_SECRETPROMPTTOKEN1234567890abcd when needed.",
    status: "ACTIVE",
    next_run_at: null,
    last_run_at: null,
    cwds: "[]",
    rrule: "FREQ=HOURLY;INTERVAL=24;BYMINUTE=0",
    model: "model-x",
    reasoning_effort: "high",
    created_at: 1763000000000,
    updated_at: 1763000000000,
    project_id: null,
    kind: "cron",
    target_thread_id: null,
    account_id: "SECRET-ACCOUNT",
    user_id: "SECRET-USER",
    installation_id: "SECRET-INSTALL",
    remote_host: "SECRET-HOST",
    auto_archive: 0,
    ...overrides,
  };
}

function run(overrides: Row): Row {
  return {
    thread_id: "thread-run",
    automation_id: "automation-x",
    status: "ACCEPTED",
    thread_title: "SECRET-THREAD-TITLE",
    source_cwd: "SECRET-SOURCE-CWD",
    inbox_title: "SECRET-INBOX-TITLE",
    inbox_summary: "SECRET-INBOX-SUMMARY",
    created_at: 1763000000000,
    updated_at: 1763000000000,
    archived_user_message: "SECRET-USER-MESSAGE",
    archived_assistant_message: "SECRET-ASSISTANT-MESSAGE",
    archived_reason: "SECRET-REASON",
    ...overrides,
  };
}

const T1 = Date.parse("2026-11-20T08:00:00.000Z");
const T2 = Date.parse("2026-11-21T08:00:00.000Z");
const T3 = Date.parse("2026-11-22T08:00:00.000Z");

function storePath(): string {
  return join(home, ".codex", "sqlite", "codex.db");
}

function writeToml(id: string, body: string): void {
  const dir = join(home, ".codex", "automations", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "automation.toml"), body);
}

describe("codexAppScheduleReader", () => {
  test("is the codex-app reader", () => {
    expect(codexAppScheduleReader.id).toBe("codex-app");
  });

  test("the SQL names only schedule, prompt and model columns", () => {
    expect(codexAppAutomationsSql()).toContain("prompt");
    expect(codexAppAutomationsSql()).toContain("reasoning_effort");
    for (const sql of [codexAppAutomationsSql(), CODEX_APP_RUNS_SQL]) {
      const words = new Set(sql.toLowerCase().match(/[a-z_]+/g));
      for (const column of NEVER_SELECTED) expect(words.has(column)).toBe(false);
      expect(sql).not.toContain("*");
      expect(sql.toLowerCase()).not.toContain("secret");
      expect(sql.toLowerCase()).not.toContain("token");
    }
  });

  test("reads a known layout with two automations and several runs", async () => {
    writeStore(
      storePath(),
      [
        automation({
          id: "daily-check",
          name: "Daily check",
          status: "ACTIVE",
          rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
          next_run_at: Date.parse("2026-11-23T09:00:00.000Z"),
          last_run_at: T1,
          project_id: "project-1",
          target_thread_id: "thread-1",
        }),
        automation({
          id: "paused-watch",
          name: "Paused watch",
          status: "PAUSED",
          rrule: "FREQ=MINUTELY;INTERVAL=30",
          last_run_at: T2,
        }),
      ],
      [
        run({ thread_id: "r1", automation_id: "daily-check", status: "FAILED", created_at: T1 }),
        run({ thread_id: "r2", automation_id: "daily-check", status: "ACCEPTED", created_at: T3 }),
        run({ thread_id: "r3", automation_id: "daily-check", status: "ERROR", created_at: T2 }),
        run({ thread_id: "r4", automation_id: "paused-watch", status: "WHATEVER", created_at: T2 }),
        run({ thread_id: "r5", automation_id: "paused-watch", status: "FAILED", created_at: T1 }),
      ],
      { wal: true },
    );
    const result = await codexAppScheduleReader.read(ctx());
    expect(validateScheduleReadResult(result)).toEqual({ ok: true, value: result });
    for (const record of result.records) expect(validateScheduleRecord(record).ok).toBe(true);
    expect(result.coverage).toEqual({
      source: "codex-app",
      account: "box-1",
      state: "current",
      read_at: "2026-11-22T12:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(result.records).toEqual([
      {
        source: "codex-app",
        account: "box-1",
        id: "daily-check",
        title: "Daily check",
        trigger: {
          kind: "rrule",
          rule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
          raw: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
        },
        runs_on: { host: "box-1", project: "project-1", thread: "thread-1" },
        enabled: true,
        next_run_at: "2026-11-23T09:00:00.000Z",
        last_run: { at: "2026-11-22T08:00:00.000Z", status: "succeeded" },
        created_by: null,
        work: {
          commands: [],
          agent: {
            adapter: "codex",
            model: "model-x",
            effort: "high",
            prompt: "Review open issues.\nUse ‹redacted› when needed.",
          },
          redacted: true,
        },
      },
      {
        source: "codex-app",
        account: "box-1",
        id: "paused-watch",
        title: "Paused watch",
        trigger: {
          kind: "rrule",
          rule: "FREQ=MINUTELY;INTERVAL=30",
          raw: "FREQ=MINUTELY;INTERVAL=30",
        },
        runs_on: { host: "box-1" },
        enabled: false,
        next_run_at: null,
        last_run: { at: "2026-11-21T08:00:00.000Z", status: "unknown" },
        created_by: null,
        work: {
          commands: [],
          agent: {
            adapter: "codex",
            model: "model-x",
            effort: "high",
            prompt: "Review open issues.\nUse ‹redacted› when needed.",
          },
          redacted: true,
        },
      },
    ]);
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  });

  test("an automation with no runs uses last_run_at with an unknown status, or none", async () => {
    writeStore(
      storePath(),
      [automation({ id: "a", last_run_at: T1 }), automation({ id: "b" })],
      [],
    );
    const result = await codexAppScheduleReader.read(ctx());
    expect(result.records.map((r) => r.last_run)).toEqual([
      { at: "2026-11-20T08:00:00.000Z", status: "unknown" },
      null,
    ]);
  });

  test("an unknown layout is unsupported with no records", async () => {
    const columns = AUTOMATION_COLUMNS.map((c) => (c === "rrule" ? "schedule" : c));
    writeStore(storePath(), [automation({ schedule: "FREQ=DAILY" })], [], {
      automationColumns: columns,
    });
    writeToml("automation-x", 'id = "automation-x"\nrrule = "FREQ=DAILY"\n');
    const result = await codexAppScheduleReader.read(ctx());
    expect(result.records).toEqual([]);
    expect(result.coverage.state).toBe("unsupported");
    expect(result.coverage.detail).toContain("rrule");
    expect(validateScheduleReadResult(result).ok).toBe(true);
  });

  test("a store without the runs table is unsupported", async () => {
    mkdirSync(dirname(storePath()), { recursive: true });
    const db = new Database(storePath());
    insertAll(db, "automations", AUTOMATION_COLUMNS, [automation({})]);
    db.close();
    const result = await codexAppScheduleReader.read(ctx());
    expect(result.coverage.state).toBe("unsupported");
    expect(result.coverage.detail).toContain("automation_runs");
  });

  test("a missing store is unsupported, not an empty current list", async () => {
    // Not Linux, so a WSL test machine's real Windows-side store is never found.
    const result = await codexAppScheduleReader.read(ctx({ platform: "darwin" }));
    expect(result.records).toEqual([]);
    expect(result.coverage.state).toBe("unsupported");
    expect(result.coverage.detail).toContain("not found");
    expect(validateScheduleReadResult(result).ok).toBe(true);
  });

  test("an unreadable database falls back to the automation files as stale", async () => {
    // A folder where the database should be cannot be copied.
    mkdirSync(storePath(), { recursive: true });
    writeToml(
      "daily-check",
      [
        "version = 1",
        'id = "daily-check"',
        'kind = "cron"',
        'name = "Daily \\"check\\""',
        'prompt = """',
        'name = "SECRET-INSIDE-PROMPT"',
        "SECRET-PROMPT line",
        '"""',
        "status = 'ACTIVE'",
        'rrule = "FREQ=DAILY;BYHOUR=9" # a comment',
        'target_thread_id = "thread-1"',
        "",
      ].join("\n"),
    );
    writeToml(
      "paused-watch",
      'id = "paused-watch"\nname = "Paused"\nprompt = "Watch the queue.\\nToken: xoxb-1234567890-SECRETSLACK"\nmodel = "model-y"\nstatus = "PAUSED"\nrrule = "FREQ=MINUTELY;INTERVAL=30"\n',
    );
    const result = await codexAppScheduleReader.read(ctx());
    expect(validateScheduleReadResult(result).ok).toBe(true);
    expect(result.coverage.state).toBe("stale");
    expect(result.coverage.detail).toContain("automation files");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(result.records).toEqual([
      {
        source: "codex-app",
        account: "box-1",
        id: "daily-check",
        title: 'Daily "check"',
        trigger: { kind: "rrule", rule: "FREQ=DAILY;BYHOUR=9", raw: "FREQ=DAILY;BYHOUR=9" },
        runs_on: { host: "box-1", thread: "thread-1" },
        enabled: true,
        next_run_at: null,
        last_run: null,
        created_by: null,
      },
      {
        source: "codex-app",
        account: "box-1",
        id: "paused-watch",
        title: "Paused",
        trigger: {
          kind: "rrule",
          rule: "FREQ=MINUTELY;INTERVAL=30",
          raw: "FREQ=MINUTELY;INTERVAL=30",
        },
        runs_on: { host: "box-1" },
        enabled: false,
        next_run_at: null,
        last_run: null,
        created_by: null,
        work: {
          commands: [],
          agent: {
            adapter: "codex",
            model: "model-y",
            effort: null,
            prompt: "Watch the queue.\nToken: ‹redacted›",
          },
          redacted: true,
        },
      },
    ]);
  });

  test("an older table without model columns still reads the prompt", async () => {
    const columns = AUTOMATION_COLUMNS.filter(
      (c) => c !== "model" && c !== "reasoning_effort" && c !== "cwds",
    );
    writeStore(storePath(), [automation({ id: "a", prompt: "Say hi." })], [], {
      automationColumns: columns,
    });
    const result = await codexAppScheduleReader.read(ctx());
    expect(result.coverage.state).toBe("current");
    expect(result.records[0]?.work?.agent).toEqual({
      adapter: "codex",
      model: null,
      effort: null,
      prompt: "Say hi.",
    });
  });

  test("an automation's first folder is its project when project_id is empty", async () => {
    writeStore(storePath(), [automation({ id: "a", cwds: '["/work/repo"]' })], []);
    const result = await codexAppScheduleReader.read(ctx());
    expect(result.records[0]?.runs_on.project).toBe("/work/repo");
  });

  test("a database that is not a database also falls back", async () => {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), "not a database at all, just bytes ".repeat(200));
    writeToml("a", 'id = "a"\nstatus = "ACTIVE"\nrrule = "FREQ=DAILY"\n');
    const result = await codexAppScheduleReader.read(ctx());
    expect(result.coverage.state).toBe("stale");
    expect(result.records.map((r) => r.id)).toEqual(["a"]);
  });

  test("an unreadable database with no automation files is unreadable", async () => {
    mkdirSync(storePath(), { recursive: true });
    const result = await codexAppScheduleReader.read(ctx());
    expect(result.records).toEqual([]);
    expect(result.coverage.state).toBe("unreadable");
    expect(validateScheduleReadResult(result).ok).toBe(true);
  });

  test("honours a database file override", async () => {
    const path = join(root, "elsewhere", "sqlite", "codex.db");
    writeStore(path, [automation({})], []);
    const result = await codexAppScheduleReader.read(ctx({ storePaths: { "codex-app": path } }));
    expect(result.coverage.state).toBe("current");
    expect(result.records.map((r) => r.id)).toEqual(["automation-x"]);
  });
});

describe("codexAppHome", () => {
  test("prefers the override, then CODEX_HOME, then the home folder", () => {
    const local = join(home, ".codex");
    const notWsl = () => false;
    expect(codexAppHome(ctx(), join(root, "none"), notWsl)).toBeNull();
    mkdirSync(join(local, "automations"), { recursive: true });
    expect(codexAppHome(ctx(), join(root, "none"), notWsl)).toBe(local);
    expect(codexAppHome(ctx({ env: { CODEX_HOME: "/x/codex" } }))).toBe("/x/codex");
    expect(codexAppHome(ctx({ storePaths: { "codex-app": "/y/home" } }))).toBe("/y/home");
    expect(codexAppHome(ctx({ storePaths: { "codex-app": "/z/home/sqlite/codex.db" } }))).toBe(
      "/z/home",
    );
  });

  test("finds the Windows-side store under WSL without a fixed user name", () => {
    const users = join(root, "Users");
    mkdirSync(join(users, "Public", ".codex", "automations"), { recursive: true });
    mkdirSync(join(users, "empty-profile"), { recursive: true });
    writeStore(join(users, "someone", ".codex", "sqlite", "codex.db"), [], []);
    expect(codexAppWindowsHomes(users)).toEqual([join(users, "someone", ".codex")]);
    expect(codexAppHome(ctx({ env: { WSL_DISTRO_NAME: "distro" } }), users)).toBe(
      join(users, "someone", ".codex"),
    );
    // A WSL kernel without WSL_* variables (a systemd service) still searches it.
    expect(codexAppHome(ctx(), users, () => true)).toBe(join(users, "someone", ".codex"));
    // Not WSL: the Windows side is never searched.
    expect(codexAppHome(ctx(), users, () => false)).toBeNull();
    expect(
      codexAppHome(ctx({ platform: "darwin", env: { WSL_DISTRO_NAME: "d" } }), users, () => true),
    ).toBe(null);
  });
});

describe("field mapping", () => {
  test("maps statuses and times", () => {
    expect(codexAppEnabled("ACTIVE")).toBe(true);
    expect(codexAppEnabled("PAUSED")).toBe(false);
    expect(codexAppEnabled("SOMETHING")).toBeNull();
    expect(codexAppEnabled(null)).toBeNull();
    expect(codexAppRunStatus("accepted")).toBe("succeeded");
    expect(codexAppRunStatus("FAILED")).toBe("failed");
    expect(codexAppRunStatus("PENDING_REVIEW")).toBe("attention");
    expect(codexAppRunStatus("CANCELLED")).toBe("skipped");
    expect(codexAppRunStatus("NEW_THING")).toBe("unknown");
    expect(codexAppRunStatus(3)).toBe("unknown");
    expect(codexAppInstant(T1)).toBe("2026-11-20T08:00:00.000Z");
    expect(codexAppInstant(BigInt(T1))).toBe("2026-11-20T08:00:00.000Z");
    expect(codexAppInstant("2026-11-20T08:00:00Z")).toBe("2026-11-20T08:00:00Z");
    expect(codexAppInstant("tomorrow")).toBeNull();
    expect(codexAppInstant(0)).toBeNull();
    expect(codexAppInstant(null)).toBeNull();
  });

  test("the TOML reader keeps named top-level keys only", () => {
    expect(
      parseCodexAppToml(
        [
          "prompt = '''",
          'id = "SECRET-IN-LITERAL"',
          "'''",
          'id = "real"',
          'prompt = """one line SECRET"""',
          'model = "m-1"',
          'other = "SECRET-OTHER"',
          "[table]",
          'name = "SECRET-NESTED"',
        ].join("\r\n"),
      ),
    ).toEqual({ id: "real", model: "m-1" });
  });
});
