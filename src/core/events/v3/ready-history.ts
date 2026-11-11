import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { processMayBeAlive } from "../../../lib/process-alive.ts";
import { fsyncParentDirectory } from "../../storage/durable-record.ts";
import { stateFileMode } from "../../storage/modes.ts";
import { acquireNoClobberLease } from "../../storage/no-clobber-lease.ts";
import { eventV3ArchivesRoot } from "./archive-retention.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import { verifyRetainedSealedSegmentsV3 } from "./catalog.ts";
import type { EventV3 } from "./contract.ts";
import { type LedgerFrameV3, readLedgerFramesV3 } from "./reader.ts";
import { admitRowsV3, applyRowV3, createRowValidationStateV3 } from "./row-validation.ts";
import { schemaGroupForDigestV3 } from "./schema-lineage.ts";
import { assertEventV3 } from "./validate.ts";

export interface ReadyHistoryImportV3 {
  epoch: string;
  state: "dry_run" | "imported";
  events: Array<{ event_id: string; event_type: string }>;
  already_present: number;
}

interface Plan {
  events: EventV3[];
  rows: string[];
  alreadyPresent: number;
  activeBytes: number;
}

/** Explicit historical migration. It never creates or writes the active epoch. */
export function importArchivedReadyEventsV3(
  coordRoot: string,
  epoch: string,
  options: { yes?: boolean; maxEvents?: number } = {},
): ReadyHistoryImportV3 {
  if (!/^epoch-[0-9]{17}(?:-[0-9]+)?$/.test(epoch)) {
    throw new Error("ready history import requires one exact archived epoch name");
  }
  const root = resolve(coordRoot);
  const archives = eventV3ArchivesRoot(root);
  const dir = join(archives, epoch);
  regularDirectory(archives);
  regularDirectory(dir);
  const run = (): ReadyHistoryImportV3 => {
    const plan = prepareReadyHistoryV3(dir, options.maxEvents ?? 1000, "strict");
    if (options.yes) appendReadyHistoryV3(dir, plan);
    return {
      epoch,
      state: options.yes ? "imported" : "dry_run",
      events: plan.events.map(({ event_id, event_type }) => ({ event_id, event_type })),
      already_present: plan.alreadyPresent,
    };
  };
  if (!options.yes) return run();
  const lease = acquireNoClobberLease({
    path: join(dir, "ready-history-import-lease"),
    scope: "event-v3-ready-history-import",
    authoritySha256: createHash("sha256").update(dir).digest("hex"),
    staleAfterMs: 5000,
    validateStaleOwner: (owner) => owner.host === hostname() && !processMayBeAlive(owner.pid),
  });
  try {
    return run();
  } finally {
    lease.release();
  }
}

/**
 * Carry the queued rows the door would admit into the epoch's own history
 * before it is archived. Caller holds publication and append leases until the
 * directory is archived.
 *
 * Only admissible rows move. A valid row the door declines (it waits for a
 * predecessor, a parent or an attestation that never arrived), a file that can
 * never be appended, and a row of a schema outside the epoch's additive group
 * stay in the archived queue with their bytes intact, so a session whose rows
 * wait never stops the epoch from rotating. Nothing is deleted.
 */
export function carryReadyEventHistoryV3(dir: string): void {
  appendReadyHistoryV3(dir, prepareReadyHistoryV3(dir, Number.MAX_SAFE_INTEGER, "door"));
}

/**
 * `strict` is the explicit recovery import: it refuses the whole import when
 * any queued file is unusable or any row cannot be admitted. `door` is the
 * cutover carry: it admits what the door admits and leaves the rest.
 */
type ReadyHistoryModeV3 = "strict" | "door";

