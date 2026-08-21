import { readFileSync } from "node:fs";
import { canonicalJsonV3 } from "./canonical.ts";

export interface EventV3SegmentManifest {
  format: "harnery-event-v3-segment";
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

export interface EventV3CatalogSegment {
  ordinal: number;
  segment_file: string;
  manifest_file: string;
  segment_digest: `sha256:${string}`;
  manifest_digest: `sha256:${string}`;
  bytes: number;
  row_count: number;
}

export interface EventV3Catalog {
  format: "harnery-event-v3-catalog";
  format_version: 1;
  segments: EventV3CatalogSegment[];
  active: {
    ordinal: number;
    device: string;
    inode: string;
    birthtime_ns: string;
  };
}

export function readEventV3Catalog(path: string): EventV3Catalog {
  return validateCanonicalMetadata(path, validateCatalog, "V3 catalog");
}

export function readEventV3SegmentManifest(path: string): EventV3SegmentManifest {
  return validateCanonicalMetadata(path, validateManifest, "V3 segment manifest");
}

function validateCanonicalMetadata<T>(
  path: string,
  validate: (value: unknown) => T,
  label: string,
): T {
  let text: string;
  let parsed: unknown;
  try {
    text = readFileSync(path, "utf8");
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} is missing or malformed`);
  }
  const value = validate(parsed);
  if (text !== `${canonicalJsonV3(value)}\n`) throw new Error(`${label} is not canonical`);
  return value;
}

function validateCatalog(value: unknown): EventV3Catalog {
  const record = object(value, "V3 catalog envelope is invalid");
  if (record.format !== "harnery-event-v3-catalog" || record.format_version !== 1) {
    throw new Error("V3 catalog format is unsupported");
  }
  exactKeys(record, ["active", "format", "format_version", "segments"], "V3 catalog");
  if (!Array.isArray(record.segments)) throw new Error("V3 catalog segments are invalid");
  const segments = record.segments.map((segment, index) =>
    validateCatalogSegment(segment, index + 1),
  );
  const active = object(record.active, "V3 catalog active identity is invalid");
  exactKeys(active, ["birthtime_ns", "device", "inode", "ordinal"], "V3 catalog active");
  if (
    active.ordinal !== segments.length + 1 ||
    typeof active.device !== "string" ||
    typeof active.inode !== "string" ||
    typeof active.birthtime_ns !== "string"
  ) {
    throw new Error("V3 catalog active identity is invalid");
  }
  return {
    format: "harnery-event-v3-catalog",
    format_version: 1,
    segments,
    active: active as unknown as EventV3Catalog["active"],
  };
}

function validateCatalogSegment(value: unknown, expectedOrdinal: number): EventV3CatalogSegment {
  const record = object(value, "V3 catalog segment is invalid");
  exactKeys(
    record,
    [
      "bytes",
      "manifest_digest",
      "manifest_file",
      "ordinal",
      "row_count",
      "segment_digest",
      "segment_file",
    ],
    "V3 catalog segment",
  );
  if (
    record.ordinal !== expectedOrdinal ||
    !nonnegativeInteger(record.bytes) ||
    !nonnegativeInteger(record.row_count) ||
    record.segment_file !== segmentFileName(expectedOrdinal) ||
    record.manifest_file !== manifestFileName(expectedOrdinal) ||
    !sha256(record.segment_digest) ||
    !sha256(record.manifest_digest)
  ) {
    throw new Error("V3 catalog segment values are invalid");
  }
  return record as unknown as EventV3CatalogSegment;
}

function validateManifest(value: unknown): EventV3SegmentManifest {
  const record = object(value, "V3 segment manifest envelope is invalid");
  if (record.format !== "harnery-event-v3-segment" || record.format_version !== 1) {
    throw new Error("V3 segment manifest format is unsupported");
  }
  exactKeys(
    record,
    [
      "bytes",
      "first_event_id",
      "format",
      "format_version",
      "last_event_id",
      "ordinal",
      "row_count",
      "schema_digests",
      "sealed_at",
      "segment_digest",
      "segment_file",
    ],
    "V3 segment manifest",
  );
  if (
    !positiveInteger(record.ordinal) ||
    !nonnegativeInteger(record.bytes) ||
    !positiveInteger(record.row_count) ||
    record.segment_file !== segmentFileName(record.ordinal as number) ||
    !sha256(record.segment_digest) ||
    typeof record.first_event_id !== "string" ||
    typeof record.last_event_id !== "string" ||
    typeof record.sealed_at !== "string" ||
    !Array.isArray(record.schema_digests) ||
    record.schema_digests.length === 0 ||
    record.schema_digests.some((digest) => !sha256(digest)) ||
    [...record.schema_digests].sort().join("\0") !== record.schema_digests.join("\0") ||
    new Set(record.schema_digests).size !== record.schema_digests.length
  ) {
    throw new Error("V3 segment manifest values are invalid");
  }
  return record as unknown as EventV3SegmentManifest;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: string[], label: string): void {
  if (Object.keys(record).sort().join("\0") !== expected.join("\0")) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

export function segmentFileNameV3(ordinal: number): string {
  return segmentFileName(ordinal);
}

export function manifestFileNameV3(ordinal: number): string {
  return manifestFileName(ordinal);
}

function segmentFileName(ordinal: number): string {
  return `${String(ordinal).padStart(12, "0")}.ndjson`;
}

function manifestFileName(ordinal: number): string {
  return `${String(ordinal).padStart(12, "0")}.manifest.json`;
}
