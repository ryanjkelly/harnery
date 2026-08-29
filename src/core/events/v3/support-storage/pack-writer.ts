import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { canonicalJsonV3 } from "../canonical.ts";
import {
  EVENT_V3_SUPPORT_FAMILIES,
  type EventV3LogicalAuthorityEntry,
  type EventV3SupportFamily,
  type EventV3SupportPackManifest,
  type EventV3SupportVerificationMode,
  logicalEntriesDigestV3,
  normalizeEventV3SupportPath,
  validateEventV3SupportPackManifest,
} from "./pack-contract.ts";

export interface EventV3SupportPackSource {
  relative_path: string;
  family: EventV3SupportFamily;
  recorded_at?: string;
  diagnostic_category?: string;
  diagnostic_reason?: string;
  expected_bytes?: number;
  expected_digest?: `sha256:${string}`;
}

export interface WriteEventV3SupportPackInput {
  authority_root: string;
  output_directory: string;
  root_id: string;
  genesis_id: string;
  verification_mode: EventV3SupportVerificationMode;
  source_authority_digest?: `sha256:${string}`;
  sources: EventV3SupportPackSource[];
  minimum_harnery_version: string;
  created_at: string;
  fault?: (boundary: "after_source_identity_before_open", path: string) => void;
}

export interface WrittenEventV3SupportPack {
  manifest: EventV3SupportPackManifest;
  manifest_path: string;
  payload_path: string;
}

interface InspectedSource extends EventV3SupportPackSource, EventV3LogicalAuthorityEntry {
  absolute_path: string;
}

/** Write a deterministic gzip-NDJSON support pack without buffering source files or the pack. */
export async function writeEventV3SupportPack(
  input: WriteEventV3SupportPackInput,
): Promise<WrittenEventV3SupportPack> {
  if (input.sources.length === 0) throw new Error("event_v3_support_pack_empty");
  const authorityRoot = resolve(input.authority_root);
  const authorityReal = await realDirectory(authorityRoot, "event_v3_support_authority_invalid");
  const inspected: InspectedSource[] = [];
  for (const source of [...input.sources].sort((left, right) =>
    left.relative_path.localeCompare(right.relative_path),
  )) {
    const relativePath = normalizeEventV3SupportPath(source.relative_path);
    if (inspected.at(-1)?.path === relativePath) throw new Error("event_v3_support_duplicate_path");
    const absolutePath = resolve(authorityRoot, ...relativePath.split("/"));
    const details = await inspectRegularFile(absolutePath, authorityReal, input.fault);
    if (
      (source.expected_bytes !== undefined && source.expected_bytes !== details.bytes) ||
      (source.expected_digest !== undefined && source.expected_digest !== details.digest)
    ) {
      throw new Error("event_v3_support_source_planned_mismatch");
    }
    inspected.push({
      ...source,
      relative_path: relativePath,
      path: relativePath,
      absolute_path: absolutePath,
      ...details,
    });
  }

  const logicalEntries = inspected.map(({ path, bytes, digest }) => ({ path, bytes, digest }));
  const logicalDigest = logicalEntriesDigestV3(logicalEntries);
  const packId = `vsp_${createHash("sha256")
    .update(
      canonicalJsonV3({
        root_id: input.root_id,
        genesis_id: input.genesis_id,
        verification_mode: input.verification_mode,
        entries: logicalEntries,
      }),
    )
    .digest("hex")
    .slice(0, 32)}` as const;

  const outputDirectory = resolve(input.output_directory);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const payloadName = `${packId}.ndjson.gz`;
  const payloadPath = join(outputDirectory, payloadName);
  const manifestPath = join(outputDirectory, `${packId}.manifest.json`);
  const payloadPartial = `${payloadPath}.partial`;
  const manifestPartial = `${manifestPath}.partial`;
  await rejectExisting([payloadPath, manifestPath, payloadPartial, manifestPartial]);

  try {
    await streamPayload(inspected, payloadPartial, authorityReal);
    await chmod(payloadPartial, 0o600);
    await rename(payloadPartial, payloadPath);
    const payload = await inspectRegularFile(payloadPath);
    const manifest = validateEventV3SupportPackManifest({
      format: "harnery-event-v3-support-pack",
      format_version: 1,
      pack_id: packId,
      authority: {
        root_id: input.root_id,
        genesis_id: input.genesis_id,
        verification_mode: input.verification_mode,
        ...(input.source_authority_digest
          ? { source_authority_digest: input.source_authority_digest }
          : {}),
        source_files_digest: logicalDigest,
      },
      scope: scopeFor(inspected),
      entries: {
        count: inspected.length,
        uncompressed_bytes: inspected.reduce((sum, entry) => sum + entry.bytes, 0),
        logical_entries_digest: logicalDigest,
        by_family: rollupFamilies(inspected),
        by_diagnostic_category: rollupStrings(inspected, "diagnostic_category"),
        by_diagnostic_reason: rollupStrings(inspected, "diagnostic_reason"),
      },
      payload: {
        algorithm: "gzip",
        path: payloadName,
        bytes: payload.bytes,
        digest: payload.digest,
      },
      minimum_harnery_version: input.minimum_harnery_version,
      created_at: input.created_at,
    });
    const handle = await open(
      manifestPartial,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(`${canonicalJsonV3(manifest)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(manifestPartial, manifestPath);
    return { manifest, manifest_path: manifestPath, payload_path: payloadPath };
  } catch (error) {
    await rm(payloadPartial, { force: true });
    await rm(manifestPartial, { force: true });
    await rm(payloadPath, { force: true });
    await rm(manifestPath, { force: true });
    throw error;
  }
}

async function streamPayload(
  entries: InspectedSource[],
  destination: string,
  authorityReal: string,
): Promise<void> {
  const gzip = createGzip({ level: 9 });
  const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  const completed = pipeline(gzip, output);
  try {
    for (const entry of entries) {
      await writeChunk(
        gzip,
        `{"path":${JSON.stringify(entry.path)},"bytes":${entry.bytes},"digest":${JSON.stringify(
          entry.digest,
        )},"content_base64":"`,
      );
      const handle = await openStableRegularFile(entry.absolute_path, authorityReal);
      try {
        const hash = createHash("sha256");
        let bytes = 0;
        let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        const stream = createReadStream(entry.absolute_path, {
          fd: handle.fd,
          autoClose: false,
          start: 0,
          highWaterMark: 64 * 1024,
        });
        for await (const current of stream) {
          const chunk = current as Buffer;
          bytes += chunk.length;
          hash.update(chunk);
          const combined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
          const complete = combined.length - (combined.length % 3);
          if (complete > 0)
            await writeChunk(gzip, combined.subarray(0, complete).toString("base64"));
          carry = combined.subarray(complete);
        }
        if (carry.length > 0) await writeChunk(gzip, carry.toString("base64"));
        const digest = `sha256:${hash.digest("hex")}`;
        if (bytes !== entry.bytes || digest !== entry.digest) {
          throw new Error("event_v3_support_source_changed_during_pack");
        }
      } finally {
        await handle.close();
      }
      await writeChunk(gzip, `"}\n`);
    }
    gzip.end();
    await completed;
  } catch (error) {
    gzip.destroy(error as Error);
    await completed.catch(() => undefined);
    throw error;
  }
}

async function inspectRegularFile(
  path: string,
  containmentRoot?: string,
  fault?: WriteEventV3SupportPackInput["fault"],
): Promise<{ bytes: number; digest: `sha256:${string}` }> {
  const handle = await openStableRegularFile(path, containmentRoot, fault);
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = createReadStream(path, { fd: handle.fd, autoClose: false, start: 0 });
    for await (const current of stream) {
      const chunk = current as Buffer;
      bytes += chunk.length;
      hash.update(chunk);
    }
    return { bytes, digest: `sha256:${hash.digest("hex")}` };
  } finally {
    await handle.close();
  }
}

