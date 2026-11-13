import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveMachineLabel } from "../../lib/machine.ts";
import {
  assertSafeInstanceId,
  monorepoRoot,
  resolveContainedFile,
  resolveOwner,
} from "../agents/index.ts";
import {
  readLiveCoordinationRow,
  readLiveCoordinationRows,
} from "../agents/state/live-coordination-view.ts";
import { resolveBinName, resolveTimeZone } from "../config.ts";
import {
  readCoordinationViewV3,
  requireAuthoritySafeCoordinationViewV3,
} from "../events/v3/coordination-view.ts";
import {
  liveInstanceIdV3,
  observeLiveEventLedgerRouteV3,
} from "../events/v3/live-route-observer.ts";
import {
  formatJournalTimestamp,
  isUnreadableEntryHeader,
  JOURNAL_HEADER_PREFIX,
  type JournalCategory,
  type JournalDoc,
  type JournalEntry,
  parseEntryHeader,
  parseJournal,
  parseJournalTimestamp,
  serializeJournal,
} from "./codec.ts";
import { withJournalLock } from "./lock.ts";
import { migrateJournalFile, migrationBackupDir } from "./migrate.ts";

export * from "./codec.ts";
export { holdsJournalLock, JournalLockBusyError, withJournalLock } from "./lock.ts";

/**
 * Agent journal: per-agent markdown journal at `.harnery/journal/<instance_id>.md`.
 *
 * Rules:
 *   - The file format belongs to `./codec.ts`, shared with the dashboard.
 *   - Entry headers are `## <wall clock> <UTC offset> · <category>`, written in
 *     the zone `resolveTimeZone()` returns. Parsing never consults a zone.
 *   - Append-only, newest entry first. Atomic temp-file + rename on each write.
 *   - Every mutation (append, entry edit/delete, archive, prune, migrate)
 *     holds the project's journal lock (`./lock.ts`).
 *   - A writer first migrates retired timestamps in the file it is about to
 *     rewrite (`./migrate.ts`, original backed up). It refuses a file whose
 *     timestamps still cannot be read and names `journal migrate`, because
 *     rewriting it would merge or drop entries.
 *   - 50 KB hard cap; auto-prunes oldest entries when exceeded.
 *   - SessionEnd hook archives to `.harnery/journal/archived/<instance_id>-<ts>.md`;
 *     SessionStart janitor migrates legacy timestamps, deletes archives older
 *     than 7 days, and surfaces the most-recent archive as a recovery cue.
 */

export const MAX_JOURNAL_BYTES = 50 * 1024;
export const WARN_JOURNAL_BYTES = 40 * 1024;
export const ARCHIVE_RETENTION_DAYS = 7;

// ─── Paths ────────────────────────────────────────────────────────────────

function rootOrThrow(root?: string | null): string {
  const resolved = root ?? monorepoRoot();
  if (!resolved) throw new Error("Not in a coord-aware repo (coord_root() returned null).");
  return resolved;
}

