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
  readHeartbeat,
  resolveOwner,
} from "../agents/index.ts";

/**
 * Agent scratchpad: per-agent markdown journal at `.harnery/scratch/<instance_id>.md`.
 *
 * Rules:
 *   - Single writer (the agent itself, via this lib). Peers read but never write.
 *   - Append-only, newest entry first. Atomic temp-file + rename on each write.
 *   - Strict entry-header format: `## <Chicago datetime> · <category>`. The
 *     linter enforces this so format violations are impossible at the write path.
 *   - 50 KB hard cap; auto-prunes oldest entries when exceeded.
 *   - SessionEnd hook archives to `.harnery/scratch/archived/<instance_id>-<ts>.md`;
 *     SessionStart janitor deletes archives older than 7 days + surfaces the
 *     most-recent archive as a recovery cue.
 */

export const SCRATCH_CATEGORIES = [
  "note",
  "plan",
  "decision",
  "blocker",
  "question",
  "done",
  "handoff",
] as const;

export type ScratchCategory = (typeof SCRATCH_CATEGORIES)[number];

export const MAX_SCRATCH_BYTES = 50 * 1024;
export const WARN_SCRATCH_BYTES = 40 * 1024;
export const ARCHIVE_RETENTION_DAYS = 7;

/** Entry-header regex: `## 2026-05-15 1:48 AM CDT · note` */
export const ENTRY_HEADER_RE =
  /^## (\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2}) (AM|PM) (CDT|CST) · (note|plan|decision|blocker|question|done|handoff)$/;

/** First line of every scratchpad file: this prefix followed by the agent name. */
export const SCRATCHPAD_HEADER_PREFIX = "# Scratchpad: agent-";

export interface ScratchEntry {
  ts_iso: string; // canonical ISO (computed from Chicago wall time at write)
  ts_display: string; // "2026-05-15 1:48 AM CDT", what's in the file
  category: ScratchCategory;
  body: string;
}

export interface ScratchHeader {
  name: string;
  session_id: string;
  machine: string;
  started: string;
  last_updated: string;
}

export interface ScratchDoc {
  path: string;
  header: ScratchHeader;
  entries: ScratchEntry[];
  bytes: number;
}

// ─── Paths ────────────────────────────────────────────────────────────────

export function scratchDir(): string {
  const root = monorepoRoot();
  if (!root) throw new Error("Not in a coord-aware repo (coord_root() returned null).");
  const dir = resolve(root, ".harnery", "scratch");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function archiveDir(): string {
  const dir = resolve(scratchDir(), "archived");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function scratchPath(instanceId: string): string {
  assertSafeInstanceId(instanceId);
  return resolve(scratchDir(), `${instanceId}.md`);
}

// ─── Chicago time formatting ──────────────────────────────────────────────

const CHICAGO_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
  hour12: true,
  timeZone: "America/Chicago",
});

/** Format `Date` as `2026-05-15 1:48 AM CDT`, what we write into the file. */
export function formatChicago(d: Date = new Date()): string {
  const parts = CHICAGO_FORMATTER.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const dayPeriod = get("dayPeriod");
  const tz = get("timeZoneName");
  return `${year}-${month}-${day} ${hour}:${minute} ${dayPeriod} ${tz}`;
}

// ─── Parse / serialize ────────────────────────────────────────────────────