async function openStableRegularFile(
  path: string,
  containmentRoot?: string,
  fault?: WriteEventV3SupportPackInput["fault"],
) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("event_v3_support_source_not_regular");
  }
  const beforeReal = await realpath(path);
  if (containmentRoot) assertContained(containmentRoot, beforeReal);
  fault?.("after_source_identity_before_open", path);
  const handle = await open(path, constants.O_RDONLY | noFollow());
  try {
    const opened = await handle.stat();
    const after = await lstat(path);
    const afterReal = await realpath(path);
    if (
      !opened.isFile() ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      !sameIdentity(before, opened) ||
      !sameIdentity(opened, after) ||
      beforeReal !== afterReal
    ) {
      throw new Error("event_v3_support_source_changed_during_open");
    }
    if (containmentRoot) assertContained(containmentRoot, afterReal);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function sameIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function realDirectory(path: string, code: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(code);
  return realpath(path);
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
  throw new Error("event_v3_support_source_outside_authority");
}

function noFollow(): number {
  return constants.O_NOFOLLOW ?? 0;
}

async function rejectExisting(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      await lstat(path);
      throw new Error(`event_v3_support_output_exists:${basename(path)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function writeChunk(stream: NodeJS.WritableStream, value: string): Promise<void> {
  if (!stream.write(value, "utf8")) await once(stream, "drain");
}

function scopeFor(entries: InspectedSource[]): EventV3SupportPackManifest["scope"] {
  const timestamps = entries
    .flatMap((entry) => (entry.recorded_at ? [entry.recorded_at] : []))
    .sort();
  return {
    families: [...new Set(entries.map(({ family }) => family))].sort(),
    minimum_recorded_at: timestamps[0] ?? null,
    maximum_recorded_at: timestamps.at(-1) ?? null,
  };
}

function rollupFamilies(entries: InspectedSource[]): Record<EventV3SupportFamily, number> {
  const result = Object.fromEntries(
    EVENT_V3_SUPPORT_FAMILIES.map((family) => [family, 0]),
  ) as Record<EventV3SupportFamily, number>;
  for (const entry of entries) result[entry.family] += 1;
  return result;
}

function rollupStrings(
  entries: InspectedSource[],
  key: "diagnostic_category" | "diagnostic_reason",
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const entry of entries) {
    const value = entry[key];
    if (value) result[value] = (result[value] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}
