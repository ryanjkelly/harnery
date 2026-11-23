import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isScheduleSqliteIdentifier, openScheduleSqliteCopy } from "./sqlite.ts";

let root: string;
let tmp: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnery-schedule-sqlite-test-"));
  tmp = join(root, "tmp");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeDb(path: string, rows: Array<[string, string]>): void {
  const db = new Database(path);
  db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT)");
  const insert = db.query("INSERT INTO items (id, label) VALUES (?, ?)");
  for (const [id, label] of rows) insert.run(id, label);
  db.close();
}

function copiesLeft(): string[] {
  return existsSync(tmp) ? readdirSync(tmp) : [];
}

describe("openScheduleSqliteCopy", () => {
  test("reads tables, columns and rows from a copy, and close() deletes the copy", () => {
    const dbPath = join(root, "store.sqlite");
    makeDb(dbPath, [
      ["a", "first"],
      ["b", "second"],
    ]);
    const before = readFileSync(dbPath);
    const opened = openScheduleSqliteCopy({ dbPath, tmpDir: tmp });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.db.tables()).toEqual(["items"]);
    expect(opened.db.columns("items")).toEqual(["id", "label"]);
    expect(opened.db.columns("nope")).toEqual([]);
    expect(
      opened.db.all<{ id: string; label: string }>(
        "SELECT id, label FROM items WHERE id = ? ORDER BY id",
        ["b"],
      ),
    ).toEqual([{ id: "b", label: "second" }]);
    expect(copiesLeft()).toHaveLength(1);
    opened.close();
    opened.close();
    expect(copiesLeft()).toEqual([]);
    // The original is untouched and gains no siblings.
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(readdirSync(root).sort()).toEqual(["store.sqlite", "tmp"]);
  });

  test("the copy refuses writes", () => {
    const dbPath = join(root, "store.sqlite");
    makeDb(dbPath, [["a", "first"]]);
    const opened = openScheduleSqliteCopy({ dbPath, tmpDir: tmp });
    if (!opened.ok) throw new Error(opened.detail);
    expect(() => opened.db.all("DELETE FROM items")).toThrow();
    opened.close();
  });

  test("sees committed rows that are still only in the write-ahead log", () => {
    const dbPath = join(root, "wal.sqlite");
    const writer = new Database(dbPath);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.exec("CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT)");
    writer.query("INSERT INTO items (id, label) VALUES (?, ?)").run("w1", "in the wal");
    writer.query("INSERT INTO items (id, label) VALUES (?, ?)").run("w2", "also in the wal");
    try {
      // The writer stays open and nothing was checkpointed.
      expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
      const opened = openScheduleSqliteCopy({ dbPath, tmpDir: tmp });
      if (!opened.ok) throw new Error(opened.detail);
      expect(opened.db.all<{ id: string }>("SELECT id FROM items ORDER BY id")).toEqual([
        { id: "w1" },
        { id: "w2" },
      ]);
      opened.close();
      expect(copiesLeft()).toEqual([]);
    } finally {
      writer.close();
    }
  });

  test("columns() rejects a name that is not a plain identifier", () => {
    const dbPath = join(root, "store.sqlite");
    makeDb(dbPath, []);
    const opened = openScheduleSqliteCopy({ dbPath, tmpDir: tmp });
    if (!opened.ok) throw new Error(opened.detail);
    expect(() => opened.db.columns('items"); DROP TABLE items; --')).toThrow(/identifier/);
    expect(() => opened.db.columns("")).toThrow(/identifier/);
    opened.close();
    expect(isScheduleSqliteIdentifier("scheduled_tasks")).toBe(true);
    expect(isScheduleSqliteIdentifier("1abc")).toBe(false);
    expect(isScheduleSqliteIdentifier("a-b")).toBe(false);
  });

  test("a missing file is missing", () => {
    const opened = openScheduleSqliteCopy({ dbPath: join(root, "absent.sqlite"), tmpDir: tmp });
    expect(opened).toMatchObject({ ok: false, reason: "missing" });
    expect(copiesLeft()).toEqual([]);
  });

  test("a path that is a folder is unreadable", () => {
    const dbPath = join(root, "folder.sqlite");
    mkdirSync(dbPath);
    expect(openScheduleSqliteCopy({ dbPath, tmpDir: tmp })).toMatchObject({
      ok: false,
      reason: "unreadable",
    });
    expect(copiesLeft()).toEqual([]);
  });

  test("a file that is not a database is unreadable and leaves no copy", () => {
    const dbPath = join(root, "junk.sqlite");
    writeFileSync(dbPath, "this is not a database file, just text that goes on for a while");
    expect(openScheduleSqliteCopy({ dbPath, tmpDir: tmp })).toMatchObject({
      ok: false,
      reason: "unreadable",
    });
    expect(copiesLeft()).toEqual([]);
  });

  test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "a file that cannot be read is unreadable and leaves no copy",
    () => {
      const dbPath = join(root, "locked.sqlite");
      makeDb(dbPath, [["a", "first"]]);
      chmodSync(dbPath, 0o000);
      try {
        expect(openScheduleSqliteCopy({ dbPath, tmpDir: tmp })).toMatchObject({
          ok: false,
          reason: "unreadable",
        });
        expect(copiesLeft()).toEqual([]);
      } finally {
        chmodSync(dbPath, 0o600);
      }
    },
  );
});

