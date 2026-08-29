import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface LegacyV1SegmentInventoryEntry {
  filename: string;
  path: string;
  bytes: number;
  digest: `sha256:${string}`;
  compressed: boolean;
}

/** Enumerate all root events*.ndjson* frozen-history candidates, including manual variants. */
export async function inventoryLegacyV1Segments(
  coordRoot: string,
): Promise<LegacyV1SegmentInventoryEntry[]> {
  const harnery = resolve(coordRoot, ".harnery");
  const stat = await lstat(harnery);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("legacy_v1_inventory_root_invalid");
  const rootReal = await realpath(harnery);
  const result: LegacyV1SegmentInventoryEntry[] = [];
  for (const name of (await readdir(harnery)).sort()) {
    if (!/^events.*\.ndjson(?:\.gz)?$/.test(name) || name === "events.ndjson") continue;
    const path = join(harnery, name);
    const entryStat = await lstat(path);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      throw new Error(`legacy_v1_inventory_segment_invalid:${name}`);
    }
    const pathReal = await realpath(path);
    if (relative(rootReal, pathReal).startsWith(".."))
      throw new Error("legacy_v1_inventory_escape");
    result.push({
      filename: name,
      path,
      bytes: entryStat.size,
      digest: await hashFile(path),
      compressed: name.endsWith(".gz"),
    });
  }
  return result;
}

async function hashFile(path: string): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  for await (const current of createReadStream(path)) hash.update(current as Buffer);
  return `sha256:${hash.digest("hex")}`;
}