function prepareReadyHistoryV3(dir: string, maxEvents: number, mode: ReadyHistoryModeV3): Plan {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
    throw new Error("max-events must be a positive whole number");
  }
  const spool = join(dir, "spool");
  if (existsSync(spool)) regularDirectory(spool);
  const names = existsSync(spool)
    ? readdirSync(spool)
        .filter((name) => /\.(ready|committed)$/.test(name))
        .sort()
    : [];
  if (names.length > maxEvents)
    throw new Error(`ready history import exceeds max-events=${maxEvents}`);
  if (names.length === 0) return { events: [], rows: [], alreadyPresent: 0, activeBytes: 0 };
  const manifestPath = join(dir, "genesis.json");
  regularFile(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const genesis = manifest.event?.payload?.genesis_id;
  const digest = manifest.profile?.initial_schema_digest;
  if (typeof genesis !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error("ready history import requires an identifiable original epoch");
  }
  // Rows of any digest additive to the epoch's genesis share it, so an epoch
  // holding two digests of one group can rotate. An epoch from before a
  // breaking change is validated against its own group, never the runtime's.
  const accepted = schemaGroupForDigestV3(digest)?.group ?? [digest];
  const candidates = new Map<string, { event: EventV3; row: string }>();
  const conflicted = new Set<string>();
  for (const name of names) {
    const candidate = readCandidate(spool, name, genesis, mode);
    if (!candidate) continue;
    const { event, row } = candidate;
    const prior = candidates.get(event.event_id);
    if (prior && prior.row !== row) {
      if (mode === "strict") throw new Error("conflicting ready history event ID");
      conflicted.add(event.event_id);
    }
    candidates.set(event.event_id, { event, row });
  }
  // Two queued files that disagree about one event ID: neither is carried.
  for (const eventId of conflicted) candidates.delete(eventId);
  const frames: LedgerFrameV3[] = [];
  const committed = new Map<string, string>();
  const segments = join(dir, "segments");
  if (existsSync(segments)) regularDirectory(segments);
  const files = existsSync(segments)
    ? readdirSync(segments)
        .filter((name) => /^\d{12}\.ndjson$/.test(name))
        .sort()
        .map((name) => join(segments, name))
    : [];
  verifyRetainedSealedSegmentsV3({
    catalogPath: join(dir, "catalog.json"),
    segmentsDir: segments,
    segmentFiles: files,
    requireRegularFile: regularFile,
  });
  const active = join(dir, "active.ndjson");
  files.push(active);
  let activeBytes = 0;
  let tail = "";
  for (const [index, file] of files.entries()) {
    regularFile(file);
    const text = readFileSync(file, "utf8");
    const last = text.lastIndexOf("\n") + 1;
    if (file !== active && last !== text.length) throw new Error("incomplete sealed history frame");
    if (file === active) {
      activeBytes = Buffer.byteLength(text.slice(0, last));
      tail = text.slice(last);
    }
    let offset = 0;
    for (const line of text.slice(0, last).split("\n").filter(Boolean)) {
      const event = parseFrame(`${line}\n`);
      const prior = committed.get(event.event_id);
      if (prior && prior !== `${line}\n`) throw new Error("conflicting committed history event ID");
      committed.set(event.event_id, `${line}\n`);
      frames.push({ raw: line, position: { segment_ordinal: index + 1, byte_offset: offset } });
      offset += Buffer.byteLength(line) + 1;
    }
  }
  let alreadyPresent = 0;
  for (const [id, candidate] of candidates) {
    if (!committed.has(id)) continue;
    if (committed.get(id) !== candidate.row && mode === "strict") {
      throw new Error("ready and committed history conflict");
    }
    // An identical row is already present; a different row under a committed
    // ID can never be appended and stays queued.
    if (committed.get(id) === candidate.row) alreadyPresent++;
    candidates.delete(id);
  }
  if (candidates.size === 0) {
    if (tail) throw new Error("incomplete active tail does not match a recoverable ready frame");
    return { events: [], rows: [], alreadyPresent, activeBytes };
  }
  // The committed history must itself read complete before the door can
  // judge anything against it.
  const history = readLedgerFramesV3(frames, { accepted_schema_digests: accepted });
  if (!history.complete || history.genesis_id !== genesis) {
    throw new Error(
      `ready history validation failed: ${history.diagnostics.map(({ code }) => code).join(",")}`,
    );
  }
  const state = createRowValidationStateV3(accepted);
  for (const { raw } of frames) applyRowV3(state, { raw, event: JSON.parse(raw) as EventV3 });
  const admission = admitRowsV3(state, [...candidates.values()], ({ event, row }) => ({
    raw: row.slice(0, -1),
    event,
  }));
  if (mode === "strict" && admission.waiting.length > 0) {
    const codes = [...new Set(admission.waiting.flatMap(({ codes }) => codes))];
    throw new Error(`ready history has rows the door would not admit: ${codes.join(",")}`);
  }
  const ordered = admission.admitted;
  if (tail && !ordered.some(({ row }) => row.startsWith(tail))) {
    throw new Error("incomplete active tail does not match a recoverable ready frame");
  }
  let nextOffset = activeBytes;
  const read = readLedgerFramesV3(
    [
      ...frames,
      ...ordered.map(({ row }) => {
        const frame = {
          raw: row.slice(0, -1),
          position: { segment_ordinal: files.length, byte_offset: nextOffset },
        };
        nextOffset += Buffer.byteLength(row);
        return frame;
      }),
    ],
    { accepted_schema_digests: accepted },
  );
  if (!read.complete || read.genesis_id !== genesis) {
    throw new Error(
      `ready history validation failed: ${read.diagnostics.map(({ code }) => code).join(",")}`,
    );
  }
  return {
    events: ordered.map(({ event }) => event),
    rows: ordered.map(({ row }) => row),
    alreadyPresent,
    activeBytes,
  };
}

