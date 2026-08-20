import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { fsyncParentDirectory } from "../../workflow/durable-record.ts";
import { acquireNoClobberLease } from "../../workflow/workspaces/leases.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import type { EventV3 } from "./contract.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { assertEventV3 } from "./validate.ts";

const MAX_LINE_BYTES = 16 * 1024;
const DEFAULT_LEASE_MS = 5_000;

export const EVENT_V3_LEDGER_RELATIVE_ROOT = ".harnery/ledgers/v3" as const;

export type EventV3DurabilityState = "committed" | "ready";

export interface WriteEventV3Result {
  state: EventV3DurabilityState;
  event_id: string;
  row_digest: `sha256:${string}`;
  ready_path?: string;
  diagnostic_code?: "wal_drain_failed";
}

export interface WriteEventV3Options {
  leaseMs?: number;
  now?: () => number;
  onStep?: (step: EventV3WriteStep, eventId?: string) => void;
}

export type EventV3WriteStep =
  | "ready_temp_flushed"
  | "ready_published"
  | "active_tail_repaired"
  | "active_row_appended"
  | "active_row_flushed"
  | "receipt_committed"
  | "receipt_removed";

/**
 * Persist one already-normalized V3 event through the spool-first WAL.
 *
 * A successful ready rename is the durability boundary. Lease contention or
 * append failure leaves that ready record recoverable and returns `ready`
 * instead of changing the producing tool's result.
 */
export function writeEventV3(
  coordRoot: string,
  event: EventV3,
  options: WriteEventV3Options = {},
): WriteEventV3Result {
  assertEventV3(event);
  if (event.contract.schema_digest !== EVENT_V3_SCHEMA_DIGEST) {
    throw new Error("event schema digest is not accepted by this V3 writer");
  }
  const row = `${canonicalJsonV3(event)}\n`;
  const bytes = Buffer.byteLength(row, "utf8");
  if (bytes > MAX_LINE_BYTES) {
    throw new Error(`event exceeds the V3 ${MAX_LINE_BYTES}-byte row limit`);
  }
  const paths = ensureEventV3Layout(coordRoot);
  const rowDigest = sha256V3(row);
  const readyName = `${String(event.producer.sequence).padStart(16, "0")}-${event.event_id}-${rowDigest.slice(7)}.ready`;
  const readyPath = join(paths.spool, readyName);
  writeReadyRecord(paths.spool, readyPath, row, event.event_id, options.onStep);

  try {
    drainReadyEventsV3(coordRoot, options);
  } catch {
    return {
      state: "ready",
      event_id: event.event_id,
      row_digest: rowDigest,
      ready_path: readyPath,
      diagnostic_code: "wal_drain_failed",
    };
  }
  return existsSync(readyPath)
    ? {
        state: "ready",
        event_id: event.event_id,
        row_digest: rowDigest,
        ready_path: readyPath,
      }
    : { state: "committed", event_id: event.event_id, row_digest: rowDigest };
}

/** Drain every durable ready record under the fenced append lease. */
export function drainReadyEventsV3(coordRoot: string, options: WriteEventV3Options = {}): number {
  const paths = ensureEventV3Layout(coordRoot);
  return withEventV3LedgerLease(coordRoot, options, () =>
    drainReadyEventsUnderLeaseV3(paths, options),
  );
}

export function withEventV3LedgerLease<T>(
  coordRoot: string,
  options: WriteEventV3Options,
  operation: () => T,
): T {
  const paths = ensureEventV3Layout(coordRoot);
  const authority = createHash("sha256")
    .update(resolve(coordRoot))
    .update("\0")
    .update(EVENT_V3_SCHEMA_DIGEST)
    .digest("hex");
  const lease = acquireNoClobberLease({
    path: paths.lease,
    scope: "event-v3-append",
    authoritySha256: authority,
    staleAfterMs: options.leaseMs ?? DEFAULT_LEASE_MS,
    now: options.now,
    validateStaleOwner: (owner) => owner.host === hostname() && !pidIsAlive(owner.pid),
  });
  try {
    return operation();
  } finally {
    lease.release();
  }
}