/** The journal directory for `root` (default: the current coordination root). */
export function journalDir(root?: string | null): string {
  const dir = resolve(rootOrThrow(root), ".harnery", "journal");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function archiveDir(root?: string | null): string {
  const dir = resolve(journalDir(root), "archived");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function journalPath(instanceId: string, root?: string | null): string {
  assertSafeInstanceId(instanceId);
  return resolveContainedFile(journalDir(root), `${instanceId}.md`);
}

// ─── Timestamps ───────────────────────────────────────────────────────────

/**
 * Format `d` as a journal timestamp in the project's resolved zone, e.g.
 * `2026-11-07 10:38 PM -06:00`.
 */
export function formatJournalNow(d: Date = new Date(), root?: string | null): string {
  return formatJournalTimestamp(d, resolveTimeZone(root ?? monorepoRoot()));
}

// ─── Lint ─────────────────────────────────────────────────────────────────

export interface LintIssue {
  line: number;
  message: string;
}

export function lintJournal(content: string, byteCap = MAX_JOURNAL_BYTES): LintIssue[] {
  const issues: LintIssue[] = [];
  const lines = content.split("\n");

  // Frontmatter checks
  if (!lines[0]?.startsWith(JOURNAL_HEADER_PREFIX)) {
    issues.push({ line: 1, message: `missing '${JOURNAL_HEADER_PREFIX}<name>' header` });
  }
  for (const required of ["session_id:", "machine:", "started:"]) {
    if (!lines.slice(0, 10).some((l) => l.startsWith(required))) {
      issues.push({ line: 1, message: `missing frontmatter field '${required}'` });
    }
  }

  const doc = parseJournal("", content);
  for (const line of doc.unreadable_lines) {
    issues.push({
      line,
      message: `unreadable timestamp (run \`${resolveBinName()} journal migrate\`): ${lines[line - 1]}`,
    });
  }

  // Entry header + chronological order checks
  let inEntries = false;
  const entryTimes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!inEntries) {
      if (line === "---") inEntries = true;
      continue;
    }
    if (!line.startsWith("## ")) continue;
    const parsed = parseEntryHeader(line);
    if (parsed) {
      entryTimes.push(parsed.timestamp.epoch_ms);
    } else if (!isUnreadableEntryHeader(line)) {
      issues.push({ line: i + 1, message: `malformed entry header: ${line}` });
    }
  }
  for (let i = 1; i < entryTimes.length; i++) {
    if (entryTimes[i]! > entryTimes[i - 1]!) {
      issues.push({
        line: 0,
        message: "entries are not in chronological-descending order (newest first)",
      });
      break;
    }
  }

  // CRLF + trailing whitespace
  if (content.includes("\r\n")) {
    issues.push({ line: 0, message: "CRLF line endings detected; LF required" });
  }
  for (let i = 0; i < lines.length; i++) {
    if (/\s$/.test(lines[i]!) && lines[i]!.length > 0) {
      issues.push({ line: i + 1, message: "trailing whitespace" });
      break;
    }
  }

  // Size cap
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > byteCap) {
    issues.push({
      line: 0,
      message: `file size ${bytes} bytes exceeds ${byteCap}-byte cap`,
    });
  }

  return issues;
}

// ─── Writers ──────────────────────────────────────────────────────────────

/** Raised when a writer meets timestamps it cannot read; names the fix. */
export class JournalNeedsMigrationError extends Error {
  readonly code = "JOURNAL_NEEDS_MIGRATION";
  constructor(
    readonly path: string,
    readonly lines: number[],
  ) {
    super(
      `${path} has ${lines.length} timestamp line(s) this version cannot read ` +
        `(line ${lines.slice(0, 5).join(", ")}${lines.length > 5 ? ", …" : ""}). ` +
        `Run \`${resolveBinName()} journal migrate\` to preview the rewrite, then ` +
        `\`${resolveBinName()} journal migrate --yes\`; refusing to rewrite the file ` +
        "because that would merge or drop those entries.",
    );
    this.name = "JournalNeedsMigrationError";
  }
}

/**
 * Read a journal a writer is about to rewrite. The caller holds the journal
 * lock. A file that still carries retired timestamps (written by a build
 * before ADR 0237, for example by the same session before Harnery updated
 * mid-session) goes through the bounded migration first, with the original
 * saved under `.migration-backup/`. Only lines the migration cannot convert
 * make the writer refuse, because rewriting would fold them into neighbours.
 */
function readWritableJournal(path: string): JournalDoc | null {
  if (!existsSync(path)) return null;
  let doc = parseJournal(path, readFileSync(path, "utf8"));
  if (doc.unreadable_lines.length === 0) return doc;
  const dir = dirname(path);
  const migrated = migrateJournalFile(dir, path, {
    apply: true,
    backupDir: migrationBackupDir(dir),
  });
  if (!migrated?.changed) throw new JournalNeedsMigrationError(path, doc.unreadable_lines);
  doc = parseJournal(path, readFileSync(path, "utf8"));
  if (doc.unreadable_lines.length > 0) {
    throw new JournalNeedsMigrationError(path, doc.unreadable_lines);
  }
  return doc;
}

