import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import path from "node:path";

const MAX_OUTPUT = 512 * 1024;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_SCAN = 4096;
const MAX_AGE = 7 * 86400_000;
const KEY = /^[a-f0-9]{64}$/;
const FILE = /^[a-f0-9]{64}\.webp$/;
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

type Hooks = {
  afterDirectoryOpen?: () => void | Promise<void>;
  afterReadStat?: () => void | Promise<void>;
};
let hooks: Hooks | undefined;
export function __setThumbnailDiskTestHooks(value?: Hooks): void {
  hooks = value;
}

const anchored = (directory: FileHandle, name: string) => `/proc/self/fd/${directory.fd}/${name}`;
function same(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

/** Linux provides directory-fd paths; other platforms use the memory cache only. */
async function directory(root: string, create: boolean): Promise<FileHandle | null> {
  if (process.platform !== "linux" || !path.isAbsolute(root)) return null;
  let current: FileHandle | undefined;
  try {
    current = await open(root, DIRECTORY);
    for (const component of [".harnery", "cache", "file-thumbnails"]) {
      const target = anchored(current, component);
      if (create)
        await mkdir(target, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      const next = await open(target, DIRECTORY);
      await current.close();
      current = next;
    }
    const info = await current.stat();
    // A shared cache could be replaced by another OS user; don't trust its images.
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      await current.close();
      return null;
    }
    await hooks?.afterDirectoryOpen?.();
    return current;
  } catch {
    await current?.close().catch(() => {});
    return null;
  }
}

export async function readThumbnailDisk(root: string, key: string): Promise<Buffer | null> {
  if (!KEY.test(key)) return null;
  const dir = await directory(root, false);
  if (!dir) return null;
  let file: FileHandle | undefined;
  try {
    file = await open(
      anchored(dir, `${key}.webp`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.size < 12 ||
      before.size > MAX_OUTPUT ||
      Date.now() - before.mtimeMs > MAX_AGE
    )
      return null;
    await hooks?.afterReadStat?.();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) return null;
      offset += result.bytesRead;
    }
    if (!same(before, await file.stat())) return null;
    if (bytes.subarray(0, 4).toString() !== "RIFF" || bytes.subarray(8, 12).toString() !== "WEBP")
      return null;
    return bytes;
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
    await dir.close().catch(() => {});
  }
}

/** Reserve space before the atomic rename. All names stay beneath the checked fd. */
async function reserve(dir: FileHandle, key: string, bytes: number): Promise<boolean> {
  const iterator = await opendir(anchored(dir, "."));
  const entries: Array<{ name: string; size: number; time: number }> = [];
  let scanned = 0;
  for await (const entry of iterator) {
    if (++scanned > MAX_SCAN) return false;
    if (!FILE.test(entry.name)) continue;
    const info = await lstat(anchored(dir, entry.name)).catch(() => null);
    if (!info?.isFile()) continue;
    if (entry.name === `${key}.webp`) continue;
    entries.push({ name: entry.name, size: info.size, time: info.mtimeMs });
  }
  entries.sort((a, b) => b.time - a.time);
  let retained = 1;
  let retainedBytes = bytes;
  for (const entry of entries) {
    if (
      retained >= MAX_ENTRIES ||
      retainedBytes + entry.size > MAX_BYTES ||
      Date.now() - entry.time > MAX_AGE ||
      entry.size > MAX_OUTPUT
    ) {
      // unlink never follows a final symlink and cannot recursively remove directories.
      await unlink(anchored(dir, entry.name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    } else {
      retained++;
      retainedBytes += entry.size;
    }
  }
  return true;
}

let writeTail: Promise<void> = Promise.resolve();
export function writeThumbnailDisk(root: string, key: string, bytes: Buffer): Promise<void> {
  if (!KEY.test(key) || bytes.length > MAX_OUTPUT) return Promise.resolve();
  // One writer keeps the per-process reservation bound exact; readers never wait here.
  const work = writeTail.then(async () => {
    const dir = await directory(root, true);
    if (!dir) return;
    const temp = `${key}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let output: FileHandle | undefined;
    try {
      if (!(await reserve(dir, key, bytes.length))) return;
      output = await open(
        anchored(dir, temp),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await output.writeFile(bytes);
      await output.close();
      output = undefined;
      await rename(anchored(dir, temp), anchored(dir, `${key}.webp`));
    } catch {
      /* Cache failure must not fail a generated preview. */
    } finally {
      await output?.close().catch(() => {});
      await unlink(anchored(dir, temp)).catch(() => {});
      await dir.close().catch(() => {});
    }
  });
  writeTail = work.catch(() => {});
  return writeTail;
}