/** Parse a scratchpad file (or empty content) into a structured doc. */
export function parseScratch(path: string, content: string): ScratchDoc {
  const lines = content.split("\n");
  const header: ScratchHeader = {
    name: "unknown",
    session_id: "",
    machine: "",
    started: "",
    last_updated: "",
  };
  const entries: ScratchEntry[] = [];

  let i = 0;
  // ── header ──
  if (lines[i]?.startsWith(SCRATCHPAD_HEADER_PREFIX)) {
    header.name = lines[i].replace(SCRATCHPAD_HEADER_PREFIX, "").trim();
    i++;
  }
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === "---") {
      i++;
      break;
    }
    const separator = line.indexOf(":");
    if (separator > 0) {
      const key = line.slice(0, separator);
      if (
        key === "session_id" ||
        key === "machine" ||
        key === "started" ||
        key === "last_updated"
      ) {
        const value = line.slice(separator + 1).trim();
        if (value) (header as unknown as Record<string, string>)[key] = value;
      }
    }
  }

  // ── entries ──
  let currentHeader: string | null = null;
  let bodyLines: string[] = [];
  const flush = () => {
    if (!currentHeader) return;
    const m = currentHeader.match(ENTRY_HEADER_RE);
    if (!m) {
      currentHeader = null;
      bodyLines = [];
      return;
    }
    const [, date, hour, minute, period, tz, category] = m;
    entries.push({
      ts_iso: chicagoToIso(date, hour, minute, period as "AM" | "PM", tz as "CDT" | "CST"),
      ts_display: `${date} ${hour}:${minute} ${period} ${tz}`,
      category: category as ScratchCategory,
      body: bodyLines.join("\n").trim(),
    });
    currentHeader = null;
    bodyLines = [];
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      flush();
      currentHeader = line;
    } else if (currentHeader) {
      bodyLines.push(line);
    }
  }
  flush();

  return { path, header, entries, bytes: Buffer.byteLength(content, "utf8") };
}

