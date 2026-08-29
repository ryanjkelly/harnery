import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createGunzip, createInflateRaw } from "node:zlib";
import {
  type EventV3LogicalAuthorityEntry,
  type EventV3SupportPackManifest,
  type EventV3SupportPackRecord,
  logicalEntriesDigestV3,
  validateEventV3SupportPackManifest,
  validateEventV3SupportPackRecord,
} from "./pack-contract.ts";

export interface EventV3SupportPackLimits {
  max_manifest_bytes?: number;
  max_payload_bytes?: number;
  max_decompressed_bytes?: number;
  max_record_line_bytes?: number;
  max_entries?: number;
  fault?: (boundary: "after_payload_digest", path: string) => void;
}

export interface DecodedEventV3SupportPackRecord
  extends Omit<EventV3SupportPackRecord, "content_base64"> {
  content: Buffer;
}

export interface ValidatedEventV3SupportPack {
  manifest: EventV3SupportPackManifest;
  records: DecodedEventV3SupportPackRecord[];
}

export interface VerifiedEventV3SupportPack {
  manifest: EventV3SupportPackManifest;
  entries: number;
  uncompressed_bytes: number;
}

const DEFAULT_LIMITS: Required<Omit<EventV3SupportPackLimits, "fault">> = {
  max_manifest_bytes: 1024 * 1024,
  max_payload_bytes: 8 * 1024 * 1024 * 1024,
  max_decompressed_bytes: 16 * 1024 * 1024 * 1024,
  max_record_line_bytes: 128 * 1024 * 1024,
  max_entries: 2_000_000,
};

export async function readEventV3SupportPackManifest(
  manifestPath: string,
  limits: EventV3SupportPackLimits = {},
): Promise<EventV3SupportPackManifest> {
  const bounded = { ...DEFAULT_LIMITS, ...limits };
  const path = resolve(manifestPath);
  const handle = await openStableRegularFile(path, undefined, "manifest");
  try {
    const stat = await handle.stat();
    if (stat.size > bounded.max_manifest_bytes)
      throw new Error("event_v3_support_manifest_too_large");
    const value = JSON.parse(await handle.readFile("utf8")) as unknown;
    return validateEventV3SupportPackManifest(value);
  } finally {
    await handle.close();
  }
}

/** Validate one pack and stream logical records to the caller one source file at a time. */
export async function* streamEventV3SupportPackRecords(
  manifestPath: string,
  limits: EventV3SupportPackLimits = {},
): AsyncGenerator<DecodedEventV3SupportPackRecord> {
  const manifest = await readEventV3SupportPackManifest(manifestPath, limits);
  yield* streamEventV3SupportPackRecordsForManifest(manifestPath, manifest, limits);
}

async function* streamEventV3SupportPackRecordsForManifest(
  manifestPath: string,
  manifest: EventV3SupportPackManifest,
  limits: EventV3SupportPackLimits,
): AsyncGenerator<DecodedEventV3SupportPackRecord> {
  const bounded = { ...DEFAULT_LIMITS, ...limits };
  const manifestDirectory = await realDirectory(dirname(resolve(manifestPath)));
  const payloadPath = resolve(manifestDirectory, manifest.payload.path);
  const payloadHandle = await openStableRegularFile(payloadPath, manifestDirectory, "payload");
  try {
    const payloadStat = await payloadHandle.stat();
    if (payloadStat.size !== manifest.payload.bytes)
      throw new Error("event_v3_support_payload_length_mismatch");
    if (payloadStat.size > bounded.max_payload_bytes)
      throw new Error("event_v3_support_payload_too_large");
    if ((await hashHandle(payloadPath, payloadHandle)) !== manifest.payload.digest) {
      throw new Error("event_v3_support_payload_digest_mismatch");
    }
    limits.fault?.("after_payload_digest", payloadPath);
    await assertCanonicalSingleGzipMember(
      payloadPath,
      payloadHandle,
      payloadStat.size,
      bounded.max_decompressed_bytes,
    );

    const gunzip = createGunzip();
    const source = createReadStream(payloadPath, {
      fd: payloadHandle.fd,
      autoClose: false,
      start: 0,
    });
    source.pipe(gunzip);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let decompressedBytes = 0;
    let entryCount = 0;
    let uncompressedBytes = 0;
    let priorPath: string | undefined;
    const entries: EventV3LogicalAuthorityEntry[] = [];
    const seen = new Set<string>();

    for await (const current of gunzip) {
      const chunk = current as Buffer;
      decompressedBytes += chunk.length;
      if (decompressedBytes > bounded.max_decompressed_bytes) {
        throw new Error("event_v3_support_decompression_bound_exceeded");
      }
      pending += decoder.write(chunk);
      if (Buffer.byteLength(pending) > bounded.max_record_line_bytes && !pending.includes("\n")) {
        throw new Error("event_v3_support_record_bound_exceeded");
      }
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length === 0) throw new Error("event_v3_support_trailing_data");
        if (Buffer.byteLength(line) > bounded.max_record_line_bytes) {
          throw new Error("event_v3_support_record_bound_exceeded");
        }
        const record = validateEventV3SupportPackRecord(JSON.parse(line) as unknown);
        entryCount += 1;
        if (entryCount > bounded.max_entries)
          throw new Error("event_v3_support_entry_bound_exceeded");
        if (seen.has(record.path)) throw new Error("event_v3_support_duplicate_path");
        if (priorPath !== undefined && priorPath.localeCompare(record.path) >= 0) {
          throw new Error("event_v3_support_record_order_invalid");
        }
        seen.add(record.path);
        priorPath = record.path;
        const content = Buffer.from(record.content_base64, "base64");
        if (content.toString("base64") !== record.content_base64) {
          throw new Error("event_v3_support_record_base64_noncanonical");
        }
        if (content.length !== record.bytes)
          throw new Error("event_v3_support_record_length_mismatch");
        if (`sha256:${createHash("sha256").update(content).digest("hex")}` !== record.digest) {
          throw new Error("event_v3_support_record_digest_mismatch");
        }
        uncompressedBytes += content.length;
        entries.push({ path: record.path, bytes: record.bytes, digest: record.digest });
        yield { path: record.path, bytes: record.bytes, digest: record.digest, content };
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.end();
    if (pending.length !== 0) throw new Error("event_v3_support_payload_truncated_or_trailing");
    if (
      entryCount !== manifest.entries.count ||
      uncompressedBytes !== manifest.entries.uncompressed_bytes
    ) {
      throw new Error("event_v3_support_manifest_entry_mismatch");
    }
    const digest = logicalEntriesDigestV3(entries);
    if (
      digest !== manifest.entries.logical_entries_digest ||
      digest !== manifest.authority.source_files_digest
    ) {
      throw new Error("event_v3_support_logical_digest_mismatch");
    }
  } finally {
    await payloadHandle.close();
  }
}

