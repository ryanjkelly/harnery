import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { fsyncParentDirectory } from "../../workflow/durable-record.ts";
import { canonicalJsonV2, sha256V2 } from "./canonical.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "./generated.ts";
import { assertEventV2 } from "./validate.ts";
import {
  drainReadyEventsUnderLeaseV2,
  ensureEventV2Layout,
  eventV2Paths,
  type WriteEventV2Options,
  withEventV2LedgerLease,
} from "./writer.ts";

const SEGMENT_PATTERN = /^(\d{12})\.ndjson$/;

export interface EventV2SegmentManifest {
  format: "harnery-event-v2-segment";
  format_version: 1;
  ordinal: number;
  segment_file: string;
  bytes: number;
  row_count: number;
  segment_digest: `sha256:${string}`;
  schema_digests: string[];
  first_event_id: string;
  last_event_id: string;
  sealed_at: string;
}

export interface EventV2CatalogSegment {
  ordinal: number;
  segment_file: string;
  manifest_file: string;
  segment_digest: `sha256:${string}`;
  manifest_digest: `sha256:${string}`;
  bytes: number;
  row_count: number;
}

export interface EventV2Catalog {
  format: "harnery-event-v2-catalog";
  format_version: 1;
  segments: EventV2CatalogSegment[];
  active: {
    ordinal: number;
    device: string;
    inode: string;
    birthtime_ns: string;
  };
}

export interface RotateEventLedgerV2Result {
  rotated: boolean;
  drained: number;
  catalog: EventV2Catalog;
  manifest?: EventV2SegmentManifest;
}

/** Seal a non-empty active segment while holding the same fenced lease used by WAL drain. */
export function rotateEventLedgerV2(
  coordRoot: string,
  options: WriteEventV2Options = {},
): RotateEventLedgerV2Result {
  const paths = ensureEventV2Layout(coordRoot);
  return withEventV2LedgerLease(coordRoot, options, () => {
    recoverCatalogUnderLease(paths);
    const drained = drainReadyEventsUnderLeaseV2(paths, options);
    const activeBytes = readFileSync(paths.active);
    if (activeBytes.length === 0) {
      return { rotated: false, drained, catalog: recoverCatalogUnderLease(paths) };
    }
    const existingOrdinals = segmentOrdinals(paths.segments);
    const ordinal = (existingOrdinals.at(-1) ?? 0) + 1;
    const segmentFile = segmentFileName(ordinal);
    const segmentPath = join(paths.segments, segmentFile);
    if (existsSync(segmentPath)) throw new Error("V2 segment target already exists");

    const activeFd = openSync(paths.active, "r+");
    try {
      fsyncSync(activeFd);
    } finally {
      closeSync(activeFd);
    }
    renameSync(paths.active, segmentPath);
    fsyncParentDirectory(segmentPath);
    createEmptyActive(paths.active);

    const manifest = ensureSegmentManifest(paths.segments, ordinal);
    const catalog = recoverCatalogUnderLease(paths);
    return { rotated: true, drained, catalog, manifest };
  });
}

/** Reconcile orphan sealed segments and atomically rebuild the disposable catalog. */
export function recoverEventV2Catalog(
  coordRoot: string,
  options: WriteEventV2Options = {},
): EventV2Catalog {
  const paths = ensureEventV2Layout(coordRoot);
  return withEventV2LedgerLease(coordRoot, options, () => recoverCatalogUnderLease(paths));
}

export function readEventV2Catalog(coordRoot: string): EventV2Catalog {
  const path = eventV2Paths(coordRoot).catalog;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("V2 catalog is missing or malformed");
  }
  return validateCatalog(parsed);
}

export function readEventV2SegmentManifest(path: string): EventV2SegmentManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("V2 segment manifest is malformed");
  }
  return validateManifest(parsed);
}

function recoverCatalogUnderLease(paths: ReturnType<typeof eventV2Paths>): EventV2Catalog {
  const segments = segmentOrdinals(paths.segments).map((ordinal) => {
    const manifest = ensureSegmentManifest(paths.segments, ordinal);
    const manifestFile = manifestFileName(ordinal);
    const manifestBytes = readFileSync(join(paths.segments, manifestFile), "utf8");
    return {
      ordinal,
      segment_file: manifest.segment_file,
      manifest_file: manifestFile,
      segment_digest: manifest.segment_digest,
      manifest_digest: sha256V2(manifestBytes),
      bytes: manifest.bytes,
      row_count: manifest.row_count,
    } satisfies EventV2CatalogSegment;
  });
  const activeStat = statSync(paths.active);
  const activeBigIntStat = statSync(paths.active, { bigint: true });
  const catalog: EventV2Catalog = {
    format: "harnery-event-v2-catalog",
    format_version: 1,
    segments,
    active: {
      ordinal: (segments.at(-1)?.ordinal ?? 0) + 1,
      device: String(activeStat.dev),
      inode: String(activeStat.ino),
      birthtime_ns: String(activeBigIntStat.birthtimeNs),
    },
  };
  publishCanonicalJson(paths.catalog, catalog);
  return catalog;
}

function ensureSegmentManifest(segmentsDir: string, ordinal: number): EventV2SegmentManifest {
  const segmentFile = segmentFileName(ordinal);
  const segmentPath = join(segmentsDir, segmentFile);
  const manifestPath = join(segmentsDir, manifestFileName(ordinal));
  const facts = segmentFacts(segmentPath, ordinal);
  if (existsSync(manifestPath)) {
    const manifestBytes = readFileSync(manifestPath, "utf8");
    const manifest = readEventV2SegmentManifest(manifestPath);
    if (`${canonicalJsonV2(manifest)}\n` !== manifestBytes) {
      throw new Error("V2 segment manifest is not canonical");
    }
    if (canonicalJsonV2(manifest) !== canonicalJsonV2(facts)) {
      throw new Error("V2 segment manifest does not match sealed bytes");
    }
    return manifest;
  }
  publishCanonicalJson(manifestPath, facts, false);
  return facts;
}