/** Serialize a parsed doc back to markdown. */
export function serializeScratch(doc: ScratchDoc): string {
  const lines: string[] = [];
  lines.push(`${SCRATCHPAD_HEADER_PREFIX}${doc.header.name}`);
  if (doc.header.session_id) lines.push(`session_id: ${doc.header.session_id}`);
  if (doc.header.machine) lines.push(`machine: ${doc.header.machine}`);
  if (doc.header.started) lines.push(`started: ${doc.header.started}`);
  if (doc.header.last_updated) lines.push(`last_updated: ${doc.header.last_updated}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const entry of doc.entries) {
    lines.push(`## ${entry.ts_display} · ${entry.category}`);
    if (entry.body.length > 0) {
      lines.push(entry.body);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function chicagoToIso(
  date: string,
  hourStr: string,
  minute: string,
  period: "AM" | "PM",
  tz: "CDT" | "CST",
): string {
  let hour = Number.parseInt(hourStr, 10);
  if (period === "PM" && hour !== 12) hour += 12;
  if (period === "AM" && hour === 12) hour = 0;
  const offset = tz === "CDT" ? "-05:00" : "-06:00";
  const hh = String(hour).padStart(2, "0");
  return `${date}T${hh}:${minute}:00${offset}`;
}

// ─── Lint ─────────────────────────────────────────────────────────────────

export interface LintIssue {
  line: number;
  message: string;
}

export function lintScratch(content: string, byteCap = MAX_SCRATCH_BYTES): LintIssue[] {
  const issues: LintIssue[] = [];
  const lines = content.split("\n");

  // Frontmatter checks
  if (!lines[0]?.startsWith(SCRATCHPAD_HEADER_PREFIX)) {
    issues.push({ line: 1, message: `missing '${SCRATCHPAD_HEADER_PREFIX}<name>' header` });
  }
  for (const required of ["session_id:", "machine:", "started:"]) {
    if (!lines.slice(0, 10).some((l) => l.startsWith(required))) {
      issues.push({ line: 1, message: `missing frontmatter field '${required}'` });
    }
  }

  // Entry header + chronological order checks
  const entryTimes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("## ")) continue;
    if (!ENTRY_HEADER_RE.test(line)) {
      issues.push({ line: i + 1, message: `malformed entry header: ${line}` });
      continue;
    }
    const m = line.match(ENTRY_HEADER_RE)!;
    const iso = chicagoToIso(m[1], m[2], m[3], m[4] as "AM" | "PM", m[5] as "CDT" | "CST");
    const ts = Date.parse(iso);
    if (Number.isFinite(ts)) entryTimes.push(ts);
  }
  for (let i = 1; i < entryTimes.length; i++) {
    if (entryTimes[i] > entryTimes[i - 1]) {
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
    if (/\s$/.test(lines[i]) && lines[i].length > 0) {
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

// ─── Append + prune ───────────────────────────────────────────────────────

export function appendEntry(
  instanceId: string,
  category: ScratchCategory,
  body: string,
): ScratchDoc {
  const hb = readHeartbeat(instanceId);
  const path = scratchPath(instanceId);
  let doc: ScratchDoc;
  if (existsSync(path)) {
    doc = parseScratch(path, readFileSync(path, "utf8"));
  } else {
    // Seed `started` from the heartbeat's session start so cross-agent writes
    // (`harn agents ping`) don't stamp the peer's scratchpad with our wall-clock.
    const startedSeed = hb?.started_at ? formatChicago(new Date(hb.started_at)) : formatChicago();
    doc = {
      path,
      header: {
        name: hb?.name ?? "unknown",
        session_id: hb?.session_id ?? instanceId,
        machine: resolveMachineLabel(),
        started: startedSeed,
        last_updated: "",
      },
      entries: [],
      bytes: 0,
    };
  }

  const now = new Date();
  const entry: ScratchEntry = {
    ts_iso: now.toISOString(),
    ts_display: formatChicago(now),
    category,
    body: body.trim(),
  };
  doc.entries.unshift(entry);
  doc.header.last_updated = entry.ts_display;
  if (!doc.header.name || doc.header.name === "unknown") {
    doc.header.name = hb?.name ?? doc.header.name;
  }

  // Prune from the tail until under cap.
  let serialized = serializeScratch(doc);
  let pruned = 0;
  while (Buffer.byteLength(serialized, "utf8") > MAX_SCRATCH_BYTES && doc.entries.length > 1) {
    doc.entries.pop();
    pruned++;
    serialized = serializeScratch(doc);
  }
  if (pruned > 0) {
    const pruneEntry: ScratchEntry = {
      ts_iso: new Date().toISOString(),
      ts_display: formatChicago(),
      category: "note",
      body: `(auto-pruned ${pruned} oldest entries to stay under ${MAX_SCRATCH_BYTES}-byte cap)`,
    };
    doc.entries.unshift(pruneEntry);
    serialized = serializeScratch(doc);
  }
  doc.bytes = Buffer.byteLength(serialized, "utf8");

  // Atomic write
  const tmpPath = `${path}.tmp.${process.pid}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmpPath, serialized, "utf8");
  renameSync(tmpPath, path);

  return doc;
}

// ─── Archive lifecycle ────────────────────────────────────────────────────

/** Move `<owner>.md` → `archived/<owner>-<ts>.md`. No-op if missing. Returns archive path (or null). */
export function archiveScratch(instanceId: string): string | null {
  assertSafeInstanceId(instanceId);
  const src = scratchPath(instanceId);
  if (!existsSync(src)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = resolve(archiveDir(), `${instanceId}-${ts}.md`);
  renameSync(src, dest);
  return dest;
}

/** Delete archives older than `days`. Returns number deleted. */
export function pruneArchives(days = ARCHIVE_RETENTION_DAYS): number {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const dir = archiveDir();
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
}

/** Sweep `.harnery/scratch/<owner>.md` files whose corresponding heartbeat is gone. */
export function sweepOrphanScratchpads(): string[] {
  const dir = scratchDir();
  const archived: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const instanceId = f.replace(/\.md$/, "");
    const hb = readHeartbeat(instanceId);
    if (!hb) {
      const dest = archiveScratch(instanceId);
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

export function loadScratch(instanceId: string): ScratchDoc | null {
  const path = scratchPath(instanceId);
  if (!existsSync(path)) return null;
  return parseScratch(path, readFileSync(path, "utf8"));
}

/** Resolve an agent name → instance_id by walking active heartbeats (case-insensitive). */
export function resolveOwnerByName(name: string): string | null {
  const root = monorepoRoot();
  if (!root) return null;
  const activeDir = resolve(root, ".harnery", "active");
  if (!existsSync(activeDir)) return null;
  for (const f of readdirSync(activeDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const hb = JSON.parse(readFileSync(resolve(activeDir, f), "utf8")) as {
        instance_id?: string;
        name?: string;
      };
      if ((hb.name ?? "").toLowerCase() === name.toLowerCase()) {
        return hb.instance_id ?? null;
      }
    } catch {
      // skip
    }
  }
  return null;
}
