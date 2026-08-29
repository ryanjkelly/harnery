import { createHash } from "node:crypto";
import { posix } from "node:path";
import { canonicalJsonV3 } from "../canonical.ts";

export const EVENT_V3_SUPPORT_PACK_FORMAT = "harnery-event-v3-support-pack" as const;
export const EVENT_V3_SUPPORT_PACK_VERSION = 1 as const;

export const EVENT_V3_SUPPORT_FAMILIES = [
  "diagnostic",
  "session-tee",
  "authority-ready",
  "authority-committed",
  "authority-residue",
] as const;

export type EventV3SupportFamily = (typeof EVENT_V3_SUPPORT_FAMILIES)[number];
export type EventV3SupportVerificationMode = "archive-logical-authority" | "active-frozen-files";

export interface EventV3SupportPackRecord {
  path: string;
  bytes: number;
  digest: `sha256:${string}`;
  content_base64: string;
}

export interface EventV3SupportPackManifest {
  format: typeof EVENT_V3_SUPPORT_PACK_FORMAT;
  format_version: typeof EVENT_V3_SUPPORT_PACK_VERSION;
  pack_id: `vsp_${string}`;
  authority: {
    root_id: string;
    genesis_id: string;
    verification_mode: EventV3SupportVerificationMode;
    source_authority_digest?: `sha256:${string}`;
    source_files_digest: `sha256:${string}`;
  };
  scope: {
    families: EventV3SupportFamily[];
    minimum_recorded_at: string | null;
    maximum_recorded_at: string | null;
  };
  entries: {
    count: number;
    uncompressed_bytes: number;
    logical_entries_digest: `sha256:${string}`;
    by_family: Record<EventV3SupportFamily, number>;
    by_diagnostic_category: Record<string, number>;
    by_diagnostic_reason: Record<string, number>;
  };
  payload: {
    algorithm: "gzip";
    path: string;
    bytes: number;
    digest: `sha256:${string}`;
  };
  minimum_harnery_version: string;
  created_at: string;
}

export interface EventV3LogicalAuthorityEntry {
  path: string;
  bytes: number;
  digest: `sha256:${string}`;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PACK_ID = /^vsp_[0-9a-f]{32}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function normalizeEventV3SupportPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error("event_v3_support_path_is_unsafe");
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || value === "." || value.split("/").includes("..")) {
    throw new Error("event_v3_support_path_is_noncanonical");
  }
  if (value === "support-packs" || value.startsWith("support-packs/")) {
    throw new Error("event_v3_support_path_uses_reserved_subtree");
  }
  return value;
}

export function logicalEntriesDigestV3(
  entries: readonly EventV3LogicalAuthorityEntry[],
): `sha256:${string}` {
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  return `sha256:${createHash("sha256").update(canonicalJsonV3(sorted)).digest("hex")}`;
}

export function validateEventV3SupportPackRecord(value: unknown): EventV3SupportPackRecord {
  const record = object(value, "event_v3_support_record_invalid");
  exactKeys(record, ["path", "bytes", "digest", "content_base64"]);
  const path = normalizeEventV3SupportPath(string(record.path));
  const bytes = nonnegativeInteger(record.bytes);
  const digest = sha256(record.digest);
  const content = string(record.content_base64);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
    throw new Error("event_v3_support_record_base64_invalid");
  }
  return { path, bytes, digest, content_base64: content };
}