function segmentFacts(path: string, ordinal: number): EventV2SegmentManifest {
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("sealed V2 segment has an unterminated frame");
  const frames = text.slice(0, -1).split("\n");
  if (frames.length === 0 || frames.some((frame) => frame.length === 0)) {
    throw new Error("sealed V2 segment contains an empty frame");
  }
  const events = frames.map((frame) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      throw new Error("sealed V2 segment contains malformed JSON");
    }
    assertEventV2(parsed);
    if (canonicalJsonV2(parsed) !== frame) {
      throw new Error("sealed V2 segment contains a noncanonical frame");
    }
    return parsed;
  });
  const schemaDigests = [
    ...new Set(events.map((event) => event.contract.schema_digest as string)),
  ].sort();
  if (schemaDigests.some((digest) => digest !== EVENT_V2_SCHEMA_DIGEST)) {
    throw new Error("sealed V2 segment uses an unsupported schema digest");
  }
  return {
    format: "harnery-event-v2-segment",
    format_version: 1,
    ordinal,
    segment_file: basename(path),
    bytes: bytes.length,
    row_count: events.length,
    segment_digest: sha256V2(bytes),
    schema_digests: schemaDigests,
    first_event_id: events[0]?.event_id ?? "",
    last_event_id: events.at(-1)?.event_id ?? "",
    sealed_at: new Date(statSync(path).mtimeMs).toISOString(),
  };
}

function publishCanonicalJson(path: string, value: unknown, replace = true): void {
  if (!replace && existsSync(path)) throw new Error("V2 metadata target already exists");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${canonicalJsonV2(value)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (!replace && existsSync(path)) throw new Error("V2 metadata target already exists");
    renameSync(temporary, path);
    fsyncParentDirectory(path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function createEmptyActive(path: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncParentDirectory(path);
}

function segmentOrdinals(segmentsDir: string): number[] {
  return readdirSync(segmentsDir)
    .map((name) => name.match(SEGMENT_PATTERN)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((left, right) => left - right);
}

function segmentFileName(ordinal: number): string {
  return `${String(ordinal).padStart(12, "0")}.ndjson`;
}

function manifestFileName(ordinal: number): string {
  return `${String(ordinal).padStart(12, "0")}.manifest.json`;
}

function validateCatalog(value: unknown): EventV2Catalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("V2 catalog envelope is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.format !== "harnery-event-v2-catalog" || record.format_version !== 1) {
    throw new Error("V2 catalog format is unsupported");
  }
  if (Object.keys(record).sort().join("\0") !== "active\0format\0format_version\0segments") {
    throw new Error("V2 catalog has unsupported fields");
  }
  if (!Array.isArray(record.segments)) throw new Error("V2 catalog segments are invalid");
  const segments = record.segments.map((segment) => validateCatalogSegment(segment));
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index]?.ordinal !== index + 1) {
      throw new Error("V2 catalog segment ordinals are not contiguous");
    }
  }
  const active = record.active as Record<string, unknown> | undefined;
  if (
    !active ||
    Object.keys(active).sort().join("\0") !== "birthtime_ns\0device\0inode\0ordinal" ||
    active.ordinal !== segments.length + 1 ||
    typeof active.device !== "string" ||
    typeof active.inode !== "string" ||
    typeof active.birthtime_ns !== "string"
  ) {
    throw new Error("V2 catalog active identity is invalid");
  }
  return record as unknown as EventV2Catalog;
}

function validateCatalogSegment(value: unknown): EventV2CatalogSegment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("V2 catalog segment is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !==
    "bytes\0manifest_digest\0manifest_file\0ordinal\0row_count\0segment_digest\0segment_file"
  ) {
    throw new Error("V2 catalog segment has unsupported fields");
  }
  if (
    !Number.isSafeInteger(record.ordinal) ||
    (record.ordinal as number) < 1 ||
    !Number.isSafeInteger(record.bytes) ||
    !Number.isSafeInteger(record.row_count) ||
    typeof record.segment_file !== "string" ||
    typeof record.manifest_file !== "string" ||
    typeof record.segment_digest !== "string" ||
    typeof record.manifest_digest !== "string"
  ) {
    throw new Error("V2 catalog segment values are invalid");
  }
  return record as unknown as EventV2CatalogSegment;
}

function validateManifest(value: unknown): EventV2SegmentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("V2 segment manifest envelope is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.format !== "harnery-event-v2-segment" || record.format_version !== 1) {
    throw new Error("V2 segment manifest format is unsupported");
  }
  if (
    Object.keys(record).sort().join("\0") !==
    "bytes\0first_event_id\0format\0format_version\0last_event_id\0ordinal\0row_count\0schema_digests\0sealed_at\0segment_digest\0segment_file"
  ) {
    throw new Error("V2 segment manifest has unsupported fields");
  }
  if (
    !Number.isSafeInteger(record.ordinal) ||
    (record.ordinal as number) < 1 ||
    !Number.isSafeInteger(record.bytes) ||
    !Number.isSafeInteger(record.row_count) ||
    typeof record.segment_file !== "string" ||
    typeof record.segment_digest !== "string" ||
    typeof record.first_event_id !== "string" ||
    typeof record.last_event_id !== "string" ||
    typeof record.sealed_at !== "string" ||
    !Array.isArray(record.schema_digests)
  ) {
    throw new Error("V2 segment manifest values are invalid");
  }
  return record as unknown as EventV2SegmentManifest;
}
