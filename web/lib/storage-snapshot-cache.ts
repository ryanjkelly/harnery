import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const MAX_BYTES = 4 * 1024 * 1024;
export const STORAGE_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function storageSnapshotPath(root: string): string {
  return join(root, ".harnery", "cache", "storage-footprint", "snapshot.json");
}

/** One bounded, disposable display snapshot. It never authorizes maintenance. */
export async function readStorageSnapshot(
  root: string,
  key: string,
  now: number,
): Promise<{ savedAt: number; inventory: unknown } | null> {
  let file: FileHandle | undefined;
  try {
    file = await open(
      storageSnapshotPath(root),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    const envelope = JSON.parse(bytes.toString("utf8"));
    if (
      envelope.version !== 1 ||
      envelope.key !== key ||
      !Number.isFinite(envelope.savedAt) ||
      envelope.savedAt > now ||
      now - envelope.savedAt > STORAGE_SNAPSHOT_MAX_AGE_MS ||
      typeof envelope.body !== "string" ||
      digest(envelope.body) !== envelope.sha256
    )
      return null;
    return { savedAt: envelope.savedAt, inventory: JSON.parse(envelope.body) };
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}

export async function writeStorageSnapshot(
  root: string,
  key: string,
  savedAt: number,
  inventory: unknown,
): Promise<void> {
  let temporary: string | undefined;
  try {
    const body = JSON.stringify(inventory);
    const bytes = JSON.stringify({ version: 1, key, savedAt, body, sha256: digest(body) });
    if (Buffer.byteLength(bytes) > MAX_BYTES) return;
    let directory = root;
    for (const part of [".harnery", "cache", "storage-footprint"]) {
      directory = join(directory, part);
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      if (!(await lstat(directory)).isDirectory()) return;
    }
    const target = storageSnapshotPath(root);
    temporary = join(directory, `.snapshot-${process.pid}-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    await rename(temporary, target);
  } catch {
    // A read-only/full cache directory must never make the fresh report fail.
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
  }
}
