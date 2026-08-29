import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { canonicalJsonV3 } from "../v3/canonical.ts";

export interface LegacyV1HardFence {
  manifest_version: 1;
  kind: "v1_hard_path_fence";
  terminal_archive: string;
  terminal_digest: `sha256:${string}`;
}

export interface VerifiedLegacyV1HardFence {
  fence_directory: string;
  marker_path: string;
  terminal_archive_path: string;
  marker: LegacyV1HardFence;
}

const MARKER = "V1-SEALED.json";

/** Verify the exact read-only V1 path fence and its terminal sealed segment. */
export async function verifyLegacyV1HardFence(
  coordRoot: string,
): Promise<VerifiedLegacyV1HardFence> {
  const root = resolve(coordRoot);
  const harnery = join(root, ".harnery");
  const harneryStat = await lstat(harnery);
  if (!harneryStat.isDirectory() || harneryStat.isSymbolicLink()) {
    throw new Error("legacy_v1_harnery_root_invalid");
  }
  const harneryReal = await realpath(harnery);
  const fence = join(harnery, "events.ndjson");
  let fenceStat: Awaited<ReturnType<typeof lstat>>;
  try {
    fenceStat = await lstat(fence);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("legacy_v1_hard_fence_missing");
    }
    throw error;
  }
  if (!fenceStat.isDirectory() || fenceStat.isSymbolicLink()) {
    throw new Error("legacy_v1_active_file_present_or_fence_invalid");
  }
  if ((fenceStat.mode & 0o222) !== 0) throw new Error("legacy_v1_hard_fence_is_writable");
  const fenceReal = await realpath(fence);
  if (relative(harneryReal, fenceReal).startsWith(".."))
    throw new Error("legacy_v1_hard_fence_escape");
  const names = (await readdir(fence)).sort();
  if (names.length !== 1 || names[0] !== MARKER) throw new Error("legacy_v1_hard_fence_not_exact");

  const markerPath = join(fence, MARKER);
  const markerStat = await lstat(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error("legacy_v1_hard_fence_marker_invalid");
  }
  if ((markerStat.mode & 0o222) !== 0) throw new Error("legacy_v1_hard_fence_marker_writable");
  if (markerStat.size > 64 * 1024) throw new Error("legacy_v1_hard_fence_marker_too_large");
  const markerText = await readFileNoFollow(markerPath);
  const marker = validateFenceMarker(JSON.parse(markerText) as unknown);
  if (markerText.trim() !== canonicalJsonV3(marker)) {
    throw new Error("legacy_v1_hard_fence_marker_noncanonical");
  }
  const terminalName = marker.terminal_archive.replace(/^\.harnery\//, "");
  if (!/^events-[0-9]{4}-[0-9]{2}-[0-9]{2}(?:\.[1-9][0-9]*)?\.ndjson$/.test(terminalName)) {
    throw new Error("legacy_v1_terminal_archive_name_invalid");
  }
  const terminalPath = join(harnery, terminalName);
  const terminalStat = await lstat(terminalPath);
  if (!terminalStat.isFile() || terminalStat.isSymbolicLink()) {
    throw new Error("legacy_v1_terminal_archive_invalid");
  }
  if ((await hashFile(terminalPath)) !== marker.terminal_digest) {
    throw new Error("legacy_v1_terminal_archive_digest_mismatch");
  }
  return {
    fence_directory: fence,
    marker_path: markerPath,
    terminal_archive_path: terminalPath,
    marker,
  };
}

function validateFenceMarker(value: unknown): LegacyV1HardFence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("legacy_v1_hard_fence_marker_invalid");
  }
  const marker = value as Record<string, unknown>;
  if (
    Object.keys(marker).sort().join("\0") !==
      ["kind", "manifest_version", "terminal_archive", "terminal_digest"].sort().join("\0") ||
    marker.manifest_version !== 1 ||
    marker.kind !== "v1_hard_path_fence" ||
    typeof marker.terminal_archive !== "string" ||
    typeof marker.terminal_digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(marker.terminal_digest)
  ) {
    throw new Error("legacy_v1_hard_fence_marker_invalid");
  }
  return marker as unknown as LegacyV1HardFence;
}

async function readFileNoFollow(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("legacy_v1_hard_fence_marker_invalid");
    return handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function hashFile(path: string): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`legacy_v1_segment_not_regular:${basename(path)}`);
    const stream = createReadStream(path, { fd: handle.fd, autoClose: false });
    for await (const current of stream) hash.update(current as Buffer);
  } finally {
    await handle.close();
  }
  return `sha256:${hash.digest("hex")}`;
}