function writeJournalAtomic(path: string, serialized: string): void {
  const tmpPath = `${path}.tmp.${process.pid}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmpPath, serialized, "utf8");
  renameSync(tmpPath, path);
}

export interface AppendEntryOptions {
  /** Coordination root; defaults to the current one. */
  root?: string;
  /** Write time; defaults to now. */
  now?: Date;
}

export function appendEntry(
  instanceId: string,
  category: JournalCategory,
  body: string,
  opts: AppendEntryOptions = {},
): JournalDoc {
  const root = rootOrThrow(opts.root);
  const path = journalPath(instanceId, root);
  return withJournalLock(journalDir(root), () => {
    const hb = readLiveCoordinationRow(root, instanceId);
    const zone = resolveTimeZone(root);
    const now = opts.now ?? new Date();
    let doc = readWritableJournal(path);
    if (!doc) {
      // Seed `started` from the heartbeat's session start so cross-agent writes
      // (`harn agents ping`) don't stamp the peer's journal with our wall-clock.
      const startedAt = hb?.started_at ? new Date(hb.started_at) : now;
      doc = {
        path,
        header: {
          name: hb?.name ?? "unknown",
          session_id: hb?.session_id ?? instanceId,
          machine: resolveMachineLabel(),
          started: formatJournalTimestamp(
            Number.isFinite(startedAt.getTime()) ? startedAt : now,
            zone,
          ),
          last_updated: "",
        },
        entries: [],
        bytes: 0,
        unreadable_lines: [],
      };
    }

    const display = formatJournalTimestamp(now, zone);
    const entry: JournalEntry = {
      ts_iso: parseJournalTimestamp(display)?.iso ?? now.toISOString(),
      ts_display: display,
      category,
      body: body.trim(),
    };
    doc.entries.unshift(entry);
    doc.header.last_updated = entry.ts_display;
    if (!doc.header.name || doc.header.name === "unknown") {
      doc.header.name = hb?.name ?? doc.header.name;
    }

    // Prune from the tail until under cap.
    let serialized = serializeJournal(doc);
    let pruned = 0;
    while (Buffer.byteLength(serialized, "utf8") > MAX_JOURNAL_BYTES && doc.entries.length > 1) {
      doc.entries.pop();
      pruned++;
      serialized = serializeJournal(doc);
    }
    if (pruned > 0) {
      const pruneEntry: JournalEntry = {
        ts_iso: entry.ts_iso,
        ts_display: entry.ts_display,
        category: "note",
        body: `(auto-pruned ${pruned} oldest entries to stay under ${MAX_JOURNAL_BYTES}-byte cap)`,
      };
      doc.entries.unshift(pruneEntry);
      serialized = serializeJournal(doc);
    }
    doc.bytes = Buffer.byteLength(serialized, "utf8");
    writeJournalAtomic(path, serialized);
    return doc;
  });
}

export type EntryMutationResult =
  | { ok: true; bytes: number; entries: number }
  | { ok: false; error: string };

function mutateEntry(
  instanceId: string,
  index: number,
  expectedTsDisplay: string,
  mutate: (doc: JournalDoc) => void,
  root?: string,
): EntryMutationResult {
  const resolvedRoot = rootOrThrow(root);
  const path = journalPath(instanceId, resolvedRoot);
  return withJournalLock(journalDir(resolvedRoot), () => {
    const doc = readWritableJournal(path);
    if (!doc) return { ok: false, error: "journal not found" };
    if (!Number.isInteger(index) || index < 0 || index >= doc.entries.length) {
      return { ok: false, error: `index ${index} out of range` };
    }
    if (doc.entries[index]!.ts_display !== expectedTsDisplay) {
      return {
        ok: false,
        error: `entry at index ${index} no longer matches (someone else may have edited)`,
      };
    }
    // Keep the pre-edit file as an archive (audit trail), then rewrite.
    archiveJournal(instanceId, resolvedRoot);
    mutate(doc);
    const serialized = serializeJournal(doc);
    writeJournalAtomic(path, serialized);
    return { ok: true, bytes: Buffer.byteLength(serialized, "utf8"), entries: doc.entries.length };
  });
}

/**
 * Replace one entry's category and body by its newest-first index. The stamp
 * is kept: an edit preserves the entry's identity. `expectedTsDisplay` guards
 * against a concurrent writer having shifted the entries.
 */
export function editEntry(
  instanceId: string,
  index: number,
  expectedTsDisplay: string,
  category: JournalCategory,
  body: string,
  root?: string,
): EntryMutationResult {
  return mutateEntry(
    instanceId,
    index,
    expectedTsDisplay,
    (doc) => {
      const target = doc.entries[index]!;
      target.category = category;
      target.body = body.trim();
    },
    root,
  );
}

/** Delete one entry by its newest-first index, with the same guard as `editEntry`. */
export function deleteEntry(
  instanceId: string,
  index: number,
  expectedTsDisplay: string,
  root?: string,
): EntryMutationResult {
  return mutateEntry(
    instanceId,
    index,
    expectedTsDisplay,
    (doc) => {
      doc.entries.splice(index, 1);
    },
    root,
  );
}

// ─── Archive lifecycle ────────────────────────────────────────────────────

/** Move `<owner>.md` → `archived/<owner>-<ts>.md`. No-op if missing. Returns archive path (or null). */
export function archiveJournal(instanceId: string, root?: string | null): string | null {
  assertSafeInstanceId(instanceId);
  const resolvedRoot = rootOrThrow(root);
  return withJournalLock(journalDir(resolvedRoot), () => {
    const src = journalPath(instanceId, resolvedRoot);
    if (!existsSync(src)) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = resolveContainedFile(archiveDir(resolvedRoot), `${instanceId}-${ts}.md`);
    renameSync(src, dest);
    return dest;
  });
}

/** Delete archives older than `days`. Returns number deleted. */
export function pruneArchives(days = ARCHIVE_RETENTION_DAYS): number {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const dir = archiveDir();
  return withJournalLock(journalDir(), () => {
    let deleted = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const fp = resolve(dir, f);
      try {
        const s = statSync(fp);
        if (s.mtimeMs < cutoff) {
          unlinkSync(fp);
          deleted++;
        }
      } catch {
        // skip
      }
    }
    return deleted;
  });
}

/** Sweep journals whose corresponding authoritative V3 generation is gone. */
export function sweepOrphanJournals(): string[] {
  const dir = journalDir();
  const root = monorepoRoot();
  const archived: string[] = [];
  if (!root) return archived;
  let view: ReturnType<typeof readCoordinationViewV3>;
  try {
    if (observeLiveEventLedgerRouteV3(root).state === "blocked") return archived;
    view = requireAuthoritySafeCoordinationViewV3(readCoordinationViewV3(root));
    if (!view.source_complete) return archived;
  } catch {
    // A missing or unsafe read does not prove that an owner has ended.
    return archived;
  }
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const instanceId = f.replace(/\.md$/, "");
    if (!view.instances[liveInstanceIdV3(instanceId)]) {
      const dest = archiveJournal(instanceId);
      if (dest) archived.push(dest);
    }
  }
  return archived;
}

/** List archive files sorted by mtime descending. */
export function listArchives(): {
  path: string;
  basename: string;
  mtimeMs: number;
  bytes: number;
}[] {
  const dir = archiveDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const fp = resolve(dir, f);
      const s = statSync(fp);
      return { path: fp, basename: f, mtimeMs: s.mtimeMs, bytes: s.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

export function currentOwnerOrThrow(): string {
  const owner = resolveOwner();
  if (!owner) {
    throw new Error("Not in an agent session; ppid walk found no pid-map entry.");
  }
  return owner;
}

export function loadJournal(instanceId: string, root?: string | null): JournalDoc | null {
  const path = journalPath(instanceId, root);
  if (!existsSync(path)) return null;
  return parseJournal(path, readFileSync(path, "utf8"));
}

/** Resolve an agent name through the authority-safe V3 coordination projection. */
export function resolveOwnerByName(name: string): string | null {
  const root = monorepoRoot();
  if (!root) return null;
  return (
    readLiveCoordinationRows(root).find(
      (row) => (row.name ?? "").toLowerCase() === name.toLowerCase(),
    )?.instance_id ?? null
  );
}