export async function validateEventV3SupportPack(
  manifestPath: string,
  limits: EventV3SupportPackLimits = {},
): Promise<ValidatedEventV3SupportPack> {
  const manifest = await readEventV3SupportPackManifest(manifestPath, limits);
  const records: DecodedEventV3SupportPackRecord[] = [];
  for await (const record of streamEventV3SupportPackRecordsForManifest(
    manifestPath,
    manifest,
    limits,
  )) {
    records.push(record);
  }
  return { manifest, records };
}

/** Verify the complete pack while retaining only one decoded source record at a time. */
export async function verifyEventV3SupportPack(
  manifestPath: string,
  limits: EventV3SupportPackLimits = {},
): Promise<VerifiedEventV3SupportPack> {
  const manifest = await readEventV3SupportPackManifest(manifestPath, limits);
  let entries = 0;
  let bytes = 0;
  for await (const record of streamEventV3SupportPackRecordsForManifest(
    manifestPath,
    manifest,
    limits,
  )) {
    entries += 1;
    bytes += record.bytes;
  }
  return { manifest, entries, uncompressed_bytes: bytes };
}

/** Unpack only into a destination that does not yet exist; never overlay an authority. */
export async function unpackEventV3SupportPack(
  manifestPath: string,
  destination: string,
  limits: EventV3SupportPackLimits = {},
): Promise<{ files: number; bytes: number; destination: string }> {
  const target = resolve(destination);
  try {
    await lstat(target);
    throw new Error("event_v3_support_unpack_destination_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(target, { recursive: false, mode: 0o700 });
  let files = 0;
  let bytes = 0;
  try {
    for await (const record of streamEventV3SupportPackRecords(manifestPath, limits)) {
      const path = resolve(target, ...record.path.split("/"));
      if (relative(target, path).startsWith(".."))
        throw new Error("event_v3_support_unpack_path_escape");
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, record.content, { flag: "wx", mode: 0o600 });
      files += 1;
      bytes += record.bytes;
    }
    return { files, bytes, destination: target };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
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

async function realDirectory(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("event_v3_support_pack_root_invalid");
  return realpath(path);
}

async function assertCanonicalSingleGzipMember(
  path: string,
  handle: Awaited<ReturnType<typeof open>>,
  payloadBytes: number,
  maximumDecompressedBytes: number,
): Promise<void> {
  if (payloadBytes < 18) throw new Error("event_v3_support_gzip_truncated");
  const header = Buffer.alloc(10);
  const read = await handle.read(header, 0, header.length, 0);
  if (
    read.bytesRead !== 10 ||
    header[0] !== 0x1f ||
    header[1] !== 0x8b ||
    header[2] !== 0x08 ||
    header[3] !== 0x00 ||
    !header.subarray(4, 8).equals(Buffer.alloc(4))
  ) {
    throw new Error("event_v3_support_gzip_header_noncanonical");
  }
  const inflate = createInflateRaw();
  createReadStream(path, { fd: handle.fd, autoClose: false, start: 10 }).pipe(inflate);
  let decompressed = 0;
  for await (const current of inflate) {
    decompressed += (current as Buffer).length;
    if (decompressed > maximumDecompressedBytes) {
      inflate.destroy();
      throw new Error("event_v3_support_decompression_bound_exceeded");
    }
  }
  if (10 + inflate.bytesWritten + 8 !== payloadBytes) {
    throw new Error("event_v3_support_gzip_trailing_data");
  }
}

async function openStableRegularFile(
  path: string,
  containmentRoot: string | undefined,
  kind: "manifest" | "payload",
) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`event_v3_support_${kind}_not_regular`);
  }
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
    ) {
      throw new Error(`event_v3_support_${kind}_changed_during_open`);
    }
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
  throw new Error("event_v3_support_payload_outside_pack");
}
