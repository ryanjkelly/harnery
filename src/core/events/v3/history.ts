import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseDurationMs } from "../../../lib/duration.ts";
import { eventV3ArchivesRoot } from "./archive-retention.ts";
import { EVENT_V3_LEDGER_RELATIVE_ROOT } from "./reader.ts";

/**
 * Read-only search across the whole retained V3 history: the active epoch plus
 * every closed epoch under `ledgers/v3-archives/`. The active file alone covers
 * only the time since the last size rotation (32 MiB by default), which made
 * agents conclude the ledger held a few hundred events when the archives held
 * weeks. This reader is for inspection and counting. It does not validate
 * authority; consumers that need the canonical boundary keep `readLedgerV3`.
 * ADR 0080 records it as the one sanctioned raw inspection reader. It takes
 * epoch locations from their owners (the canonical reader for the active
 * epoch, archive retention for closed epochs) and never parses the catalog.
 */

export interface EventHistoryEpochV3 {
  /** `active` for the live epoch, otherwise the archive directory name. */
  name: string;
  relative_path: string;
  files: string[];
  bytes: number;
  events: number;
  malformed_lines: number;
  first_at: string | null;
  last_at: string | null;
}

export interface EventHistoryRowV3 {
  epoch: string;
  event_id: string;
  event_type: string;
  recorded_at: string;
  instance_id: string | null;
  component: string | null;
  /** Tool name or command executable, joined from the opening event when needed. */
  subject: string | null;
  outcome: string | null;
  duration_ms: number | null;
  exit_code: number | null;
}

export interface EventHistoryFilterV3 {
  since?: Date;
  until?: Date;
  /** Exact types, or prefixes ending in `.` or `*` (`tool.`, `coord.*`). */
  types?: string[];
  /** Instance id prefix, with or without the `inst_` prefix. */
  session?: string;
  /** Tool name or command executable, case-insensitive exact match. */
  subject?: string;
  outcome?: string;
}

export interface EventHistoryScanV3 {
  epochs: EventHistoryEpochV3[];
  rows: EventHistoryRowV3[];
  scanned_epochs: number;
  skipped_epochs: number;
}

const EPOCH_STAMP = /^epoch-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})/;

