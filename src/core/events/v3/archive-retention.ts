/** Bounded retention for complete, closed Event Ledger V3 epochs. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  artifactAutoCleanIntervalHours,
  type EventLedgerArchivePolicy,
  eventLedgerArchivePolicy,
} from "../../config.ts";

export type EventV3ArchiveClassification =
  | "retained"
  | "expired"
  | "over-budget"
  | "protected-minimum"
  | "unmanaged"
  | "symlink"
  | "unknown";

export interface EventV3ArchiveEntry {
  name: string;
  path: string;
  relative_path: string;
  classification: EventV3ArchiveClassification;
  reason: string;
  action: "keep" | "would-delete" | "deleted";
  bytes: number | null;
  last_modified_at: string | null;
}

export interface EventV3ArchiveAutoCleanResult {
  ran: boolean;
  reason: "swept" | "disabled" | "fresh" | "no-root";
  deleted: number;
  bytes: number;
}

const ARCHIVE_PATTERN = /^epoch-[0-9]+(?:-[0-9]+)?$/;
const AUTO_CLEAN_STAMP = ".harnery/event-v3-archive-auto-clean.json";

export function eventV3ArchivesRoot(repoRoot: string): string {
  return join(resolve(repoRoot), ".harnery", "ledgers", "v3-archives");
}

export function inventoryEventV3Archives(
  repoRoot: string,
  opts: { now?: Date; policy?: EventLedgerArchivePolicy } = {},
): EventV3ArchiveEntry[] {
  const root = eventV3ArchivesRoot(repoRoot);
  if (!existsSync(root)) return [];
  const now = opts.now ?? new Date();
  const policy = opts.policy ?? eventLedgerArchivePolicy(repoRoot);
  const rows = readdirSync(root)
    .sort()
    .map((name) => classifyArchive(repoRoot, join(root, name)));
  const managed = rows.filter(
    (row) => row.classification === "retained" && row.bytes !== null && row.last_modified_at,
  );
  const newestFirst = [...managed].sort((left, right) => right.name.localeCompare(left.name));
  const protectedNames = new Set(newestFirst.slice(0, policy.keepMin).map((row) => row.name));
  const cutoff = now.getTime() - policy.maxAgeDays * 24 * 60 * 60 * 1000;

  for (const row of managed) {
    if (protectedNames.has(row.name)) {
      row.classification = "protected-minimum";
      row.reason = `one of the newest ${policy.keepMin} complete epochs`;
      continue;
    }
    if (Date.parse(row.last_modified_at!) <= cutoff) {
      row.classification = "expired";
      row.reason = `closed epoch is older than ${policy.maxAgeDays} days`;
      row.action = "would-delete";
    }
  }

  let retainedBytes = managed.reduce((sum, row) => sum + (row.bytes ?? 0), 0);
  retainedBytes -= managed.reduce(
    (sum, row) => sum + (row.action === "would-delete" ? (row.bytes ?? 0) : 0),
    0,
  );
  const budgetCandidates = managed
    .filter((row) => row.classification === "retained")
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const row of budgetCandidates) {
    if (retainedBytes <= policy.maxBytes) break;
    row.classification = "over-budget";
    row.reason = `closed-epoch budget is ${policy.maxBytes} bytes; oldest epochs are removed first`;
    row.action = "would-delete";
    retainedBytes -= row.bytes ?? 0;
  }
  return rows;
}

export function cleanEventV3Archives(
  repoRoot: string,
  opts: { yes?: boolean; now?: Date; policy?: EventLedgerArchivePolicy } = {},
): EventV3ArchiveEntry[] {
  const rows = inventoryEventV3Archives(repoRoot, opts);
  if (!opts.yes) return rows;
  return rows.map((entry) => {
    if (entry.action !== "would-delete") return entry;
    const current = inventoryEventV3Archives(repoRoot, opts).find((row) => row.path === entry.path);
    if (!current) {
      return { ...entry, classification: "unknown", reason: "entry disappeared", action: "keep" };
    }
    if (
      current.action !== "would-delete" ||
      current.bytes !== entry.bytes ||
      current.last_modified_at !== entry.last_modified_at
    ) {
      return current;
    }
    try {
      const stat = lstatSync(current.path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !ARCHIVE_PATTERN.test(current.name)) {
        return {
          ...current,
          classification: "unknown",
          reason: "entry changed before deletion",
          action: "keep",
        };
      }
      rmSync(current.path, { recursive: true, force: false });
      return { ...current, action: "deleted" };
    } catch (error) {
      return {
        ...current,
        classification: "unknown",
        reason: `entry changed or could not be deleted: ${error instanceof Error ? error.message : String(error)}`,
        action: "keep",
      };
    }
  });
}

export function autoCleanEventV3Archives(
  repoRoot: string,
  opts: { now?: Date } = {},
): EventV3ArchiveAutoCleanResult {
  const now = opts.now ?? new Date();
  const root = eventV3ArchivesRoot(repoRoot);
  if (!existsSync(root)) return { ran: false, reason: "no-root", deleted: 0, bytes: 0 };
  const policy = eventLedgerArchivePolicy(repoRoot);
  if (!policy.autoClean) return { ran: false, reason: "disabled", deleted: 0, bytes: 0 };
  const stampPath = join(resolve(repoRoot), AUTO_CLEAN_STAMP);
  const intervalMs = artifactAutoCleanIntervalHours() * 60 * 60 * 1000;
  try {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as { last_run_at?: string };
    const last = Date.parse(stamp.last_run_at ?? "");
    if (Number.isFinite(last) && now.getTime() - last < intervalMs) {
      return { ran: false, reason: "fresh", deleted: 0, bytes: 0 };
    }
  } catch {
    // Missing or unreadable stamp: sweep now.
  }
  mkdirSync(join(resolve(repoRoot), ".harnery"), { recursive: true });
  writeFileSync(stampPath, `${JSON.stringify({ last_run_at: now.toISOString() }, null, 2)}\n`);
  const rows = cleanEventV3Archives(repoRoot, { yes: true, now, policy });
  const deletedRows = rows.filter((row) => row.action === "deleted");
  const result = {
    ran: true as const,
    reason: "swept" as const,
    deleted: deletedRows.length,
    bytes: deletedRows.reduce((sum, row) => sum + (row.bytes ?? 0), 0),
  };
  writeFileSync(
    stampPath,
    `${JSON.stringify({ last_run_at: now.toISOString(), ...result }, null, 2)}\n`,
  );
  return result;
}

function classifyArchive(repoRoot: string, path: string): EventV3ArchiveEntry {
  const name = basename(path);
  const base: EventV3ArchiveEntry = {
    name,
    path,
    relative_path: relative(repoRoot, path),
    classification: "retained",
    reason: "closed epoch is inside the retention window",
    action: "keep",
    bytes: null,
    last_modified_at: null,
  };
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      return {
        ...base,
        classification: "symlink",
        reason: "symlinks are never traversed or deleted",
        bytes: stat.size,
      };
    }
    if (!stat.isDirectory() || !ARCHIVE_PATTERN.test(name)) {
      return {
        ...base,
        classification: "unmanaged",
        reason: "entry is not a complete named epoch",
      };
    }
    const measured = measureTree(path);
    if (!measured) {
      return {
        ...base,
        classification: "unknown",
        reason: "one or more epoch paths are unreadable",
      };
    }
    return {
      ...base,
      bytes: measured.bytes,
      last_modified_at: new Date(measured.lastModifiedMs).toISOString(),
    };
  } catch (error) {
    return {
      ...base,
      classification: "unknown",
      reason: `cannot inspect archive: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function measureTree(path: string): { bytes: number; lastModifiedMs: number } | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || stat.isFile()) {
      return { bytes: stat.size, lastModifiedMs: stat.mtimeMs };
    }
    if (!stat.isDirectory()) return { bytes: 0, lastModifiedMs: stat.mtimeMs };
    let bytes = stat.size;
    let lastModifiedMs = stat.mtimeMs;
    for (const child of readdirSync(path)) {
      const measured = measureTree(join(path, child));
      if (!measured) return null;
      bytes += measured.bytes;
      lastModifiedMs = Math.max(lastModifiedMs, measured.lastModifiedMs);
    }
    return { bytes, lastModifiedMs };
  } catch {
    return null;
  }
}
