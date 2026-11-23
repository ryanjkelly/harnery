/**
 * Read another app's SQLite store from a private copy.
 *
 * The helper copies the database file with its `-wal` and `-shm` siblings into
 * a fresh folder under the caller's temporary directory and opens the copy, so
 * committed rows that are still only in the write-ahead log are seen and the
 * owning app is never locked, blocked or written to. The original file is only
 * ever read by a plain file copy.
 *
 * It uses `bun:sqlite` under Bun and `node:sqlite` under Node (22.5 or later).
 * Both are loaded lazily, so importing this module never throws on either
 * runtime; when neither engine loads, the result is `no-engine`.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";

const require = createRequire(import.meta.url);

/** A read-only view of the copied database. */
export interface ScheduleSqliteDb {
  /** Names of the ordinary tables in the database. */
  tables(): string[];
  /** Column names of `table`; empty when the table does not exist. Throws on a non-identifier name. */
  columns(table: string): string[];
  /** Run one statement with positional `?` parameters and return every row as an object. */
  all<T>(sql: string, params?: readonly unknown[]): T[];
}

export type ScheduleSqliteOpenFailure = "missing" | "unreadable" | "no-engine";

export type ScheduleSqliteOpenResult =
  | { ok: true; db: ScheduleSqliteDb; close(): void }
  | { ok: false; reason: ScheduleSqliteOpenFailure; detail: string };

export interface ScheduleSqliteOpenOptions {
  /** The store to read. It is copied, never opened. */
  dbPath: string;
  /** A writable folder; the private copy lives in a new folder inside it. */
  tmpDir: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether `name` is a plain SQL identifier safe to place inside double quotes. */
export function isScheduleSqliteIdentifier(name: string): boolean {
  return IDENTIFIER.test(name);
}

/** The minimal engine surface both runtimes provide. */
interface EngineHandle {
  all(sql: string, params: readonly unknown[]): Record<string, unknown>[];
  close(): void;
}

type EngineOpener = (path: string) => EngineHandle;

interface BunStatement {
  all(...params: unknown[]): unknown[];
  finalize?(): void;
}
interface BunDatabase {
  query(sql: string): BunStatement;
  exec(sql: string): void;
  close(): void;
}
interface NodeStatement {
  all(...params: unknown[]): unknown[];
}
interface NodeDatabase {
  prepare(sql: string): NodeStatement;
  exec(sql: string): void;
  close(): void;
}

function loadBunEngine(): EngineOpener | null {
  try {
    const { Database } = require("bun:sqlite") as {
      Database: new (filename: string, options?: { strict?: boolean }) => BunDatabase;
    };
    return (path) => {
      const db = new Database(path, { strict: true });
      try {
        db.exec("PRAGMA query_only = ON");
      } catch (err) {
        db.close();
        throw err;
      }
      return {
        all: (sql, params) => db.query(sql).all(...params) as Record<string, unknown>[],
        close: () => db.close(),
      };
    };
  } catch {
    return null;
  }
}

function loadNodeEngine(): EngineOpener | null {
  try {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (filename: string) => NodeDatabase;
    };
    return (path) => {
      const db = new DatabaseSync(path);
      try {
        db.exec("PRAGMA query_only = ON");
      } catch (err) {
        db.close();
        throw err;
      }
      return {
        all: (sql, params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
        close: () => db.close(),
      };
    };
  } catch {
    return null;
  }
}

function loadEngine(): EngineOpener | null {
  return typeof process.versions.bun === "string" ? loadBunEngine() : loadNodeEngine();
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return err instanceof Error ? err.name : "error";
}

function removeQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leftover folder under the caller's temporary directory is harmless.
  }
}

/**
 * Copy the store and open the copy. Never throws. On success the caller must
 * call `close()`, which closes the copy and deletes its folder.
 */
export function openScheduleSqliteCopy(
  options: ScheduleSqliteOpenOptions,
): ScheduleSqliteOpenResult {
  const { dbPath, tmpDir } = options;
  if (!existsSync(dbPath)) {
    return { ok: false, reason: "missing", detail: "the database file does not exist" };
  }
  try {
    if (!statSync(dbPath).isFile()) {
      return { ok: false, reason: "unreadable", detail: "the database path is not a file" };
    }
  } catch (err) {
    return {
      ok: false,
      reason: "unreadable",
      detail: `the database file could not be inspected (${errorCode(err)})`,
    };
  }

  const open = loadEngine();
  if (!open) {
    return {
      ok: false,
      reason: "no-engine",
      detail: "no SQLite engine is available in this runtime (needs Bun or Node 22.5 or later)",
    };
  }

  let copyDir: string;
  try {
    mkdirSync(tmpDir, { recursive: true });
    copyDir = mkdtempSync(join(tmpDir, "harnery-schedule-sqlite-"));
  } catch (err) {
    return {
      ok: false,
      reason: "unreadable",
      detail: `no private folder for the copy could be made (${errorCode(err)})`,
    };
  }

  const copyPath = join(copyDir, basename(dbPath));
  try {
    copyFileSync(dbPath, copyPath);
    for (const suffix of ["-wal", "-shm"]) {
      const sibling = `${dbPath}${suffix}`;
      if (existsSync(sibling)) copyFileSync(sibling, `${copyPath}${suffix}`);
    }
  } catch (err) {
    removeQuietly(copyDir);
    return {
      ok: false,
      reason: "unreadable",
      detail: `the database could not be copied (${errorCode(err)})`,
    };
  }

  let handle: EngineHandle;
  try {
    handle = open(copyPath);
    // Touch the schema so a file that is not a database fails here, not later.
    handle.all("SELECT name FROM sqlite_master LIMIT 1", []);
  } catch (err) {
    removeQuietly(copyDir);
    return {
      ok: false,
      reason: "unreadable",
      detail: `the database copy could not be opened (${errorCode(err)})`,
    };
  }

  let closed = false;
  const db: ScheduleSqliteDb = {
    tables() {
      return handle
        .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", [])
        .map((row) => row.name)
        .filter((name): name is string => typeof name === "string");
    },
    columns(table) {
      if (!isScheduleSqliteIdentifier(table)) {
        throw new Error(`schedule sqlite: not a plain identifier: ${JSON.stringify(table)}`);
      }
      return handle
        .all(`PRAGMA table_info("${table}")`, [])
        .map((row) => row.name)
        .filter((name): name is string => typeof name === "string");
    },
    all<T>(sql: string, params: readonly unknown[] = []): T[] {
      return handle.all(sql, params) as T[];
    },
  };

  return {
    ok: true,
    db,
    close() {
      if (closed) return;
      closed = true;
      try {
        handle.close();
      } catch {
        // The copy is deleted next either way.
      }
      removeQuietly(copyDir);
    },
  };
}
