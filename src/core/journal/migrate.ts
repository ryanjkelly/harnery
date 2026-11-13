/**
 * `journal migrate`: the one bounded rewrite from the retired journal
 * timestamp format to the current one.
 *
 * Journals written before timestamps carried a numeric UTC offset used a
 * zone abbreviation instead (`2026-11-07 10:38 PM CST`). Only two
 * abbreviations were ever written, CDT and CST, so each maps to exactly one
 * offset: CDT to -05:00 and CST to -06:00. The rewrite keeps the wall clock
 * and the instant, and changes nothing else in the file.
 *
 * This module is the only code that knows the retired format. Normal readers
 * do not accept it. A writer that meets it runs this migration on that one
 * file first (same rules, same backup), so a journal written by an older
 * build before an upgrade mid-session still takes the next append. Only a
 * stamp this module cannot convert makes the writer refuse.
 *
 * Guarantees:
 *   - Covers active journals and `archived/`.
 *   - Rewrites only entry-header lines after the metadata separator and the
 *     `started:` / `last_updated:` metadata values, using the same rule the
 *     retired parser used to recognize them. Every other byte, including body
 *     lines that begin with `## `, is unchanged.
 *   - Idempotent: a second run finds nothing to change.
 *   - Before changing a file, saves its original bytes under
 *     `.harnery/journal/.migration-backup/<run-id>/<relative path>`.
 *   - Preserves each file's modification time (archive retention runs on it)
 *     and permission bits.
 *   - Holds the journal lock per file, so a concurrent append either lands
 *     before the read or waits and then sees the migrated file.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { isCalendarDate, JOURNAL_CATEGORIES, JOURNAL_METADATA_END } from "./codec.ts";
import { withJournalLock } from "./lock.ts";

export const MIGRATION_BACKUP_DIR = ".migration-backup";

const RETIRED_OFFSETS: Record<string, string> = { CDT: "-05:00", CST: "-06:00" };

const RETIRED_STAMP = "(\\d{4})-(\\d{2})-(\\d{2}) (\\d{1,2}):(\\d{2}) (AM|PM) (CDT|CST)";
const RETIRED_HEADER_RE = new RegExp(`^## ${RETIRED_STAMP} · (${JOURNAL_CATEGORIES.join("|")})$`);
const RETIRED_STAMP_RE = new RegExp(`^${RETIRED_STAMP}$`);
const METADATA_TIMESTAMP_RE = /^(started|last_updated):(\s*)(.*)$/;

export interface JournalMigrationUnparseable {
  line: number;
  text: string;
  reason: string;
}

export interface JournalMigrationFile {
  /** Path relative to the journal directory, e.g. `abc.md` or `archived/abc-….md`. */
  path: string;
  headers: number;
  metadata: number;
  unparseable: JournalMigrationUnparseable[];
  changed: boolean;
}

export interface JournalMigrationReport {
  applied: boolean;
  journal_dir: string;
  /** Where pre-images were saved (apply runs that changed something), else null. */
  backup_dir: string | null;
  files_scanned: number;
  files_changed: number;
  headers: number;
  metadata: number;
  unparseable: number;
  files: JournalMigrationFile[];
}

/**
 * Convert one retired stamp to the current format, or explain why it cannot be.
 * The hour keeps the retired writer's digits minus any leading zero.
 */
export function convertRetiredStamp(stamp: string): { stamp: string } | { error: string } {
  const m = RETIRED_STAMP_RE.exec(stamp);
  if (!m) return { error: "not a retired timestamp" };
  const [, y, mo, d, h, mi, period, abbr] = m;
  if (!isCalendarDate(Number(y), Number(mo), Number(d))) return { error: "invalid calendar date" };
  const hour = Number(h);
  if (!Number.isInteger(hour) || hour < 1 || hour > 12) return { error: "hour outside 1-12" };
  if (Number(mi) > 59) return { error: "minute outside 00-59" };
  const offset = RETIRED_OFFSETS[abbr!];
  if (!offset) return { error: "unknown zone abbreviation" };
  return { stamp: `${y}-${mo}-${d} ${hour}:${mi} ${period} ${offset}` };
}

interface FileRewrite {
  content: string;
  headers: number;
  metadata: number;
  unparseable: JournalMigrationUnparseable[];
}

