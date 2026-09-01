/** Verified in-place compression for sealed, non-terminal legacy V1 shards. */

import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, rename, rm } from "node:fs/promises";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { verifyLegacyV1HardFence } from "./fence.ts";
import { inventoryLegacyV1Segments } from "./inventory.ts";
import { streamLegacyV1Rows } from "./reader.ts";

export interface LegacyV1CompressionEntry {
  filename: string;
  path: string;
  bytes_before: number;
  bytes_after: number | null;
  action: "keep" | "would-compress" | "compressed";
  reason: string;
}

export async function compressSealedLegacyV1Segments(
  coordRoot: string,
  opts: { yes?: boolean } = {},
): Promise<LegacyV1CompressionEntry[]> {
  const fence = await verifyLegacyV1HardFence(coordRoot);
  const terminal = basename(fence.terminal_archive_path);
  const inventory = await inventoryLegacyV1Segments(coordRoot);
  const rows = inventory.map<LegacyV1CompressionEntry>((entry) => {
    if (entry.filename === terminal) {
      return {
        filename: entry.filename,
        path: entry.path,
        bytes_before: entry.bytes,
        bytes_after: null,
        action: "keep",
        reason: "terminal shard is bound by the V1 hard-fence digest",
      };
    }
    if (entry.compressed) {
      return {
        filename: entry.filename,
        path: entry.path,
        bytes_before: entry.bytes,
        bytes_after: entry.bytes,
        action: "keep",
        reason: "already compressed",
      };
    }
    return {
      filename: entry.filename,
      path: entry.path,
      bytes_before: entry.bytes,
      bytes_after: null,
      action: "would-compress",
      reason: "sealed non-terminal V1 shard",
    };
  });
  if (!opts.yes) return rows;

  for (const row of rows) {
    if (row.action !== "would-compress") continue;
    const expected = inventory.find((entry) => entry.path === row.path)!;
    const current = (await inventoryLegacyV1Segments(coordRoot)).find(
      (entry) => entry.path === row.path,
    );
    if (
      !current ||
      current.bytes !== expected.bytes ||
      current.digest !== expected.digest ||
      current.compressed
    ) {
      throw new Error(`legacy_v1_segment_changed_before_compression:${row.filename}`);
    }
    const sourceStat = await lstat(row.path);
    const destination = `${row.path}.gz`;
    const temporary = `${row.path}.partial-${process.pid}.gz`;
    try {
      try {
        await lstat(destination);
        throw new Error(`legacy_v1_compressed_destination_exists:${row.filename}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await pipeline(
        createReadStream(row.path),
        createGzip({ level: 9 }),
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      await proveRowParity(row.path, temporary);
      const unchanged = (await inventoryLegacyV1Segments(coordRoot)).find(
        (entry) => entry.path === row.path,
      );
      if (
        !unchanged ||
        unchanged.bytes !== expected.bytes ||
        unchanged.digest !== expected.digest
      ) {
        throw new Error(`legacy_v1_segment_changed_during_compression:${row.filename}`);
      }
      await chmod(temporary, sourceStat.mode & 0o777);
      await rename(temporary, destination);
      await rm(row.path);
      row.action = "compressed";
      row.reason = "verified gzip replacement preserved every logical row";
      row.bytes_after = (await lstat(destination)).size;
      row.path = destination;
      row.filename = basename(destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  return rows;
}

async function proveRowParity(loose: string, compressed: string): Promise<void> {
  const left = streamLegacyV1Rows(loose)[Symbol.asyncIterator]();
  const right = streamLegacyV1Rows(compressed)[Symbol.asyncIterator]();
  while (true) {
    const [looseRow, packedRow] = await Promise.all([left.next(), right.next()]);
    if (looseRow.done || packedRow.done) {
      if (looseRow.done !== packedRow.done)
        throw new Error("legacy_v1_compression_row_count_mismatch");
      return;
    }
    if (!looseRow.value.bytes.equals(packedRow.value.bytes)) {
      throw new Error(`legacy_v1_compression_row_mismatch:${looseRow.value.row_number}`);
    }
  }
}