export function validateEventV3SupportPackManifest(value: unknown): EventV3SupportPackManifest {
  const manifest = object(value, "event_v3_support_manifest_invalid");
  exactKeys(manifest, [
    "format",
    "format_version",
    "pack_id",
    "authority",
    "scope",
    "entries",
    "payload",
    "minimum_harnery_version",
    "created_at",
  ]);
  if (manifest.format !== EVENT_V3_SUPPORT_PACK_FORMAT || manifest.format_version !== 1) {
    throw new Error("event_v3_support_manifest_version_unsupported");
  }
  const packId = string(manifest.pack_id);
  if (!PACK_ID.test(packId)) throw new Error("event_v3_support_pack_id_invalid");

  const authority = object(manifest.authority, "event_v3_support_authority_invalid");
  const authorityKeys = ["root_id", "genesis_id", "verification_mode", "source_files_digest"];
  if (authority.source_authority_digest !== undefined)
    authorityKeys.push("source_authority_digest");
  exactKeys(authority, authorityKeys);
  const verificationMode = string(authority.verification_mode);
  if (
    verificationMode !== "archive-logical-authority" &&
    verificationMode !== "active-frozen-files"
  ) {
    throw new Error("event_v3_support_verification_mode_invalid");
  }
  const sourceAuthorityDigest = optionalSha256(authority.source_authority_digest);
  if (verificationMode === "archive-logical-authority" && !sourceAuthorityDigest) {
    throw new Error("event_v3_support_archive_digest_required");
  }
  if (verificationMode === "active-frozen-files" && sourceAuthorityDigest) {
    throw new Error("event_v3_support_active_authority_digest_forbidden");
  }

  const scope = object(manifest.scope, "event_v3_support_scope_invalid");
  exactKeys(scope, ["families", "minimum_recorded_at", "maximum_recorded_at"]);
  if (!Array.isArray(scope.families) || scope.families.length === 0) {
    throw new Error("event_v3_support_scope_families_invalid");
  }
  const families = [...new Set(scope.families.map(family))].sort();
  if (families.length !== scope.families.length) {
    throw new Error("event_v3_support_scope_family_duplicate");
  }
  const minimumRecordedAt = nullableTimestamp(scope.minimum_recorded_at);
  const maximumRecordedAt = nullableTimestamp(scope.maximum_recorded_at);
  if ((minimumRecordedAt === null) !== (maximumRecordedAt === null)) {
    throw new Error("event_v3_support_scope_time_range_incomplete");
  }
  if (minimumRecordedAt && maximumRecordedAt && minimumRecordedAt > maximumRecordedAt) {
    throw new Error("event_v3_support_scope_time_range_invalid");
  }

  const entries = object(manifest.entries, "event_v3_support_entries_invalid");
  exactKeys(entries, [
    "count",
    "uncompressed_bytes",
    "logical_entries_digest",
    "by_family",
    "by_diagnostic_category",
    "by_diagnostic_reason",
  ]);
  const count = nonnegativeInteger(entries.count);
  if (count === 0) throw new Error("event_v3_support_pack_empty");
  const byFamily = familyRollup(entries.by_family);
  if (Object.values(byFamily).reduce((sum, current) => sum + current, 0) !== count) {
    throw new Error("event_v3_support_family_rollup_mismatch");
  }
  for (const key of EVENT_V3_SUPPORT_FAMILIES) {
    if (byFamily[key] > 0 && !families.includes(key)) {
      throw new Error("event_v3_support_scope_rollup_mismatch");
    }
  }

  const payload = object(manifest.payload, "event_v3_support_payload_invalid");
  exactKeys(payload, ["algorithm", "path", "bytes", "digest"]);
  if (payload.algorithm !== "gzip") throw new Error("event_v3_support_algorithm_unsupported");
  const payloadPath = string(payload.path);
  if (payloadPath !== `${packId}.ndjson.gz`) {
    throw new Error("event_v3_support_payload_path_mismatch");
  }
  const minimumVersion = string(manifest.minimum_harnery_version);
  if (!VERSION.test(minimumVersion)) throw new Error("event_v3_support_minimum_version_invalid");

  return {
    format: EVENT_V3_SUPPORT_PACK_FORMAT,
    format_version: 1,
    pack_id: packId as `vsp_${string}`,
    authority: {
      root_id: nonemptyString(authority.root_id),
      genesis_id: nonemptyString(authority.genesis_id),
      verification_mode: verificationMode,
      ...(sourceAuthorityDigest ? { source_authority_digest: sourceAuthorityDigest } : {}),
      source_files_digest: sha256(authority.source_files_digest),
    },
    scope: {
      families,
      minimum_recorded_at: minimumRecordedAt,
      maximum_recorded_at: maximumRecordedAt,
    },
    entries: {
      count,
      uncompressed_bytes: nonnegativeInteger(entries.uncompressed_bytes),
      logical_entries_digest: sha256(entries.logical_entries_digest),
      by_family: byFamily,
      by_diagnostic_category: stringRollup(entries.by_diagnostic_category),
      by_diagnostic_reason: stringRollup(entries.by_diagnostic_reason),
    },
    payload: {
      algorithm: "gzip",
      path: payloadPath,
      bytes: nonnegativeInteger(payload.bytes),
      digest: sha256(payload.digest),
    },
    minimum_harnery_version: minimumVersion,
    created_at: timestamp(manifest.created_at),
  };
}

export function assertEventV3SupportPackAuthority(
  manifest: EventV3SupportPackManifest,
  expected: {
    root_id: string;
    genesis_id: string;
    verification_mode?: EventV3SupportVerificationMode;
  },
): void {
  if (manifest.authority.root_id !== expected.root_id) {
    throw new Error("event_v3_support_pack_wrong_root_authority");
  }
  if (manifest.authority.genesis_id !== expected.genesis_id) {
    throw new Error("event_v3_support_pack_wrong_genesis_authority");
  }
  if (
    expected.verification_mode !== undefined &&
    manifest.authority.verification_mode !== expected.verification_mode
  ) {
    throw new Error("event_v3_support_pack_wrong_verification_mode");
  }
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new Error("event_v3_support_schema_unknown_field");
  }
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("event_v3_support_string_invalid");
  return value;
}

function nonemptyString(value: unknown): string {
  const result = string(value);
  if (result.length === 0 || result.length > 256) throw new Error("event_v3_support_id_invalid");
  return result;
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("event_v3_support_integer_invalid");
  }
  return value as number;
}

function sha256(value: unknown): `sha256:${string}` {
  const result = string(value);
  if (!DIGEST.test(result)) throw new Error("event_v3_support_digest_invalid");
  return result as `sha256:${string}`;
}

function optionalSha256(value: unknown): `sha256:${string}` | undefined {
  return value === undefined ? undefined : sha256(value);
}

function family(value: unknown): EventV3SupportFamily {
  const result = string(value);
  if (!(EVENT_V3_SUPPORT_FAMILIES as readonly string[]).includes(result)) {
    throw new Error("event_v3_support_family_unknown");
  }
  return result as EventV3SupportFamily;
}

function timestamp(value: unknown): string {
  const result = string(value);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  ) {
    throw new Error("event_v3_support_timestamp_invalid");
  }
  return result;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function familyRollup(value: unknown): Record<EventV3SupportFamily, number> {
  const rollup = object(value, "event_v3_support_family_rollup_invalid");
  exactKeys(rollup, [...EVENT_V3_SUPPORT_FAMILIES]);
  return Object.fromEntries(
    EVENT_V3_SUPPORT_FAMILIES.map((key) => [key, nonnegativeInteger(rollup[key])]),
  ) as Record<EventV3SupportFamily, number>;
}

function stringRollup(value: unknown): Record<string, number> {
  const rollup = object(value, "event_v3_support_rollup_invalid");
  const result: Record<string, number> = {};
  for (const [key, current] of Object.entries(rollup).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(key)) {
      throw new Error("event_v3_support_rollup_key_invalid");
    }
    result[key] = nonnegativeInteger(current);
  }
  return result;
}
