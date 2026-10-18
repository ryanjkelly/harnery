import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { strFromU8, type Zippable, zipSync } from "fflate";

export interface ZipLimits {
  archiveBytes: number;
  entryBytes: number;
  totalBytes: number;
  entries: number;
}
export const DEFAULT_ZIP_LIMITS: Readonly<ZipLimits> = Object.freeze({
  archiveBytes: 64 * 1024 * 1024,
  entryBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  entries: 10_000,
});
export interface ZipEntryInfo {
  name: string;
  size: number;
  compressedSize: number;
  directory: boolean;
  crc32: number;
}
export type ZipSource = string | Uint8Array;
export interface ReadOptions {
  limits?: Partial<ZipLimits>;
}

function limitsFor(options: ReadOptions): ZipLimits {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ZIP limit: ${key}`);
  return limits;
}

function readBoundedFile(path: string, limit: number, noFollow = false): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | (noFollow ? (constants.O_NOFOLLOW ?? 0) : 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit)
      throw new Error("ZIP input exceeds byte limit or is not a file");
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count !== stat.size) throw new Error("ZIP input changed while reading");
    return bytes.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}

function bytesOf(source: ZipSource, limits: ZipLimits): Uint8Array {
  const bytes = typeof source === "string" ? readBoundedFile(source, limits.archiveBytes) : source;
  if (bytes.byteLength > limits.archiveBytes)
    throw new Error("ZIP archive exceeds compressed byte limit");
  return bytes;
}

interface ParsedEntry extends ZipEntryInfo {
  method: number;
  dataOffset: number;
  headerOffset: number;
}

function centralEntries(bytes: Uint8Array, limits: ZipLimits): ParsedEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65_557); end--) {
    if (
      view.getUint32(end, true) === 0x06054b50 &&
      end + 22 + view.getUint16(end + 20, true) === bytes.length
    )
      break;
  }
  if (end < Math.max(0, bytes.length - 65_557)) throw new Error("Missing ZIP end record");
  const count = view.getUint16(end + 10, true);
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== count ||
    count === 0xffff
  )
    throw new Error("Split or ZIP64 archives are unsupported");
  if (count > limits.entries) throw new Error("ZIP archive exceeds entry count limit");
  const central = view.getUint32(end + 16, true);
  let offset = central;
  if (offset + view.getUint32(end + 12, true) !== end)
    throw new Error("Invalid ZIP directory bounds");
  const entries: ParsedEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      throw new Error("Invalid ZIP directory entry");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    if (flags & 1) throw new Error("Encrypted ZIP entries are unsupported");
    if (method !== 0 && method !== 8) throw new Error("Unsupported ZIP compression method");
    const nameLength = view.getUint16(offset + 28, true);
    const next =
      offset +
      46 +
      nameLength +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
    if (next > end || view.getUint16(offset + 34, true) !== 0)
      throw new Error("Invalid ZIP directory entry bounds");
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = strFromU8(rawName, !(flags & 0x800));
    if (names.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    names.add(name);
    const size = view.getUint32(offset + 24, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const checksum = view.getUint32(offset + 16, true);
    const header = view.getUint32(offset + 42, true);
    if (size === 0xffffffff || compressedSize === 0xffffffff || header === 0xffffffff)
      throw new Error("ZIP64 entries are unsupported");
    total += size;
    if (size > limits.entryBytes || total > limits.totalBytes)
      throw new Error("ZIP archive exceeds entry or total byte limit");
    if (header + 30 > central || view.getUint32(header, true) !== 0x04034b50)
      throw new Error("Invalid ZIP local header");
    const localNameLength = view.getUint16(header + 26, true);
    const dataOffset = header + 30 + localNameLength + view.getUint16(header + 28, true);
    if (
      dataOffset + compressedSize > central ||
      localNameLength !== nameLength ||
      view.getUint16(header + 6, true) !== flags ||
      view.getUint16(header + 8, true) !== method ||
      !rawName.every((byte, i) => bytes[header + 30 + i] === byte)
    )
      throw new Error("ZIP local and central header mismatch");
    if (
      !(flags & 8) &&
      (view.getUint32(header + 14, true) !== checksum ||
        view.getUint32(header + 18, true) !== compressedSize ||
        view.getUint32(header + 22, true) !== size)
    )
      throw new Error("ZIP local and central size/checksum mismatch");
    if (method === 0 && compressedSize !== size) throw new Error("Stored ZIP entry size mismatch");
    if (name.endsWith("/") && size !== 0) throw new Error("ZIP directory has a payload");
    entries.push({
      name,
      size,
      compressedSize,
      directory: name.endsWith("/"),
      crc32: checksum,
      method,
      dataOffset,
      headerOffset: header,
    });
    offset = next;
  }
  if (offset !== end) throw new Error("Invalid ZIP directory length");
  const ordered = [...entries].sort((a, b) => a.headerOffset - b.headerOffset);
  for (let i = 1; i < ordered.length; i++)
    if (ordered[i]!.headerOffset < ordered[i - 1]!.dataOffset + ordered[i - 1]!.compressedSize)
      throw new Error("Overlapping ZIP entry ranges");
  return entries;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function inventory(bytes: Uint8Array, limits: ZipLimits): ParsedEntry[] {
  try {
    return centralEntries(bytes, limits);
  } catch (error) {
    throw new Error(
      `Unreadable ZIP archive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function listZip(source: ZipSource, options: ReadOptions = {}): ZipEntryInfo[] {
  const limits = limitsFor(options);
  return inventory(bytesOf(source, limits), limits).map(
    ({ method, dataOffset, headerOffset, ...entry }) => entry,
  );
}

export function readZipEntries(
  source: ZipSource,
  keep: (name: string) => boolean = () => true,
  options: ReadOptions = {},
): Map<string, Uint8Array> {
  const limits = limitsFor(options);
  const bytes = bytesOf(source, limits);
  const selected = inventory(bytes, limits).filter((entry) => !entry.directory && keep(entry.name));
  const result = new Map<string, Uint8Array>();
  for (const entry of selected) {
    const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    // zlib enforces actual output length during decoding, independent of forged headers.
    const data =
      entry.method === 0
        ? compressed.slice()
        : inflateRawSync(compressed, {
            maxOutputLength: Math.max(1, Math.min(entry.size, limits.entryBytes)),
          });
    if (!(data instanceof Uint8Array) || data.byteLength !== entry.size)
      throw new Error(`ZIP entry size or decode mismatch: ${entry.name}`);
    if (crc32(data) !== entry.crc32) throw new Error(`ZIP entry checksum mismatch: ${entry.name}`);
    result.set(entry.name, data);
  }
  return result;
}

export function readZipEntry(
  source: ZipSource,
  name: string,
  options: ReadOptions = {},
): Uint8Array | undefined {
  return readZipEntries(source, (entry) => entry === name, options).get(name);
}

export function readZipText(
  source: ZipSource,
  name: string,
  options: ReadOptions = {},
): string | undefined {
  const bytes = readZipEntry(source, name, options);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

/** Portable names exclude traversal, device names, streams and ambiguous aliases. */
export function safeEntryPath(root: string, name: string): string {
  const normalized = name.replaceAll("\\", "/");
  const parts = normalized.replace(/\/$/, "").split("/");
  if (
    !name ||
    normalized.startsWith("/") ||
    isAbsolute(normalized) ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        [...part].some((character) => character.charCodeAt(0) < 32) ||
        /[:<>"|?*]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  ) {
    throw new Error(`Unsafe ZIP entry path: ${name}`);
  }
  const base = resolve(root);
  const target = resolve(base, ...parts);
  if (!target.startsWith(base.endsWith(sep) ? base : base + sep))
    throw new Error(`ZIP entry escapes destination: ${name}`);
  return target;
}

function statIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const outside = (rel: string): boolean =>
  rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

/**
 * Canonicalize the directory holding a caller-named path. The caller chose
 * that location, so links among its ancestors (macOS /tmp and /var, a linked
 * home directory) are resolved once here. The named path itself and everything
 * below it stay subject to assertNoLinks, which is where a planted link could
 * redirect a write. Missing directories are appended unresolved and checked
 * again once they exist.
 */
function anchored(path: string): { anchor: string; path: string } {
  const named = resolve(path);
  const missing = [basename(named)];
  let existing = dirname(named);
  while (!statIfPresent(existing) && dirname(existing) !== existing) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  const anchor = realpathSync(existing);
  return { anchor, path: join(anchor, ...missing) };
}

/**
 * Inspect every existing component from the path up to, not including, its
 * anchor, including a dangling link at the final path.
 */
function assertNoLinks(path: string, leaf: "file" | "directory", anchor: string): void {
  let current = resolve(path);
  if (outside(relative(anchor, current)))
    throw new Error(`ZIP path is outside its anchored directory: ${current}`);
  let first = true;
  while (current !== anchor) {
    const stat = statIfPresent(current);
    if (stat) {
      if (stat.isSymbolicLink())
        throw new Error(`Refusing ZIP path through a symbolic link: ${current}`);
      if ((!first || leaf === "directory") && !stat.isDirectory())
        throw new Error(`ZIP directory path is not a directory: ${current}`);
      if (first && leaf === "file" && !stat.isFile())
        throw new Error(`ZIP output is not a regular file: ${current}`);
    }
    current = dirname(current);
    first = false;
  }
}

function writeAtomic(path: string, bytes: Uint8Array, overwrite: boolean, anchor: string): void {
  assertNoLinks(path, "file", anchor);
  if (!overwrite && statIfPresent(path)) throw new Error(`ZIP output already exists: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  assertNoLinks(dirname(path), "directory", anchor);
  const temp = join(dirname(path), `.zip-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fd, bytes);
    closeSync(fd);
    fd = undefined;
    assertNoLinks(path, "file", anchor);
    if (overwrite) renameSync(temp, path);
    else {
      linkSync(temp, path);
      unlinkSync(temp);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (statIfPresent(temp)) unlinkSync(temp);
  }
}

export interface ExtractOptions extends ReadOptions {
  overwrite?: boolean;
  filter?: (name: string) => boolean;
}

/** Preflight all selected names, collisions and existing filesystem paths before writing. */
export function extractZip(
  source: ZipSource,
  dest: string,
  options: ExtractOptions = {},
): string[] {
  const limits = limitsFor(options);
  const bytes = bytesOf(source, limits);
  const entries = inventory(bytes, limits).filter((entry) =>
    (options.filter ?? (() => true))(entry.name),
  );
  const { anchor, path: root } = anchored(dest);
  assertNoLinks(root, "directory", anchor);
  const targets = new Map<string, boolean>();
  for (const entry of entries) {
    const target = safeEntryPath(root, entry.name);
    const key = target.toLowerCase();
    if (targets.has(key)) throw new Error(`Colliding ZIP entry: ${entry.name}`);
    targets.set(key, entry.directory);
    assertNoLinks(target, entry.directory ? "directory" : "file", anchor);
    if (!entry.directory && !options.overwrite && statIfPresent(target))
      throw new Error(`ZIP output already exists: ${target}`);
  }
  for (const target of targets.keys()) {
    let parent = dirname(target);
    while (parent !== dirname(parent)) {
      if (targets.get(parent) === false) throw new Error(`ZIP file/directory collision: ${parent}`);
      parent = dirname(parent);
    }
  }
  const selected = new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.name));
  const files = readZipEntries(bytes, (name) => selected.has(name), options);
  mkdirSync(root, { recursive: true });
  for (const entry of entries) {
    if (entry.directory) {
      const path = safeEntryPath(root, entry.name);
      assertNoLinks(path, "directory", anchor);
      mkdirSync(path, { recursive: true });
    }
  }
  for (const [name, data] of files)
    writeAtomic(safeEntryPath(root, name), data, options.overwrite ?? false, anchor);
  return [...files.keys()];
}

export interface CreateOptions extends ReadOptions {
  base?: string;
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  overwrite?: boolean;
}

export function buildZip(
  inputs: readonly string[],
  options: CreateOptions = {},
): { bytes: Uint8Array; entries: string[] } {
  const limits = limitsFor(options);
  // Inputs are matched against the base as the caller spelled it; reads go
  // through its anchored form.
  const named = resolve(options.base ?? ".");
  const { anchor, path: base } = anchored(named);
  assertNoLinks(base, "directory", anchor);
  const tree: Zippable = Object.create(null);
  const entries: string[] = [];
  const names = new Set<string>();
  let total = 0;
  const add = (input: string): void => {
    const rel = relative(named, resolve(named, input));
    if (!rel || outside(rel)) throw new Error(`ZIP input is outside its base directory: ${input}`);
    const path = join(base, rel);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing ZIP input symbolic link: ${input}`);
    assertNoLinks(path, stat.isDirectory() ? "directory" : "file", anchor);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) add(join(named, rel, name));
      return;
    }
    if (!stat.isFile()) throw new Error(`ZIP input is not a regular file: ${input}`);
    const name = rel.split(sep).join("/");
    safeEntryPath(base, name);
    if (Object.hasOwn(tree, name)) return;
    if (names.has(name.toLowerCase())) throw new Error(`Colliding ZIP input: ${name}`);
    total += stat.size;
    if (
      stat.size > limits.entryBytes ||
      total > limits.totalBytes ||
      entries.length >= limits.entries
    )
      throw new Error("ZIP inputs exceed size or entry count limit");
    const bytes = readBoundedFile(path, Math.min(stat.size, limits.entryBytes), true);
    if (bytes.byteLength !== stat.size) throw new Error(`ZIP input changed while reading: ${name}`);
    names.add(name.toLowerCase());
    tree[name] = [bytes, { mtime: stat.mtime }];
    entries.push(name);
  };
  for (const input of [...inputs].sort()) add(input);
  if (!entries.length) throw new Error("Nothing to ZIP: inputs contain no files");
  const bytes = zipSync(tree, { level: options.level ?? 6 });
  if (bytes.byteLength > limits.archiveBytes)
    throw new Error("ZIP archive exceeds compressed byte limit");
  return { bytes, entries };
}

export function createZip(
  archive: string,
  inputs: readonly string[],
  options: CreateOptions = {},
): string[] {
  const { anchor, path } = anchored(archive);
  assertNoLinks(path, "file", anchor);
  if (!options.overwrite && statIfPresent(path))
    throw new Error(`ZIP output already exists: ${archive}`);
  const result = buildZip(inputs, options);
  writeAtomic(path, result.bytes, options.overwrite ?? false, anchor);
  return result.entries;
}
