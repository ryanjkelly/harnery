import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskUsage, parseDiskSize } from "./disk-usage.ts";

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "harnery-disk-"));
  fixtures.push(dir);
  return dir;
}
function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}
function init(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
}
function put(root: string, path: string, bytes: number): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), Buffer.alloc(bytes));
}

describe("checkout disk usage", () => {
  test("classifies tracked, untracked, ignored, metadata, and nested repository files", () => {
    const root = fixture();
    init(root);
    writeFileSync(join(root, ".gitignore"), "*.mp4\nscratch/\n");
    put(root, "tracked.mp4", 10);
    git(root, "add", "-f", "tracked.mp4", ".gitignore");
    put(root, "not tracked.txt", 20);
    put(root, "ignored.mp4", 30);
    const nested = join(root, "scratch", "nested");
    init(nested);
    put(
      nested,
      process.platform === "win32" ? "tracked file name.txt" : "tracked file\nname.txt",
      40,
    );
    git(nested, "add", ".");
    put(nested, "new.txt", 50);
    const report = diskUsage(root, { apparent: true, group: "git" });
    expect(report.complete).toBe(true);
    expect(report.git.tracked.files).toBe(3);
    expect(report.git.untracked.files).toBe(2);
    expect(report.git.ignored.files).toBe(1);
    expect(report.git["git-metadata"].files).toBeGreaterThan(0);
    expect(report.repositories).toEqual([".", "scratch/nested"]);
    expect(
      diskUsage(root, { git: "tracked", type: "mp4", apparent: true }).totals.apparent_bytes,
    ).toBe(10);
    expect(diskUsage(root, { git: "ignored", apparent: true }).totals.apparent_bytes).toBe(30);
    expect(
      diskUsage(root, { git: "tracked,untracked", type: "txt", apparent: true }).totals
        .apparent_bytes,
    ).toBe(110);
    // Starting below the Git root must still use its index and ignore rules.
    expect(
      diskUsage(join(root, "scratch"), { git: "tracked", apparent: true }).totals.apparent_bytes,
    ).toBe(40);
  });

  test("uses a submodule's index rather than its parent's gitlink", () => {
    const source = fixture();
    init(source);
    put(source, "asset.txt", 123);
    git(source, "add", ".");
    git(
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "fixture",
    );
    const root = fixture();
    init(root);
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "module");
    put(join(root, "module"), "new.txt", 77);
    const report = diskUsage(root, {
      git: "tracked",
      type: "txt",
      apparent: true,
      group: "repository",
    });
    expect(report.totals.apparent_bytes).toBe(123);
    expect(report.groups[0]?.path).toBe("module");
    expect(
      diskUsage(root, { git: "untracked", type: "txt", apparent: true }).totals.apparent_bytes,
    ).toBe(77);
  });

  test("exclusions prune whole trees while depth only changes grouping", () => {
    const root = fixture();
    put(root, "a/deep/one.mp4", 100);
    put(root, "a/deep/two.wav", 200);
    put(root, "a/node_modules/big.mp4", 900);
    put(root, "b/node_modules/big.mp4", 900);
    put(root, "b/skip/image.png", 800);
    put(root, "b/image.png", 300);
    const report = diskUsage(root, {
      exclude: ["node_modules", "b/skip"],
      type: "media",
      group: "directory",
      depth: 1,
      apparent: true,
    });
    expect(report.totals.apparent_bytes).toBe(600);
    expect(report.groups.map((row) => row.path)).toEqual(["a", "b"]);
    expect(report.skipped.excluded).toBe(3);
    expect(
      diskUsage(root, { exclude: ["node_modules,b/skip"], depth: 3, apparent: true }).totals
        .apparent_bytes,
    ).toBe(600);
    expect(
      diskUsage(root, { exclude: ["node_modules,b/skip"], type: ".mp4,.wav", apparent: true })
        .totals.apparent_bytes,
    ).toBe(300);
  });

  test("counts hard-linked disk allocation once but preserves apparent file lengths", () => {
    const root = fixture();
    put(root, "a.bin", 12345);
    linkSync(join(root, "a.bin"), join(root, "b.bin"));
    const report = diskUsage(root);
    expect(report.totals.files).toBe(2);
    expect(report.totals.apparent_bytes).toBe(24690);
    if (process.platform !== "win32")
      expect(report.totals.allocated_bytes).toBe(lstatSync(join(root, "a.bin")).blocks * 512);
    expect(report.groups.reduce((n, row) => n + (row.allocated_bytes ?? 0), 0)).toBe(
      report.totals.allocated_bytes ?? 0,
    );
  });

  test("reports sparse allocation and applies size thresholds to the selected metric", () => {
    const root = fixture();
    const path = join(root, "sparse.bin");
    closeSync(openSync(path, "w"));
    truncateSync(path, 32 * 1024 * 1024);
    const apparent = diskUsage(root, { apparent: true, minSize: 1e6 });
    expect(apparent.totals.files).toBe(1);
    expect(apparent.totals.apparent_bytes).toBe(32 * 1024 * 1024);
    if (process.platform !== "win32" && lstatSync(path).blocks * 512 < 1e6)
      expect(diskUsage(root, { minSize: 1e6 }).totals.files).toBe(0);
  });

  test("never follows symlinks and returns bounded largest-file and grouping lists", () => {
    const root = fixture();
    const outside = fixture();
    put(outside, "large.txt", 1000);
    put(root, "small.txt", 10);
    put(root, "big.txt", 20);
    put(root, "middle.txt", 15);
    symlinkSync(outside, join(root, "link"), "dir");
    const report = diskUsage(root, { apparent: true, top: 2, group: "files" });
    expect(report.totals.apparent_bytes).toBe(45);
    expect(report.group_count).toBe(3);
    expect(report.groups.map((row) => row.path)).toEqual(["big.txt", "middle.txt"]);
    expect(report.skipped.symlinks).toBe(1);
    expect(() => diskUsage(join(root, "link"))).toThrow("symlink");
  });

  test("invalid nested Git markers produce an incomplete scan rather than guessed ignored state", () => {
    const root = fixture();
    mkdirSync(join(root, ".git"));
    put(root, "file.txt", 20);
    const report = diskUsage(root, { type: "txt", apparent: true });
    expect(report.complete).toBe(false);
    expect(report.git.unknown.files).toBe(1);
    expect(report.git.ignored.files).toBe(0);
    expect(report.issues.length).toBeGreaterThan(0);
  });

  test("rejects invalid options and parses decimal and binary size units", () => {
    const root = fixture();
    expect(parseDiskSize("10MB")).toBe(10_000_000);
    expect(parseDiskSize("1.5GiB")).toBe(1610612736);
    expect(() => parseDiskSize("10watts")).toThrow();
    expect(() => diskUsage(root, { git: "trackd" })).toThrow("--git");
    expect(() => diskUsage(root, { depth: 0 })).toThrow("--depth");
    expect(() => diskUsage(root, { top: -1 })).toThrow("--top");
    expect(() => diskUsage(root, { exclude: ["../outside"] })).toThrow("--exclude");
    expect(() => diskUsage(root, { exclude: ["/outside"] })).toThrow("--exclude");
  });
});
