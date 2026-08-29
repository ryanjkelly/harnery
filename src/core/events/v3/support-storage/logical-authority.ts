import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { canonicalJsonV3 } from "../canonical.ts";
import type { EventV3LogicalAuthorityEntry } from "./pack-contract.ts";
import { readEventV3SupportPackManifest, streamEventV3SupportPackRecords } from "./pack-reader.ts";

export interface EventV3LogicalAuthorityView {
  entries: EventV3LogicalAuthorityEntry[];
  quarantined_packs: Array<{ manifest_path: string; reason: string }>;
  physical_files: number;
  packed_entries: number;
}

/** Build a pack-aware authority view without following symlinks or granting pack precedence. */
export async function iterateEventV3LogicalAuthority(
  authorityRoot: string,
): Promise<EventV3LogicalAuthorityView> {
  const root = resolve(authorityRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("event_v3_logical_authority_root_invalid");
  }
  const rootReal = await realpath(root);
  const physical = new Map<string, EventV3LogicalAuthorityEntry>();
  const manifests: string[] = [];
  let physicalFiles = 0;

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("event_v3_logical_authority_directory_invalid");
    }
    const directoryReal = await realpath(directory);
    if (relative(rootReal, directoryReal).startsWith("..")) {
      throw new Error("event_v3_logical_authority_directory_escape");
    }
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("event_v3_logical_authority_symlink");
      if (stat.isDirectory()) {
        if (prefix === "" && entry.name === "support-packs") {
          for (const candidate of await readdir(path)) {
            if (candidate.endsWith(".manifest.json")) manifests.push(join(path, candidate));
          }
        } else {
          await visit(path, relativePath);
        }
        continue;
      }
      if (!stat.isFile()) throw new Error("event_v3_logical_authority_special_file");
      const digest = await hashFile(path);
      physical.set(relativePath, { path: relativePath, bytes: stat.size, digest });
      physicalFiles += 1;
    }
  };
  await visit(root, "");

  const packedByPath = new Map<string, { entry: EventV3LogicalAuthorityEntry; manifest: string }>();
  const quarantined: EventV3LogicalAuthorityView["quarantined_packs"] = [];
  let packedEntries = 0;
  for (const manifestPath of manifests.sort()) {
    await readEventV3SupportPackManifest(manifestPath);
    const candidate: EventV3LogicalAuthorityEntry[] = [];
    for await (const record of streamEventV3SupportPackRecords(manifestPath)) {
      const priorPack = packedByPath.get(record.path);
      if (priorPack)
        throw new Error(`event_v3_logical_authority_cross_pack_duplicate:${record.path}`);
      candidate.push({ path: record.path, bytes: record.bytes, digest: record.digest });
    }
    const conflict = candidate.find((entry) => {
      const loose = physical.get(entry.path);
      return loose && (loose.bytes !== entry.bytes || loose.digest !== entry.digest);
    });
    if (conflict) {
      quarantined.push({
        manifest_path: manifestPath,
        reason: `loose_pack_digest_conflict:${conflict.path}`,
      });
      continue;
    }
    for (const entry of candidate) packedByPath.set(entry.path, { entry, manifest: manifestPath });
    packedEntries += candidate.length;
  }

  const combined = new Map(physical);
  for (const { entry } of packedByPath.values()) {
    if (!combined.has(entry.path)) combined.set(entry.path, entry);
  }
  return {
    entries: [...combined.values()].sort((left, right) => left.path.localeCompare(right.path)),
    quarantined_packs: quarantined,
    physical_files: physicalFiles,
    packed_entries: packedEntries,
  };
}

export async function digestEventV3LogicalAuthority(
  authorityRoot: string,
): Promise<`sha256:${string}`> {
  const view = await iterateEventV3LogicalAuthority(authorityRoot);
  if (view.quarantined_packs.length > 0) {
    throw new Error("event_v3_logical_authority_has_quarantined_pack");
  }
  return `sha256:${createHash("sha256").update(canonicalJsonV3(view.entries)).digest("hex")}`;
}

async function hashFile(path: string): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  for await (const current of createReadStream(path)) hash.update(current as Buffer);
  return `sha256:${hash.digest("hex")}`;
}
