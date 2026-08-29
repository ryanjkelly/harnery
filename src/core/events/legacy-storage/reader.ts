import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { validateLegacyV1SegmentManifest } from "./manifest.ts";

export interface LegacyV1LogicalRow {
  row_number: number;
  bytes: Buffer;
}

export interface LegacyV1ReaderLimits {
  max_manifest_bytes?: number;
  max_payload_bytes?: number;
  max_decompressed_bytes?: number;
  max_row_bytes?: number;
  max_rows?: number;
}

const DEFAULTS: Required<LegacyV1ReaderLimits> = {
  max_manifest_bytes: 1024 * 1024,
  max_payload_bytes: 8 * 1024 * 1024 * 1024,
  max_decompressed_bytes: 16 * 1024 * 1024 * 1024,
  max_row_bytes: 64 * 1024 * 1024,
  max_rows: 20_000_000,
};

/** Stream rows from one loose sealed segment or one manifest-bound gzip canary. */
export async function* streamLegacyV1Rows(
  sourcePath: string,
  limits: LegacyV1ReaderLimits = {},
): AsyncGenerator<LegacyV1LogicalRow> {
  const bounded = { ...DEFAULTS, ...limits };
  const source = resolve(sourcePath);
  let input = source;
  let expectedRows: number | undefined;
  let expectedSourceBytes: number | undefined;
  let expectedSourceDigest: `sha256:${string}` | undefined;
  if (source.endsWith(".manifest.json")) {
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("legacy_v1_manifest_not_regular");
    if (stat.size > bounded.max_manifest_bytes) throw new Error("legacy_v1_manifest_too_large");
    const manifest = validateLegacyV1SegmentManifest(
      JSON.parse(await readFile(source, "utf8")) as unknown,
    );
    const directory = await realpath(dirname(source));
    input = resolve(directory, manifest.payload.path);
    const inputReal = await realpath(input);
    if (relative(directory, inputReal).startsWith(".."))
      throw new Error("legacy_v1_payload_escape");
    const payloadStat = await lstat(input);
    if (!payloadStat.isFile() || payloadStat.isSymbolicLink()) {
      throw new Error("legacy_v1_payload_not_regular");
    }
    if (payloadStat.size !== manifest.payload.bytes)
      throw new Error("legacy_v1_payload_length_mismatch");
    if (payloadStat.size > bounded.max_payload_bytes)
      throw new Error("legacy_v1_payload_too_large");
    if ((await hashFile(input)) !== manifest.payload.digest) {
      throw new Error("legacy_v1_payload_digest_mismatch");
    }
    expectedRows = manifest.source.row_count;
    expectedSourceBytes = manifest.source.bytes;
    expectedSourceDigest = manifest.source.digest;
  } else {
    const stat = await lstat(input);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("legacy_v1_segment_not_regular");
  }

  const compressed = source.endsWith(".manifest.json") || source.endsWith(".gz");
  const file = createReadStream(input);
  const stream = compressed ? file.pipe(createGunzip()) : file;
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let rows = 0;
  let decompressed = 0;
  const sourceHash = createHash("sha256");
  for await (const current of stream) {
    const chunk = current as Buffer;
    decompressed += chunk.length;
    sourceHash.update(chunk);
    if (decompressed > bounded.max_decompressed_bytes) {
      throw new Error("legacy_v1_decompression_bound_exceeded");
    }
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    if (pending.length > bounded.max_row_bytes && !pending.includes(0x0a)) {
      throw new Error("legacy_v1_row_bound_exceeded");
    }
    let newline = pending.indexOf(0x0a);
    while (newline >= 0) {
      const row = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (row.length === 0) throw new Error("legacy_v1_empty_row");
      if (row.length > bounded.max_row_bytes) throw new Error("legacy_v1_row_bound_exceeded");
      rows += 1;
      if (rows > bounded.max_rows) throw new Error("legacy_v1_row_count_bound_exceeded");
      yield { row_number: rows, bytes: Buffer.from(row) };
      newline = pending.indexOf(0x0a);
    }
  }
  if (pending.length !== 0) throw new Error("legacy_v1_segment_unterminated_or_truncated");
  if (expectedRows !== undefined && rows !== expectedRows)
    throw new Error("legacy_v1_row_count_mismatch");
  if (expectedSourceBytes !== undefined && decompressed !== expectedSourceBytes) {
    throw new Error("legacy_v1_source_length_mismatch");
  }
  const digest = `sha256:${sourceHash.digest("hex")}`;
  if (expectedSourceDigest !== undefined && digest !== expectedSourceDigest) {
    throw new Error("legacy_v1_source_digest_mismatch");
  }
}

async function hashFile(path: string): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  for await (const current of createReadStream(path)) hash.update(current as Buffer);
  return `sha256:${hash.digest("hex")}`;
}