function appendReadyHistoryV3(dir: string, plan: Plan): void {
  if (plan.rows.length === 0) return;
  const active = join(dir, "active.ndjson");
  // Retry repairs only a partial frame proven to be a prefix of a durable row.
  truncateSync(active, plan.activeBytes);
  const fd = openSync(active, "a", stateFileMode());
  try {
    for (const row of plan.rows) {
      const bytes = Buffer.from(row);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncParentDirectory(active);
}

/**
 * Read one queued file of the archived epoch. In strict mode any defect
 * refuses the import. In door mode a file that is not a regular file, is too
 * large, does not parse as a canonical event, carries a digest outside the
 * lineage, or does not match its name or epoch fence is left where it is.
 */
function readCandidate(
  spool: string,
  name: string,
  genesis: string,
  mode: ReadyHistoryModeV3,
): { event: EventV3; row: string } | undefined {
  const path = join(spool, name);
  try {
    regularFile(path);
    const row = readFileSync(path, "utf8");
    if (Buffer.byteLength(row) > 16 * 1024)
      throw new Error("ready history frame exceeds row limit");
    if (mode === "door") {
      const stamped = (JSON.parse(row) as { contract?: { schema_digest?: unknown } } | null)
        ?.contract?.schema_digest;
      if (typeof stamped !== "string" || schemaGroupForDigestV3(stamped) === undefined) {
        return undefined;
      }
    }
    const event = parseFrame(row);
    const tag = name.match(/-(gex_[a-f0-9-]+)\.(ready|committed)$/)?.[1];
    const prefix = `${String(event.producer.sequence).padStart(16, "0")}-${event.event_id}-${sha256V3(row).slice(7)}`;
    if (
      (tag && tag !== genesis) ||
      name !== `${prefix}${tag ? `-${tag}` : ""}.${name.endsWith(".ready") ? "ready" : "committed"}`
    ) {
      throw new Error("ready history filename, digest, or epoch fence mismatch");
    }
    return { event, row };
  } catch (error) {
    if (mode === "strict") throw error;
    return undefined;
  }
}

function parseFrame(row: string): EventV3 {
  const event: unknown = JSON.parse(row);
  assertEventV3(event);
  if (`${canonicalJsonV3(event)}\n` !== row)
    throw new Error("noncanonical or incomplete history frame");
  return event;
}
function regularFile(path: string): void {
  if (!lstatSync(path).isFile())
    throw new Error("ready history requires regular files without symlinks");
}
function regularDirectory(path: string): void {
  if (!lstatSync(path).isDirectory())
    throw new Error("ready history requires directories without symlinks");
}
