/**
 * Pinned driver archive install for `harn computer` (ADRs 0228 and 0231).
 *
 * Every desktop driver ships as a release archive: a `.zip` or a `.tar.gz`.
 * This module downloads one pinned archive, refuses it unless its SHA-256
 * matches the pin, checks its layout, extracts it into a staging directory
 * beside the install directory, writes an install marker, and renames the
 * result into place. A versioned directory without a matching marker is a
 * broken earlier attempt and is replaced.
 *
 * The tar reader is deliberately small: regular files and directories only
 * (ustar, GNU long names, and pax `path` records). Links, devices and FIFOs
 * are refused, so an archive cannot point an extracted path outside the
 * install directory.
 *
 * Internal module: not exported from package.json.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { posix } from "node:path";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { extractZip, listZip, safeEntryPath, type ZipLimits } from "../zip/index.ts";
import type { PinnedArtifact } from "./types.ts";

export const INSTALL_MARKER = ".harnery-install.json";

/** Driver executables are tens of MB each; allow headroom over the zip defaults. */
export const ARCHIVE_LIMITS: ZipLimits = {
  archiveBytes: 256 * 1024 * 1024,
  entryBytes: 160 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  entries: 4096,
};

export interface InstallMarker {
  version: string;
  sha256: string;
  installed_at: string;
}

export interface TarEntry {
  name: string;
  type: "file" | "directory";
  /** Permission bits from the header. */
  mode: number;
  size: number;
  /** Offset of the entry's data in the uncompressed tar. */
  dataOffset: number;
}

function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return Buffer.from(end === -1 ? slice : slice.subarray(0, end)).toString("utf8");
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const slice = block.subarray(offset, offset + length);
  // GNU base-256 encoding for large values: high bit of the first byte set.
  if ((slice[0] ?? 0) & 0x80) {
    let value = (slice[0] ?? 0) & 0x7f;
    for (let i = 1; i < slice.length; i++) value = value * 256 + (slice[i] ?? 0);
    return value;
  }
  const text = readString(block, offset, length).trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) throw new Error(`Corrupt tar header field: ${text}`);
  return value;
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = Buffer.from(data).toString("utf8");
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(i, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, i + length - 1);
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += length;
  }
  return out;
}

