import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { type LegacyV1SegmentManifest, validateLegacyV1SegmentManifest } from "./manifest.ts";

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
  fault?: (boundary: "after_source_digest", path: string) => void;
}

const DEFAULTS: Required<Omit<LegacyV1ReaderLimits, "fault">> = {
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
  let expectedPayloadBytes: number | undefined;
  let expectedPayloadDigest: `sha256:${string}` | undefined;
  let containmentRoot: string | undefined;
  if (source.endsWith(".manifest.json")) {
    const manifestHandle = await openStableRegularFile(source, undefined, "manifest");
    let manifest: LegacyV1SegmentManifest;
    try {
      const stat = await manifestHandle.stat();
      if (stat.size > bounded.max_manifest_bytes) throw new Error("legacy_v1_manifest_too_large");
      manifest = validateLegacyV1SegmentManifest(
        JSON.parse(await manifestHandle.readFile("utf8")) as unknown,
      );
    } finally {
      await manifestHandle.close();
    }
    const directory = await realpath(dirname(source));
    containmentRoot = directory;
    input = resolve(directory, manifest.payload.path);
    expectedRows = manifest.source.row_count;
    expectedSourceBytes = manifest.source.bytes;
    expectedSourceDigest = manifest.source.digest;
    expectedPayloadBytes = manifest.payload.bytes;
    expectedPayloadDigest = manifest.payload.digest;
  }

  const compressed = source.endsWith(".manifest.json") || source.endsWith(".gz");
  const kind = source.endsWith(".manifest.json") ? "payload" : "segment";
  const inputHandle = await openStableRegularFile(input, containmentRoot, kind);
  try {
    const inputStat = await inputHandle.stat();
    if (source.endsWith(".manifest.json")) {
      if (inputStat.size !== expectedPayloadBytes)
        throw new Error("legacy_v1_payload_length_mismatch");
      if (inputStat.size > bounded.max_payload_bytes)
        throw new Error("legacy_v1_payload_too_large");
      if ((await hashHandle(input, inputHandle)) !== expectedPayloadDigest) {
        throw new Error("legacy_v1_payload_digest_mismatch");
      }
    }
    limits.fault?.("after_source_digest", input);
    const file = createReadStream(input, { fd: inputHandle.fd, autoClose: false, start: 0 });
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
  } finally {
    await inputHandle.close();
  }
}

async function hashHandle(
  path: string,
  handle: Awaited<ReturnType<typeof open>>,
): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  const stream = createReadStream(path, { fd: handle.fd, autoClose: false, start: 0 });
  for await (const current of stream) hash.update(current as Buffer);
  return `sha256:${hash.digest("hex")}`;
}

async function openStableRegularFile(
  path: string,
  containmentRoot: string | undefined,
  kind: "manifest" | "payload" | "segment",
) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`legacy_v1_${kind}_not_regular`);
  const beforeReal = await realpath(path);
  if (containmentRoot) assertContained(containmentRoot, beforeReal);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const after = await lstat(path);
    const afterReal = await realpath(path);
    if (
      !opened.isFile() ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      beforeReal !== afterReal
    )
      throw new Error(`legacy_v1_${kind}_changed_during_open`);
    if (containmentRoot) assertContained(containmentRoot, afterReal);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function assertContained(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (
    path === "" ||
    (path !== ".." &&
      !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(path))
  )
    return;
  throw new Error("legacy_v1_payload_escape");
}
