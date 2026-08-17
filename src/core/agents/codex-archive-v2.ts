import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { normalizeNativeIdV2 } from "../events/v2/canonical.ts";
import { readEventV2ControlState } from "../events/v2/control.ts";
import { fingerprintContextV2 } from "../events/v2/fingerprint-keys.ts";
import { listHookProducerStateRecordsV2 } from "../events/v2/producers/recorder.ts";
import type { SessionArchiveObservationV2 } from "./session-finalizer-v2.ts";

export interface CodexArchiveScanResultV2 {
  observations: SessionArchiveObservationV2[];
  diagnostics: string[];
}

/**
 * Read only Codex's durable lifecycle columns. Conversation content, titles,
 * working directories, and model metadata never leave the adapter database.
 */
export function readCodexArchiveObservationsV2(
  coordRoot: string,
  options: { databasePath?: string; observedAt?: string } = {},
): CodexArchiveScanResultV2 {
  const diagnostics: string[] = [];
  const databasePath = options.databasePath ?? locateCodexStateDatabase();
  if (!databasePath) return { observations: [], diagnostics: ["codex_state_database_missing"] };
  const control = readEventV2ControlState(coordRoot);
  if (control.state !== "candidate" && control.state !== "active") {
    return { observations: [], diagnostics: ["event_v2_control_unavailable"] };
  }
  const context = fingerprintContextV2(
    coordRoot,
    control.genesis.event.scope.root_id as `root_${string}`,
    undefined,
    control.genesis.profile.privacy_key_epoch,
  );
  const liveCodexStateIds = new Set(
    listHookProducerStateRecordsV2(coordRoot)
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
    const db = new Database(snapshotPath, { readonly: true, strict: true });
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
            liveCodexStateIds.has(normalizeNativeIdV2(context, "codex.session", row.id)),
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
