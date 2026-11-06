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
import { stateFileMode } from "../../storage/modes.ts";
import { fsyncParentDirectory } from "../../workflow/durable-record.ts";
import { acquireNoClobberLease } from "../../workflow/workspaces/leases.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import { readEventV3Catalog, readEventV3SegmentManifest } from "./catalog.ts";
import type { EventV3 } from "./contract.ts";
import { type LedgerFrameV3, readLedgerFramesV3 } from "./reader.ts";
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
  const dir = join(root, ".harnery", "ledgers", "v3-archives", epoch);
  regularDirectory(join(root, ".harnery", "ledgers", "v3-archives"));
  regularDirectory(dir);
  const run = (): ReadyHistoryImportV3 => {
    const plan = prepareReadyHistoryV3(dir, options.maxEvents ?? 1000);
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
    validateStaleOwner: (owner) => owner.host === hostname() && pidIsGone(owner.pid),
  });
  try {
    return run();
  } finally {
    lease.release();
  }
}

/** Caller holds publication and append leases until the directory is archived. */
export function carryReadyEventHistoryV3(dir: string): void {
  appendReadyHistoryV3(dir, prepareReadyHistoryV3(dir, Number.MAX_SAFE_INTEGER));
}

function prepareReadyHistoryV3(dir: string, maxEvents: number): Plan {
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
  const candidates = new Map<string, { event: EventV3; row: string }>();
  for (const name of names) {
    const path = join(spool, name);
    regularFile(path);
    const row = readFileSync(path, "utf8");
    if (Buffer.byteLength(row) > 16 * 1024)
      throw new Error("ready history frame exceeds row limit");
    const event = parseFrame(row);
    const tag = name.match(/-(gex_[a-f0-9-]+)\.(ready|committed)$/)?.[1];
    const prefix = `${String(event.producer.sequence).padStart(16, "0")}-${event.event_id}-${sha256V3(row).slice(7)}`;
    if (
      (tag && tag !== genesis) ||
      name !== `${prefix}${tag ? `-${tag}` : ""}.${name.endsWith(".ready") ? "ready" : "committed"}`
    ) {
      throw new Error("ready history filename, digest, or epoch fence mismatch");
    }
    const prior = candidates.get(event.event_id);
    if (prior && prior.row !== row) throw new Error("conflicting ready history event ID");
    candidates.set(event.event_id, { event, row });
  }
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
  const catalogPath = join(dir, "catalog.json");
  if (existsSync(catalogPath)) {
    regularFile(catalogPath);
    const catalog = readEventV3Catalog(catalogPath);
    if (
      catalog.segments.map(({ segment_file }) => join(segments, segment_file)).join("\0") !==
      files.join("\0")
    ) {
      throw new Error("ready history segment catalog does not match retained files");
    }
    for (const entry of catalog.segments) {
      const path = join(segments, entry.segment_file);
      const manifestPath = join(segments, entry.manifest_file);
      regularFile(path);
      regularFile(manifestPath);
      const manifest = readEventV3SegmentManifest(manifestPath);
      if (
        sha256V3(readFileSync(path)) !== entry.segment_digest ||
        sha256V3(readFileSync(manifestPath)) !== entry.manifest_digest ||
        manifest.segment_digest !== entry.segment_digest
      ) {
        throw new Error("ready history sealed segment integrity failure");
      }
    }
  } else if (files.length) {
    throw new Error("ready history sealed segments require their catalog");
  }
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
    if (committed.get(id) !== candidate.row)
      throw new Error("ready and committed history conflict");
    candidates.delete(id);
    alreadyPresent++;
  }
  const ordered: Array<{ event: EventV3; row: string }> = [];
  const attestations = new Set(
    frames
      .map(({ raw }) => JSON.parse(raw) as EventV3)
      .filter(
        (event) =>
          event.event_type === "session.started" ||
          event.event_type === "session.attestation_changed",
      )
      .map((event) => event.attestation_id),
  );
  while (candidates.size) {
    const next = [...candidates.values()].find(
      ({ event }) =>
        (event.links as { caused_by: string[] }).caused_by.every((id) => committed.has(id)) &&
        (event.event_type === "session.started" ||
          !event.attestation_id ||
          attestations.has(
            event.event_type === "session.attestation_changed"
              ? event.payload.prior_attestation_id
              : event.attestation_id,
          )) &&
        ![...candidates.values()].some(
          ({ event: other }) =>
            other.producer.producer_id === event.producer.producer_id &&
            other.producer.boot_id === event.producer.boot_id &&
            other.producer.sequence < event.producer.sequence,
        ),
    );
    if (!next) throw new Error("ready history has missing or cyclic causal dependencies");
    candidates.delete(next.event.event_id);
    committed.set(next.event.event_id, next.row);
    if (
      next.event.event_type === "session.started" ||
      next.event.event_type === "session.attestation_changed"
    ) {
      attestations.add(next.event.attestation_id);
    }
    ordered.push(next);
  }
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
    { accepted_schema_digests: [digest] },
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
function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