export function drainReadyEventsUnderLeaseV3(
  paths: ReturnType<typeof eventV3Paths>,
  options: WriteEventV3Options = {},
): number {
  if (repairUnterminatedActiveFrame(paths.active)) {
    options.onStep?.("active_tail_repaired");
  }
  requeueCommittedReceipts(paths.spool);
  const readyNames = readdirSync(paths.spool)
    .filter((name) => name.endsWith(".ready"))
    .sort();
  if (readyNames.length === 0) return 0;
  const readyRows = causallyOrderedReadyRows(
    readyNames.map((readyName) => {
      const readyPath = join(paths.spool, readyName);
      const row = readAndValidateReadyRow(readyPath);
      return {
        readyName,
        readyPath,
        row,
        event: JSON.parse(row) as EventV3,
      };
    }),
  );
  const activeFd = openSync(paths.active, "a", 0o600);
  let committed = 0;
  try {
    for (const { readyName, readyPath, row } of readyRows) {
      const eventId = eventIdFromReadyName(readyName);
      writeSync(activeFd, row, undefined, "utf8");
      options.onStep?.("active_row_appended", eventId);
      fsyncSync(activeFd);
      options.onStep?.("active_row_flushed", eventId);
      const committedPath = `${readyPath.slice(0, -".ready".length)}.committed`;
      renameSync(readyPath, committedPath);
      fsyncParentDirectory(committedPath);
      options.onStep?.("receipt_committed", eventId);
      unlinkSync(committedPath);
      fsyncParentDirectory(committedPath);
      options.onStep?.("receipt_removed", eventId);
      committed += 1;
    }
  } finally {
    closeSync(activeFd);
  }
  return committed;
}

interface ReadyEventRowV3 {
  readyName: string;
  readyPath: string;
  row: string;
  event: EventV3;
}

/**
 * Keep the spool's deterministic filename order except where a ready event
 * names another ready event as a cause. Those dependencies are committed
 * first; a cycle stays in the WAL and never poisons the active authority.
 */
function causallyOrderedReadyRows(rows: ReadyEventRowV3[]): ReadyEventRowV3[] {
  const pending = new Map(rows.map((row) => [row.event.event_id, row]));
  const ordered: ReadyEventRowV3[] = [];
  while (pending.size > 0) {
    const next = rows.find(({ event }) => {
      const causes = (event.links as { caused_by: string[] }).caused_by;
      return pending.has(event.event_id) && causes.every((eventId) => !pending.has(eventId));
    });
    if (!next) throw new Error("ready V3 events contain a causal dependency cycle");
    pending.delete(next.event.event_id);
    ordered.push(next);
  }
  return ordered;
}

/**
 * A `.committed` receipt is created only after the active row is flushed. If
 * the process dies before unlinking it, replaying the exact canonical row is
 * safe: the validating reader deduplicates the event ID and detects conflicts.
 */
function requeueCommittedReceipts(spool: string): void {
  const committedNames = readdirSync(spool)
    .filter((name) => name.endsWith(".committed"))
    .sort();
  for (const committedName of committedNames) {
    const committedPath = join(spool, committedName);
    readAndValidateReadyRow(committedPath);
    const readyPath = `${committedPath.slice(0, -".committed".length)}.ready`;
    if (existsSync(readyPath)) {
      if (readFileSync(readyPath, "utf8") !== readFileSync(committedPath, "utf8")) {
        throw new Error("committed and ready receipts conflict");
      }
      unlinkSync(committedPath);
    } else {
      renameSync(committedPath, readyPath);
    }
    fsyncParentDirectory(readyPath);
  }
}

export function eventV3Paths(coordRoot: string) {
  const root = join(resolve(coordRoot), EVENT_V3_LEDGER_RELATIVE_ROOT);
  return {
    root,
    active: join(root, "active.ndjson"),
    catalog: join(root, "catalog.json"),
    spool: join(root, "spool"),
    diagnostics: join(root, "diagnostics"),
    segments: join(root, "segments"),
    authorityOutbox: join(root, "authority-outbox"),
    lease: join(root, "append-lease"),
  };
}

