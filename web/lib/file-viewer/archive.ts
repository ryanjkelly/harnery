/**
 * Server-side archive listing: names + sizes only, no extraction
 * to disk. zip via fflate's in-memory `unzipSync`; tar via a small in-house
 * 512-byte-header iterator (no `tar-stream`, which is Node-stream-shaped and would
 * fight the RSC boundary); gz/tgz gunzip first. All bounded by the caller's
 * size cap so a zip bomb can't OOM the single Next server.
 */

import { gunzipSync, unzipSync } from "fflate";

export interface ArchiveEntry {
  name: string;
  size: number;
  isDir: boolean;
}

export interface ArchiveListing {
  kind: "zip" | "tar" | "gzip";
  entries: ArchiveEntry[];
  truncated: boolean;
}

const MAX_ENTRIES = 5000;

/** Parse a tar buffer's 512-byte headers into entries (USTAR + GNU long-name
 * tolerated by reading the literal `name` field; size is octal at 124). */
function listTar(buf: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const td = new TextDecoder();
  let off = 0;
  while (off + 512 <= buf.length && entries.length < MAX_ENTRIES) {
    const block = buf.subarray(off, off + 512);
    // Two consecutive zero blocks = EOF; cheap check on the first byte run.
    if (block.every((b) => b === 0)) break;
    const name = td.decode(block.subarray(0, 100)).replace(/\0.*$/, "").trim();
    const sizeStr = td.decode(block.subarray(124, 136)).replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeStr, 8) || 0;
    const typeflag = String.fromCharCode(block[156] ?? 0);
    if (name) {
      entries.push({ name, size, isDir: typeflag === "5" || name.endsWith("/") });
    }
    // Advance past the header + the (512-padded) data.
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/**
 * List an archive buffer. `ext` is the lowercased extension (zip/tar/tgz/gz).
 * Throws on a corrupt archive; the route maps that to a render-error/download
 * card so the user still gets the file.
 */
export function listArchive(buf: Uint8Array, ext: string): ArchiveListing {
  if (ext === "zip") {
    const files = unzipSync(buf);
    const entries: ArchiveEntry[] = Object.entries(files)
      .slice(0, MAX_ENTRIES)
      .map(([name, data]) => ({ name, size: data.length, isDir: name.endsWith("/") }));
    return { kind: "zip", entries, truncated: Object.keys(files).length > MAX_ENTRIES };
  }
  if (ext === "tar") {
    const entries = listTar(buf);
    return { kind: "tar", entries, truncated: entries.length >= MAX_ENTRIES };
  }
  // gz / tgz / .tar.gz
  const inflated = gunzipSync(buf);
  // Heuristic: a gunzipped tar starts with a 512-byte header whose bytes
  // 257-262 spell "ustar" for POSIX tars; GNU tars may not, so also accept a
  // plausible octal size field. Fall back to a single-file gz listing.
  const looksTar =
    inflated.length >= 512 &&
    (new TextDecoder().decode(inflated.subarray(257, 262)) === "ustar" ||
      /^[0-7 ]+\0?$/.test(
        new TextDecoder().decode(inflated.subarray(124, 136)).replace(/\0.*$/, "").trim() || "x",
      ));
  if (looksTar) {
    const entries = listTar(inflated);
    if (entries.length > 0)
      return { kind: "tar", entries, truncated: entries.length >= MAX_ENTRIES };
  }
  // Plain single-file gzip.
  return {
    kind: "gzip",
    entries: [{ name: "(decompressed)", size: inflated.length, isDir: false }],
    truncated: false,
  };
}