/** Rewrite one file's retired stamps in memory. Pure. */
export function rewriteRetiredStamps(content: string): FileRewrite {
  const lines = content.split("\n");
  let headers = 0;
  let metadata = 0;
  const unparseable: JournalMigrationUnparseable[] = [];
  // The retired parser read metadata only before the first separator line and
  // entry headers only after it; mirror that exactly.
  let inEntries = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!inEntries) {
      if (line === JOURNAL_METADATA_END) {
        inEntries = true;
        continue;
      }
      const meta = METADATA_TIMESTAMP_RE.exec(line);
      if (!meta) continue;
      const value = meta[3]!.trim();
      if (!/(?:CDT|CST)$/.test(value)) continue;
      const converted = convertRetiredStamp(value);
      if ("error" in converted) {
        unparseable.push({ line: i + 1, text: line, reason: converted.error });
        continue;
      }
      lines[i] = `${meta[1]}:${meta[2]}${meta[3]!.replace(value, converted.stamp)}`;
      metadata++;
      continue;
    }
    if (!line.startsWith("## ")) continue;
    const header = RETIRED_HEADER_RE.exec(line);
    if (!header) continue;
    const stamp = line.slice(3, line.lastIndexOf(" · "));
    const converted = convertRetiredStamp(stamp);
    if ("error" in converted) {
      unparseable.push({ line: i + 1, text: line, reason: converted.error });
      continue;
    }
    lines[i] = `## ${converted.stamp} · ${header[8]}`;
    headers++;
  }
  return { content: lines.join("\n"), headers, metadata, unparseable };
}

function journalFiles(journalDir: string): string[] {
  const out: string[] = [];
  const collect = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".md")) continue;
      const full = join(dir, name);
      try {
        if (statSync(full).isFile()) out.push(full);
      } catch {
        // vanished between listing and stat
      }
    }
  };
  collect(journalDir);
  collect(join(journalDir, "archived"));
  return out;
}

function backupRunId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

export interface MigrateJournalsOptions {
  /** Rewrite files; without it, report only. */
  apply?: boolean;
  /** Clock for the backup directory name (tests). */
  now?: Date;
}

export interface MigrateJournalFileOptions {
  /** Rewrite the file; without it, report only. */
  apply?: boolean;
  /** Where to save the original before rewriting (one run's backup directory). */
  backupDir: string;
}

/**
 * Plan or apply the migration for one journal file under `journalDir`. Holds
 * the journal lock (reentrant, so a writer that already holds it can call
 * this). Returns null when the file vanished. Before rewriting, the original
 * is copied to `backupDir/<path relative to journalDir>`.
 */
export function migrateJournalFile(
  journalDir: string,
  full: string,
  opts: MigrateJournalFileOptions,
): JournalMigrationFile | null {
  const rel = relative(journalDir, full);
  return withJournalLock(journalDir, () => {
    if (!existsSync(full)) return null; // archived or pruned since the listing
    const original = readFileSync(full);
    const text = original.toString("utf8");
    const rewrite = rewriteRetiredStamps(text);
    const changed = rewrite.content !== text;
    if (changed && opts.apply === true) {
      const stat = statSync(full);
      const backupPath = join(opts.backupDir, rel);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(full, backupPath);
      utimesSync(backupPath, stat.atime, stat.mtime);
      const tmp = `${full}.migrate.${process.pid}`;
      writeFileSync(tmp, rewrite.content, "utf8");
      chmodSync(tmp, stat.mode & 0o7777);
      utimesSync(tmp, stat.atime, stat.mtime);
      renameSync(tmp, full);
    }
    return {
      path: rel,
      headers: rewrite.headers,
      metadata: rewrite.metadata,
      unparseable: rewrite.unparseable,
      changed,
    } satisfies JournalMigrationFile;
  });
}

/** A fresh backup directory for one migration run. */
export function migrationBackupDir(journalDir: string, now: Date = new Date()): string {
  return join(journalDir, MIGRATION_BACKUP_DIR, backupRunId(now));
}

/** Plan or apply the migration for every journal under `journalDir`. */
export function migrateJournals(
  journalDir: string,
  opts: MigrateJournalsOptions = {},
): JournalMigrationReport {
  const apply = opts.apply === true;
  const backupDir = migrationBackupDir(journalDir, opts.now ?? new Date());
  const files: JournalMigrationFile[] = [];
  for (const full of journalFiles(journalDir)) {
    const result = migrateJournalFile(journalDir, full, { apply, backupDir });
    if (result) files.push(result);
  }
  const changed = files.filter((f) => f.changed).length;
  return {
    applied: apply,
    journal_dir: journalDir,
    backup_dir: apply && changed > 0 ? backupDir : null,
    files_scanned: files.length,
    files_changed: changed,
    headers: files.reduce((n, f) => n + f.headers, 0),
    metadata: files.reduce((n, f) => n + f.metadata, 0),
    unparseable: files.reduce((n, f) => n + f.unparseable.length, 0),
    files,
  };
}

/** True when any journal under `journalDir` still contains a retired stamp. */
export function hasRetiredJournalStamps(journalDir: string): boolean {
  for (const full of journalFiles(journalDir)) {
    try {
      const text = readFileSync(full, "utf8");
      if (!/ (?:CDT|CST)\b/.test(text)) continue;
      if (rewriteRetiredStamps(text).content !== text) return true;
    } catch {
      // unreadable or vanished: nothing to migrate here
    }
  }
  return false;
}