/** List a gzip-compressed tar. Throws on links, devices, or a corrupt archive. */
export function listTarGz(
  gz: Uint8Array,
  limits: ZipLimits = ARCHIVE_LIMITS,
): { entries: TarEntry[]; tar: Uint8Array } {
  if (gz.byteLength > limits.archiveBytes)
    throw new Error(`Archive is ${gz.byteLength} bytes, over the ${limits.archiveBytes} limit.`);
  const tar = new Uint8Array(gunzipSync(gz, { maxOutputLength: limits.totalBytes + 1024 * 1024 }));
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;
  let total = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const stored = readOctal(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
    if (sum !== stored) throw new Error(`Corrupt tar header at offset ${offset}.`);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const dataOffset = offset + 512;
    const next = dataOffset + Math.ceil(size / 512) * 512;
    if (dataOffset + size > tar.byteLength) throw new Error("Truncated tar archive.");
    const data = tar.subarray(dataOffset, dataOffset + size);
    if (typeflag === "L") {
      longName = readString(data, 0, data.byteLength);
      offset = next;
      continue;
    }
    if (typeflag === "x") {
      paxPath = parsePax(data).path;
      offset = next;
      continue;
    }
    if (typeflag === "g") {
      offset = next;
      continue;
    }
    const prefix = readString(header, 345, 155);
    const base = readString(header, 0, 100);
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${base}` : base);
    longName = undefined;
    paxPath = undefined;
    const mode = readOctal(header, 100, 8) & 0o777;
    if (typeflag === "0" || typeflag === "\0" || typeflag === "7") {
      if (size > limits.entryBytes)
        throw new Error(
          `Archive entry ${name} is ${size} bytes, over the ${limits.entryBytes} limit.`,
        );
      total += size;
      if (total > limits.totalBytes) throw new Error("Archive expands past the size limit.");
      entries.push({ name, type: "file", mode, size, dataOffset });
    } else if (typeflag === "5") {
      entries.push({
        name: name.replace(/\/+$/, ""),
        type: "directory",
        mode,
        size: 0,
        dataOffset,
      });
    } else {
      throw new Error(
        `Refusing archive entry ${name}: tar type '${typeflag}' is not a file or directory.`,
      );
    }
    if (entries.length > limits.entries) throw new Error("Archive has too many entries.");
    offset = next;
  }
  return { entries, tar };
}

/** Extract a listed tar into `root`, refusing unsafe paths. */
export function extractTar(tar: Uint8Array, entries: TarEntry[], root: string): void {
  mkdirSync(root, { recursive: true });
  for (const entry of entries) {
    if (!entry.name || entry.name === ".") continue;
    const target = safeEntryPath(root, entry.name.replace(/^\.\//, ""));
    if (entry.type === "directory") {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, tar.subarray(entry.dataOffset, entry.dataOffset + entry.size));
    if (process.platform !== "win32") chmodSync(target, entry.mode || 0o644);
  }
}

export function readMarker(installDir: string, p: typeof posix): InstallMarker | undefined {
  try {
    return JSON.parse(readFileSync(p.join(installDir, INSTALL_MARKER), "utf8")) as InstallMarker;
  } catch {
    return undefined;
  }
}

/** True when `installDir` holds this exact pinned archive and `executable` exists. */
export function markerMatches(
  installDir: string,
  executable: string,
  artifact: PinnedArtifact,
  p: typeof posix,
): boolean {
  const marker = readMarker(installDir, p);
  return (
    !!marker &&
    marker.version === artifact.version &&
    marker.sha256 === artifact.sha256 &&
    existsSync(executable)
  );
}

export async function downloadArtifact(
  url: string,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchFn(url, { redirect: "follow" });
  } catch (error) {
    throw new Error(
      `Downloading ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) throw new Error(`Downloading ${url} failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Normalize an archive entry name to forward slashes without a leading `./`. */
function entryName(name: string): string {
  return name.replace(/\\/g, "/").replace(/^\.\//, "");
}

export interface InstallArchiveOptions {
  artifact: PinnedArtifact;
  /** Versioned install directory (caller's path syntax). */
  installDir: string;
  p: typeof posix;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

/**
 * Download, verify, extract and mark one pinned archive. When the artifact
 * names a `topDir`, every entry must sit under it and that directory becomes
 * `installDir`; otherwise the archive root does. Idempotent: a matching marker
 * returns `false` without downloading.
 */
export async function installPinnedArchive(opts: InstallArchiveOptions): Promise<boolean> {
  const { artifact, installDir, p } = opts;
  const executable = p.join(
    installDir,
    ...artifact.executableEntry.split("/").slice(artifact.topDir ? 1 : 0),
  );
  if (markerMatches(installDir, executable, artifact, p)) return false;

  const bytes = await downloadArtifact(artifact.url, opts.fetch);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== artifact.sha256.toLowerCase())
    throw new Error(
      `Refusing ${artifact.fileName}: SHA-256 ${actual} does not match the pinned ${artifact.sha256}. Nothing was installed.`,
    );

  const parent = p.dirname(installDir);
  mkdirSync(parent, { recursive: true });
  const tag = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const archive = p.join(parent, `.download-${tag}`);
  const stage = p.join(parent, `.stage-${tag}`);
  try {
    let names: string[];
    let extract: () => void;
    if (artifact.format === "tar.gz") {
      const { entries, tar } = listTarGz(bytes);
      names = entries.map((e) => entryName(e.name)).filter((n) => n && n !== ".");
      extract = () => extractTar(tar, entries, stage);
    } else {
      writeFileSync(archive, bytes);
      names = listZip(archive, { limits: ARCHIVE_LIMITS }).map((e) => entryName(e.name));
      extract = () => extractZip(archive, stage, { limits: ARCHIVE_LIMITS });
    }
    if (artifact.topDir) {
      const top = artifact.topDir;
      const stray = names.find((n) => n !== top && !n.startsWith(`${top}/`));
      if (stray) throw new Error(`Unexpected entry outside ${top}/ in archive: ${stray}`);
    }
    if (!names.includes(artifact.executableEntry))
      throw new Error(`Archive lacks ${artifact.executableEntry}.`);
    for (const required of artifact.requiredEntries ?? [])
      if (!names.some((n) => n === required || n.startsWith(`${required}/`)))
        throw new Error(`Archive lacks ${required}.`);
    extract();
    const extracted = artifact.topDir ? p.join(stage, artifact.topDir) : stage;
    if (!statSync(extracted).isDirectory()) throw new Error(`Archive lacks ${artifact.topDir}/.`);
    const marker: InstallMarker = {
      version: artifact.version,
      sha256: artifact.sha256,
      installed_at: new Date((opts.now ?? Date.now)()).toISOString(),
    };
    writeFileSync(p.join(extracted, INSTALL_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    if (existsSync(installDir)) rmSync(installDir, { recursive: true, force: true });
    renameSync(extracted, installDir);
  } finally {
    rmSync(archive, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
  return true;
}
