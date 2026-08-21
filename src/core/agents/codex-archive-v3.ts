import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { normalizeNativeIdV3 } from "../events/v3/canonical.ts";
import { readEventV3ControlState } from "../events/v3/control.ts";
import { fingerprintContextV3 } from "../events/v3/fingerprint-keys.ts";
import { listHookProducerStateRecordsV3 } from "../events/v3/producers/recorder.ts";
import type { SessionArchiveObservationV3 } from "./session-finalizer-v3.ts";

const require = createRequire(import.meta.url);

type SqliteDatabase = {
  query: (sql: string) => { all: () => unknown[] };
  close: () => void;
};

/** bun:sqlite is Bun-only. The web dashboard runs under Node and must be able
 * to import this module without crashing; a missing engine returns no rows. */
function openReadonlyDatabase(path: string): SqliteDatabase | null {
  try {
    const { Database } = require("bun:sqlite") as {
      Database: new (
        filename: string,
        options?: { readonly?: boolean; strict?: boolean },
      ) => SqliteDatabase;
    };
    return new Database(path, { readonly: true, strict: true });
  } catch {
    return null;
  }
}

export interface CodexArchiveScanResultV3 {
  observations: SessionArchiveObservationV3[];
  diagnostics: string[];
}

/**
 * Read only Codex's durable lifecycle columns. Conversation content, titles,
 * working directories, and model metadata never leave the adapter database.
 */
export function readCodexArchiveObservationsV3(
  coordRoot: string,
  options: { databasePath?: string; observedAt?: string } = {},
): CodexArchiveScanResultV3 {
  const diagnostics: string[] = [];
  const databasePath = options.databasePath ?? locateCodexStateDatabase();
  if (!databasePath) return { observations: [], diagnostics: ["codex_state_database_missing"] };
  const control = readEventV3ControlState(coordRoot);
  if (control.state !== "candidate" && control.state !== "active") {
    return { observations: [], diagnostics: ["event_v3_control_unavailable"] };
  }
  const context = fingerprintContextV3(
    coordRoot,
    control.genesis.event.scope.root_id as `root_${string}`,
    undefined,
    control.genesis.profile.privacy_key_epoch,
  );
  const liveCodexStateIds = new Set(
    listHookProducerStateRecordsV3(coordRoot)
      .filter(({ state }) => state.adapter === "codex")
      .map(({ path }) => basename(path, ".json")),
  );
  const snapshotDir = mkdtempSync(join(tmpdir(), "harnery-codex-state-"));
  const snapshotPath = join(snapshotDir, basename(databasePath));
  try {
    copyFileSync(databasePath, snapshotPath);
    for (const suffix of ["-wal", "-shm"]) {
      const source = `${databasePath}${suffix}`;
      if (existsSync(source)) copyFileSync(source, `${snapshotPath}${suffix}`);
    }
    const db = openReadonlyDatabase(snapshotPath);
    if (!db) {
      diagnostics.push("codex_archive_sqlite_unavailable");
      return { observations: [], diagnostics };
    }
    try {
      const rows = db
        .query("SELECT id, archived, archived_at, updated_at_ms FROM threads")
        .all() as Array<{
        id: string;
        archived: number;
        archived_at: number | null;
        updated_at_ms: number;
      }>;
      return {
        observations: rows
          .filter((row) =>
            liveCodexStateIds.has(normalizeNativeIdV3(context, "codex.session", row.id)),
          )
          .map((row) => ({
            adapter: "codex" as const,
            native_session_id: row.id,
            archived: row.archived === 1,
            observed_at:
              epochToIso(row.archived_at) ??
              epochToIso(row.updated_at_ms) ??
              options.observedAt ??
              new Date().toISOString(),
          })),
        diagnostics,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    diagnostics.push(`codex_archive_scan_failed:${(error as Error).message}`);
    return { observations: [], diagnostics };
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
}

function locateCodexStateDatabase(): string | null {
  const explicit = process.env.HARNERY_CODEX_STATE_DB?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  for (const candidate of [
    join(homedir(), ".codex", "state_5.sqlite"),
    join(homedir(), ".codex", "sqlite", "state_5.sqlite"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  const usersRoot = "/mnt/c/Users";
  if (!existsSync(usersRoot)) return null;
  for (const user of readdirSync(usersRoot).sort()) {
    const candidate = join(usersRoot, user, ".codex", "state_5.sqlite");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function epochToIso(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