/** Node 22.18 and later strip TypeScript types on import and ship node:sqlite unflagged. */
function nodeWithSqliteAndTypes(): { path: string } | { skip: string } {
  const probe = spawnSync("node", ["--version"], { encoding: "utf8", windowsHide: true });
  if (probe.error || probe.status !== 0) return { skip: "node is not on PATH" };
  const match = /^v(\d+)\.(\d+)\./.exec(probe.stdout.trim());
  if (!match) return { skip: `unrecognised node version ${probe.stdout.trim()}` };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 22 || (major === 22 && minor < 18)) {
    return { skip: `node ${probe.stdout.trim()} is older than 22.18 (no type stripping)` };
  }
  return { path: "node" };
}

const nodeProbe = nodeWithSqliteAndTypes();
if ("skip" in nodeProbe) {
  console.warn(`[sqlite.test] skipping the Node engine test: ${nodeProbe.skip}`);
}

describe("under Node", () => {
  test.skipIf("skip" in nodeProbe)("reads the copy through node:sqlite", () => {
    const dbPath = join(root, "store.sqlite");
    const writer = new Database(dbPath);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.exec("CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT)");
    writer.query("INSERT INTO items (id, label) VALUES (?, ?)").run("n1", "from node");
    try {
      const moduleUrl = pathToFileURL(join(import.meta.dir, "sqlite.ts")).href;
      const script = [
        `import { openScheduleSqliteCopy } from ${JSON.stringify(moduleUrl)};`,
        `const r = openScheduleSqliteCopy({ dbPath: process.argv[1], tmpDir: process.argv[2] });`,
        `if (!r.ok) { console.log(JSON.stringify(r)); process.exit(0); }`,
        `const out = { ok: true, bun: typeof process.versions.bun, tables: r.db.tables(),`,
        `  columns: r.db.columns("items"), rows: r.db.all("SELECT id, label FROM items WHERE id = ?", ["n1"]) };`,
        `r.close();`,
        `console.log(JSON.stringify(out));`,
      ].join("\n");
      const run = spawnSync(
        "node",
        ["--no-warnings", "--input-type=module", "-e", script, dbPath, tmp],
        { encoding: "utf8", windowsHide: true, timeout: 30_000 },
      );
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      const out = JSON.parse(run.stdout.trim());
      expect(out).toEqual({
        ok: true,
        bun: "undefined",
        tables: ["items"],
        columns: ["id", "label"],
        rows: [{ id: "n1", label: "from node" }],
      });
      expect(copiesLeft()).toEqual([]);
    } finally {
      writer.close();
    }
  });
});