export function ensureEventV3Layout(coordRoot: string) {
  assertSupportedPath(coordRoot);
  const paths = eventV3Paths(coordRoot);
  for (const path of [
    paths.root,
    paths.spool,
    paths.diagnostics,
    paths.segments,
    paths.authorityOutbox,
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  if (!existsSync(paths.active)) {
    let fd: number | undefined;
    try {
      fd = openSync(paths.active, "wx", 0o600);
      fsyncSync(fd);
      fsyncParentDirectory(paths.active);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const active = lstatSync(paths.active);
  if (!active.isFile() || active.isSymbolicLink() || (active.mode & 0o077) !== 0) {
    throw new Error("active V3 ledger must be an owner-only regular file");
  }
  return paths;
}

function writeReadyRecord(
  spool: string,
  readyPath: string,
  row: string,
  eventId: string,
  onStep?: WriteEventV3Options["onStep"],
): void {
  const temporary = join(spool, `.tmp-${process.pid}-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, row, "utf8");
    fsyncSync(fd);
    onStep?.("ready_temp_flushed", eventId);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, readyPath);
    fsyncParentDirectory(readyPath);
    onStep?.("ready_published", eventId);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readAndValidateReadyRow(path: string): string {
  const size = statSync(path).size;
  if (size <= 1 || size > MAX_LINE_BYTES) throw new Error("ready event has invalid size");
  const row = readFileSync(path, "utf8");
  if (!row.endsWith("\n") || row.slice(0, -1).includes("\n")) {
    throw new Error("ready event is not one complete frame");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row);
  } catch {
    throw new Error("ready event is not valid JSON");
  }
  assertEventV3(parsed);
  if (`${canonicalJsonV3(parsed)}\n` !== row) {
    throw new Error("ready event is not canonically serialized");
  }
  return row;
}

function repairUnterminatedActiveFrame(activePath: string): boolean {
  const size = statSync(activePath).size;
  if (size === 0) return false;
  const tailBytes = Math.min(size, MAX_LINE_BYTES + 1);
  const fd = openSync(activePath, "r");
  const tail = Buffer.allocUnsafe(tailBytes);
  try {
    const bytesRead = readFileTail(fd, tail, size - tailBytes);
    if (bytesRead > 0 && tail[bytesRead - 1] === 0x0a) return false;
    const lastNewline = tail.lastIndexOf(0x0a, bytesRead - 1);
    if (lastNewline < 0 && size > MAX_LINE_BYTES) {
      throw new Error("active V3 tail exceeds the frame limit without a boundary");
    }
    const repairedSize = size - tailBytes + Math.max(0, lastNewline + 1);
    truncateSync(activePath, repairedSize);
  } finally {
    closeSync(fd);
  }
  const repairFd = openSync(activePath, "r+");
  try {
    fsyncSync(repairFd);
  } finally {
    closeSync(repairFd);
  }
  fsyncParentDirectory(activePath);
  return true;
}

function eventIdFromReadyName(name: string): string | undefined {
  const match = name.match(/^\d{16}-(evt_[0-9a-f-]{36})-/);
  return match?.[1];
}

function readFileTail(fd: number, buffer: Buffer, position: number): number {
  let read = 0;
  while (read < buffer.length) {
    const count = requireReadSync(fd, buffer, read, buffer.length - read, position + read);
    if (count === 0) break;
    read += count;
  }
  return read;
}

function requireReadSync(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): number {
  // Kept in one helper so the storage state machine has a single positional-read seam.
  return readSync(fd, buffer, offset, length, position);
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function assertSupportedPath(coordRoot: string): void {
  if (
    /^(\\\\|\/\/wsl(?:\.localhost)?\/)/i.test(coordRoot) ||
    /^\/mnt\/[a-z](?:\/|$)/i.test(coordRoot)
  ) {
    throw new Error("V3 writer refuses direct UNC or cross-boundary coordination roots");
  }
}
