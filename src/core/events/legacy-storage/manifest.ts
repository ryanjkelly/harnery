export interface LegacyV1SegmentManifest {
  format: "harnery-legacy-v1-segment";
  format_version: 1;
  segment_id: `v1s_${string}`;
  source: {
    filename: string;
    bytes: number;
    digest: `sha256:${string}`;
    row_count: number;
    minimum_recorded_at: string | null;
    maximum_recorded_at: string | null;
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

export function validateLegacyV1SegmentManifest(value: unknown): LegacyV1SegmentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("legacy_v1_manifest_invalid");
  }
  const manifest = value as Record<string, unknown>;
  exact(manifest, [
    "format",
    "format_version",
    "segment_id",
    "source",
    "payload",
    "minimum_harnery_version",
    "created_at",
  ]);
  if (manifest.format !== "harnery-legacy-v1-segment" || manifest.format_version !== 1) {
    throw new Error("legacy_v1_manifest_version_unsupported");
  }
  const segmentId = text(manifest.segment_id);
  if (!/^v1s_[0-9a-f]{32}$/.test(segmentId)) throw new Error("legacy_v1_segment_id_invalid");
  const source = object(manifest.source);
  exact(source, [
    "filename",
    "bytes",
    "digest",
    "row_count",
    "minimum_recorded_at",
    "maximum_recorded_at",
  ]);
  const filename = text(source.filename);
  if (!/^events.+\.ndjson$/.test(filename) || filename.includes("/") || filename.includes("\\")) {
    throw new Error("legacy_v1_source_filename_invalid");
  }
  const minimum = nullableTimestamp(source.minimum_recorded_at);
  const maximum = nullableTimestamp(source.maximum_recorded_at);
  if ((minimum === null) !== (maximum === null) || (minimum && maximum && minimum > maximum)) {
    throw new Error("legacy_v1_manifest_time_range_invalid");
  }
  const payload = object(manifest.payload);
  exact(payload, ["algorithm", "path", "bytes", "digest"]);
  if (payload.algorithm !== "gzip" || payload.path !== `${segmentId}.ndjson.gz`) {
    throw new Error("legacy_v1_payload_contract_invalid");
  }
  const version = text(manifest.minimum_harnery_version);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("legacy_v1_minimum_version_invalid");
  }
  return {
    format: "harnery-legacy-v1-segment",
    format_version: 1,
    segment_id: segmentId as `v1s_${string}`,
    source: {
      filename,
      bytes: integer(source.bytes),
      digest: digest(source.digest),
      row_count: integer(source.row_count),
      minimum_recorded_at: minimum,
      maximum_recorded_at: maximum,
    },
    payload: {
      algorithm: "gzip",
      path: text(payload.path),
      bytes: integer(payload.bytes),
      digest: digest(payload.digest),
    },
    minimum_harnery_version: version,
    created_at: timestamp(manifest.created_at),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("legacy_v1_manifest_object_invalid");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error("legacy_v1_manifest_unknown_field");
  }
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("legacy_v1_manifest_string_invalid");
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("legacy_v1_manifest_integer_invalid");
  }
  return value as number;
}

function digest(value: unknown): `sha256:${string}` {
  const result = text(value);
  if (!/^sha256:[0-9a-f]{64}$/.test(result)) throw new Error("legacy_v1_manifest_digest_invalid");
  return result as `sha256:${string}`;
}

function timestamp(value: unknown): string {
  const result = text(value);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  ) {
    throw new Error("legacy_v1_manifest_timestamp_invalid");
  }
  return result;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}