/** Every retained epoch, oldest first, with the active epoch last. */
export function listEventHistoryEpochsV3(coordRoot: string): Array<{
  name: string;
  dir: string;
  relative_path: string;
  closed_at: Date | null;
}> {
  const archives = eventV3ArchivesRoot(coordRoot);
  const rows: Array<{ name: string; dir: string; relative_path: string; closed_at: Date | null }> =
    [];
  if (existsSync(archives)) {
    for (const name of readdirSync(archives).sort()) {
      const dir = join(archives, name);
      const match = EPOCH_STAMP.exec(name);
      if (!match || !isDirectory(dir)) continue;
      const [, y, mo, d, h, mi, s, ms] = match;
      rows.push({
        name,
        dir,
        relative_path: repoRelative(coordRoot, dir),
        closed_at: new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`),
      });
    }
  }
  const active = join(coordRoot, EVENT_V3_LEDGER_RELATIVE_ROOT);
  if (isDirectory(active)) {
    rows.push({
      name: "active",
      dir: active,
      relative_path: EVENT_V3_LEDGER_RELATIVE_ROOT,
      closed_at: null,
    });
  }
  return rows;
}

/** Scan retained epochs, skipping any that closed before `filter.since`. */
export function scanEventHistoryV3(
  coordRoot: string,
  filter: EventHistoryFilterV3 = {},
  options: { collectRows?: boolean } = {},
): EventHistoryScanV3 {
  const collectRows = options.collectRows ?? true;
  const epochs: EventHistoryEpochV3[] = [];
  const rows: EventHistoryRowV3[] = [];
  let skipped = 0;
  const typeMatch = typeMatcher(filter.types);
  const session = normalizeSession(filter.session);
  const subject = filter.subject?.toLowerCase();
  const outcome = filter.outcome?.toLowerCase();
  const sinceMs = filter.since?.getTime();
  const untilMs = filter.until?.getTime();

  for (const epoch of listEventHistoryEpochsV3(coordRoot)) {
    if (sinceMs !== undefined && epoch.closed_at && epoch.closed_at.getTime() < sinceMs) {
      skipped++;
      continue;
    }
    const files = epochFiles(epoch.dir);
    const summary: EventHistoryEpochV3 = {
      name: epoch.name,
      relative_path: epoch.relative_path,
      files: files.map((file) => file.slice(epoch.dir.length + 1)),
      bytes: 0,
      events: 0,
      malformed_lines: 0,
      first_at: null,
      last_at: null,
    };
    // Completions carry no tool name or executable; join them to their opening event.
    const openers = new Map<string, string>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      summary.bytes += Buffer.byteLength(text);
      for (const line of text.split("\n")) {
        if (!line) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          summary.malformed_lines++;
          continue;
        }
        const recordedAt = str(obj(event.time)?.recorded_at);
        const eventType = str(event.event_type);
        if (!recordedAt || !eventType) {
          summary.malformed_lines++;
          continue;
        }
        summary.events++;
        if (!summary.first_at || recordedAt < summary.first_at) summary.first_at = recordedAt;
        if (!summary.last_at || recordedAt > summary.last_at) summary.last_at = recordedAt;
        if (!collectRows) continue;

        const payload = obj(event.payload) ?? {};
        const eventId = str(event.event_id) ?? "";
        const opener = openerSubject(eventType, payload);
        if (opener) openers.set(eventId, opener);

        const at = Date.parse(recordedAt);
        if (sinceMs !== undefined && at < sinceMs) continue;
        if (untilMs !== undefined && at >= untilMs) continue;
        if (!typeMatch(eventType)) continue;
        const instanceId = str(obj(event.scope)?.instance_id) ?? null;
        if (session && !(instanceId ?? "").startsWith(session)) continue;
        const openEventId = str(obj(payload.span)?.open_event_id);
        const rowSubject = opener ?? (openEventId ? (openers.get(openEventId) ?? null) : null);
        if (subject && rowSubject?.toLowerCase() !== subject) continue;
        const rowOutcome = str(payload.outcome) ?? null;
        if (outcome && rowOutcome?.toLowerCase() !== outcome) continue;

        rows.push({
          epoch: epoch.name,
          event_id: eventId,
          event_type: eventType,
          recorded_at: recordedAt,
          instance_id: instanceId,
          component: str(obj(event.producer)?.component) ?? null,
          subject: rowSubject,
          outcome: rowOutcome,
          duration_ms: observedNumber(payload.duration_ms),
          exit_code: typeof payload.exit_code === "number" ? payload.exit_code : null,
        });
      }
    }
    epochs.push(summary);
  }
  rows.sort(
    (left, right) =>
      left.recorded_at.localeCompare(right.recorded_at) ||
      left.event_id.localeCompare(right.event_id),
  );
  return { epochs, rows, scanned_epochs: epochs.length, skipped_epochs: skipped };
}

export type EventHistoryGroupV3 =
  | "type"
  | "session"
  | "subject"
  | "outcome"
  | "day"
  | "hour"
  | "epoch";

/** Count rows by one dimension, largest group first. */
export function countEventHistoryV3(
  rows: readonly EventHistoryRowV3[],
  by: EventHistoryGroupV3,
  timeZone?: string,
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = groupKey(row, by, timeZone);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) =>
      by === "day" || by === "hour" || by === "epoch"
        ? left.key.localeCompare(right.key)
        : right.count - left.count || left.key.localeCompare(right.key),
    );
}

/** Parse `30d`, `12h`, `90m`, or an ISO date/time into an absolute instant. */
export function parseHistoryInstantV3(value: string, now: Date = new Date()): Date {
  const relativeMs = parseDurationMs(value);
  if (relativeMs !== null) return new Date(now.getTime() - relativeMs);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`cannot read "${value}" as a time; use 30d, 12h, 90m, or an ISO date`);
  }
  return new Date(parsed);
}

function groupKey(row: EventHistoryRowV3, by: EventHistoryGroupV3, timeZone?: string): string {
  switch (by) {
    case "type":
      return row.event_type;
    case "session":
      return row.instance_id ?? "(none)";
    case "subject":
      return row.subject ?? "(none)";
    case "outcome":
      return row.outcome ?? "(none)";
    case "epoch":
      return row.epoch;
    case "day":
      return localStamp(row.recorded_at, timeZone).slice(0, 10);
    case "hour":
      return `${localStamp(row.recorded_at, timeZone).slice(0, 13)}:00`;
  }
}

/** `YYYY-MM-DD HH:MM:SS` in the given (or local) time zone. */
export function localStamp(iso: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function repoRelative(coordRoot: string, path: string): string {
  return relative(resolve(coordRoot), path).split("\\").join("/");
}

function epochFiles(dir: string): string[] {
  const files: string[] = [];
  const segments = join(dir, "segments");
  if (isDirectory(segments)) {
    for (const name of readdirSync(segments).sort()) {
      if (name.endsWith(".ndjson")) files.push(join(segments, name));
    }
  }
  const active = join(dir, "active.ndjson");
  if (existsSync(active)) files.push(active);
  return files;
}

function openerSubject(eventType: string, payload: Record<string, unknown>): string | null {
  if (eventType === "tool.requested") {
    const tool = obj(payload.tool);
    const name = str(tool?.name);
    return name ?? null;
  }
  if (eventType === "command.started") return str(payload.executable) ?? null;
  return null;
}

function typeMatcher(types: string[] | undefined): (type: string) => boolean {
  if (!types || types.length === 0) return () => true;
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const raw of types.flatMap((value) => value.split(","))) {
    const value = raw.trim();
    if (!value) continue;
    if (value.endsWith("*")) prefixes.push(value.slice(0, -1));
    else if (value.endsWith(".")) prefixes.push(value);
    else exact.add(value);
  }
  return (type) => exact.has(type) || prefixes.some((prefix) => type.startsWith(prefix));
}

function normalizeSession(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("inst_") ? value : `inst_${value}`;
}

function observedNumber(value: unknown): number | null {
  const metric = obj(value);
  return metric?.state === "observed" && typeof metric.value === "number" ? metric.value : null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
