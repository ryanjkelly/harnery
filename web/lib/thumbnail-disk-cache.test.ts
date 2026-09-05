import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __setThumbnailDiskTestHooks,
  readThumbnailDisk,
  writeThumbnailDisk,
} from "./thumbnail-disk-cache";

let root: string;
let outside: string;
const key = "a".repeat(64);
const bytes = Buffer.from("RIFFxxxxWEBPthumbnail");
const leaf = () => path.join(root, ".harnery/cache/file-thumbnails");
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "thumbnail-disk-"));
  outside = mkdtempSync(path.join(tmpdir(), "thumbnail-outside-"));
});
afterEach(() => {
  __setThumbnailDiskTestHooks();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("disk cache persists private images and validates keys", async () => {
  await writeThumbnailDisk(root, key, bytes);
  expect(await readThumbnailDisk(root, key)).toEqual(bytes);
  expect(statSync(leaf()).mode & 0o777).toBe(0o700);
  expect(statSync(path.join(leaf(), `${key}.webp`)).mode & 0o777).toBe(0o600);
  expect(await readThumbnailDisk(root, "../outside")).toBeNull();
});

linuxTest("cache creation rejects a symlink at every intermediate component", async () => {
  for (const parts of [
    [".harnery"],
    [".harnery", "cache"],
    [".harnery", "cache", "file-thumbnails"],
  ]) {
    const candidate = path.join(root, String(parts.length));
    mkdirSync(candidate);
    mkdirSync(path.join(candidate, ...parts.slice(0, -1)), { recursive: true });
    symlinkSync(outside, path.join(candidate, ...parts));
    await writeThumbnailDisk(candidate, key, bytes);
    expect(await readThumbnailDisk(candidate, key)).toBeNull();
  }
  expect(readdirSync(outside)).toEqual([]);
});

linuxTest(
  "a directory swap cannot redirect writes or pruning outside the checked inode",
  async () => {
    await writeThumbnailDisk(root, key, bytes);
    const survivor = path.join(outside, `${"b".repeat(64)}.webp`);
    writeFileSync(survivor, "external");
    utimesSync(survivor, 1, 1);
    __setThumbnailDiskTestHooks({
      afterDirectoryOpen: () => {
        __setThumbnailDiskTestHooks();
        renameSync(leaf(), `${leaf()}.original`);
        symlinkSync(outside, leaf());
      },
    });
    await writeThumbnailDisk(root, "c".repeat(64), bytes);
    expect(readFileSync(survivor, "utf8")).toBe("external");
    expect(existsSync(path.join(outside, `${"c".repeat(64)}.webp`))).toBe(false);
    expect(existsSync(path.join(`${leaf()}.original`, `${"c".repeat(64)}.webp`))).toBe(true);
  },
);

linuxTest("a directory swap cannot redirect cache reads", async () => {
  await writeThumbnailDisk(root, key, bytes);
  writeFileSync(path.join(outside, `${key}.webp`), Buffer.from("RIFFxxxxWEBPexternal"));
  __setThumbnailDiskTestHooks({
    afterDirectoryOpen: () => {
      __setThumbnailDiskTestHooks();
      renameSync(leaf(), `${leaf()}.original`);
      symlinkSync(outside, leaf());
    },
  });
  expect(await readThumbnailDisk(root, key)).toEqual(bytes);
});

linuxTest("growth after the file stat is rejected after a bounded read", async () => {
  await writeThumbnailDisk(root, key, bytes);
  __setThumbnailDiskTestHooks({
    afterReadStat: () => {
      truncateSync(path.join(leaf(), `${key}.webp`), 32 * 1024 * 1024);
    },
  });
  expect(await readThumbnailDisk(root, key)).toBeNull();
});

linuxTest("oversized, expired, invalid, and symlinked entries cannot be read", async () => {
  await writeThumbnailDisk(root, key, bytes);
  const target = path.join(leaf(), `${key}.webp`);
  utimesSync(target, 1, 1);
  expect(await readThumbnailDisk(root, key)).toBeNull();
  writeFileSync(target, "not an image");
  expect(await readThumbnailDisk(root, key)).toBeNull();
  truncateSync(target, 512 * 1024 + 1);
  expect(await readThumbnailDisk(root, key)).toBeNull();
  rmSync(target);
  const external = path.join(outside, "image");
  writeFileSync(external, bytes);
  symlinkSync(external, target);
  expect(await readThumbnailDisk(root, key)).toBeNull();
});

linuxTest("writes prune the cache to 1000 entries without following file symlinks", async () => {
  await writeThumbnailDisk(root, key, bytes);
  for (let i = 0; i < 1001; i++)
    writeFileSync(path.join(leaf(), `${i.toString(16).padStart(64, "0")}.webp`), bytes);
  await writeThumbnailDisk(root, "f".repeat(64), bytes);
  expect(readdirSync(leaf()).filter((name) => name.endsWith(".webp"))).toHaveLength(1000);
});

linuxTest("writes reserve space below 128 MiB before publishing an image", async () => {
  await writeThumbnailDisk(root, key, bytes);
  for (let i = 0; i < 257; i++) {
    const filename = path.join(leaf(), `${i.toString(16).padStart(64, "0")}.webp`);
    writeFileSync(filename, bytes);
    truncateSync(filename, 512 * 1024);
  }
  await writeThumbnailDisk(root, "f".repeat(64), bytes);
  const total = readdirSync(leaf()).reduce(
    (sum, name) => sum + statSync(path.join(leaf(), name)).size,
    0,
  );
  expect(total).toBeLessThanOrEqual(128 * 1024 * 1024);
  expect(await readThumbnailDisk(root, "f".repeat(64))).toEqual(bytes);
});
