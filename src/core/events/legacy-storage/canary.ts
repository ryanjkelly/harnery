import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { canonicalJsonV3 } from "../v3/canonical.ts";
import { verifyLegacyV1HardFence } from "./fence.ts";
import { type LegacyV1SegmentManifest, validateLegacyV1SegmentManifest } from "./manifest.ts";
import { streamLegacyV1Rows } from "./reader.ts";

export interface LegacyV1CanaryResult {
  manifest: LegacyV1SegmentManifest;
  manifest_path: string;
  payload_path: string;
  source_unchanged: true;
  replacement_enabled: false;
}

/** Shadow-compress one fenced legacy segment, then prove byte and row parity. */
export async function writeLegacyV1Canary(input: {
  coord_root: string;
  source_filename: string;
  output_directory: string;
  minimum_harnery_version: string;
  created_at: string;
}): Promise<LegacyV1CanaryResult> {
  await verifyLegacyV1HardFence(input.coord_root);
  if (
    !/^events.+\.ndjson$/.test(input.source_filename) ||
    input.source_filename.includes("/") ||
    input.source_filename.includes("\\")
  ) {
    throw new Error("legacy_v1_canary_source_name_invalid");
  }
  const harnery = resolve(input.coord_root, ".harnery");
  const source = join(harnery, input.source_filename);
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("legacy_v1_canary_source_not_regular");
  }
  const sourceDigest = await hashFile(source);
  const sourceFacts = await inspectRows(source);
  const segmentId = `v1s_${createHash("sha256")
    .update(`${input.source_filename}\0${sourceStat.size}\0${sourceDigest}`)
    .digest("hex")
    .slice(0, 32)}` as const;
  const outputDirectory = resolve(input.output_directory);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const payloadPath = join(outputDirectory, `${segmentId}.ndjson.gz`);
  const manifestPath = join(outputDirectory, `${segmentId}.manifest.json`);
  const partialPayload = `${payloadPath}.partial`;
  const partialManifest = `${manifestPath}.partial`;
  await rejectExisting([payloadPath, manifestPath, partialPayload, partialManifest]);
  try {
    await pipeline(
      createReadStream(source),
      createGzip({ level: 9 }),
      createWriteStream(partialPayload, { flags: "wx", mode: 0o600 }),
    );
    await rename(partialPayload, payloadPath);
    const payloadStat = await lstat(payloadPath);
    const manifest = validateLegacyV1SegmentManifest({
      format: "harnery-legacy-v1-segment",
      format_version: 1,
      segment_id: segmentId,
      source: {
        filename: input.source_filename,
        bytes: sourceStat.size,
        digest: sourceDigest,
        row_count: sourceFacts.rows,
        minimum_recorded_at: sourceFacts.minimum,
        maximum_recorded_at: sourceFacts.maximum,
      },
      payload: {
        algorithm: "gzip",
        path: basename(payloadPath),
        bytes: payloadStat.size,
        digest: await hashFile(payloadPath),
      },
      minimum_harnery_version: input.minimum_harnery_version,
      created_at: input.created_at,
    });
    const handle = await open(
      partialManifest,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(`${canonicalJsonV3(manifest)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(partialManifest, manifestPath);
    await proveRowParity(source, manifestPath);
    const after = await lstat(source);
    if (after.size !== sourceStat.size || (await hashFile(source)) !== sourceDigest) {
      throw new Error("legacy_v1_canary_source_changed");
    }
    return {
      manifest,
      manifest_path: manifestPath,
      payload_path: payloadPath,
      source_unchanged: true,
      replacement_enabled: false,
    };
  } catch (error) {
    await rm(partialPayload, { force: true });
    await rm(partialManifest, { force: true });
    await rm(payloadPath, { force: true });
    await rm(manifestPath, { force: true });
    throw error;
  }
}

export function activateLegacyV1CanaryReplacement(): never {
  throw new Error("legacy_v1_replacement_activation_disabled");
}

async function inspectRows(
  path: string,
): Promise<{ rows: number; minimum: string | null; maximum: string | null }> {
  let rows = 0;
  const timestamps: string[] = [];
  for await (const row of streamLegacyV1Rows(path)) {
    rows += 1;
    const value = JSON.parse(row.bytes.toString("utf8")) as Record<string, unknown>;
    const candidate =
      typeof value.at === "string"
        ? value.at
        : typeof value.timestamp === "string"
          ? value.timestamp
          : value.time &&
              typeof value.time === "object" &&
              typeof (value.time as Record<string, unknown>).observed_at === "string"
            ? ((value.time as Record<string, unknown>).observed_at as string)
            : undefined;
    if (candidate && Number.isFinite(Date.parse(candidate)))
      timestamps.push(new Date(candidate).toISOString());
  }
  timestamps.sort();
  return { rows, minimum: timestamps[0] ?? null, maximum: timestamps.at(-1) ?? null };
}

async function proveRowParity(loose: string, manifest: string): Promise<void> {
  const left = streamLegacyV1Rows(loose)[Symbol.asyncIterator]();
  const right = streamLegacyV1Rows(manifest)[Symbol.asyncIterator]();
  while (true) {
    const [looseRow, packedRow] = await Promise.all([left.next(), right.next()]);
    if (looseRow.done || packedRow.done) {
      if (looseRow.done !== packedRow.done) throw new Error("legacy_v1_canary_row_count_mismatch");
      break;
    }
    if (!looseRow.value.bytes.equals(packedRow.value.bytes)) {
      throw new Error(`legacy_v1_canary_row_mismatch:${looseRow.value.row_number}`);
    }
  }
}

async function hashFile(path: string): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  for await (const current of createReadStream(path)) hash.update(current as Buffer);
  return `sha256:${hash.digest("hex")}`;
}

async function rejectExisting(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      await lstat(path);
      throw new Error("legacy_v1_canary_output_exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
