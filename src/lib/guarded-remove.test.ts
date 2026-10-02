import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedRemove } from "./guarded-remove.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harnery-rm-")));
  roots.push(root);
  const file = join(root, "output.mp4");
  writeFileSync(file, "output");
  return { root, file };
}

test("previews by default and dry-run wins over yes", () => {
  const { root, file } = fixture();
  expect(guardedRemove([file], { root })).toMatchObject({ applied: false, entries: 1, bytes: 6 });
  expect(guardedRemove([file], { root, yes: true, dryRun: true }).applied).toBe(false);
  expect(existsSync(file)).toBe(true);
  expect(guardedRemove([file], { root, yes: true }).applied).toBe(true);
  expect(existsSync(file)).toBe(false);
});

test("refuses empty paths, unresolved variables, globs, missing paths and unsafe roots", () => {
  const { root, file } = fixture();
  for (const path of ["", " ", "$missing/output", join(root, "*.mp4"), join(root, "missing")])
    expect(() => guardedRemove([path], { root, yes: true })).toThrow();
  for (const boundary of ["", "/", file])
    expect(() => guardedRemove([file], { root: boundary, yes: true })).toThrow();
  expect(existsSync(file)).toBe(true);
});

test("refuses scope root, sibling prefix, traversal and overlapping batches", () => {
  const { root, file } = fixture();
  const outside = fixture();
  for (const paths of [
    [root],
    [outside.file],
    [join(root, "..", outside.root.split("/").pop()!, "output.mp4")],
    [file, file],
  ])
    expect(() => guardedRemove(paths, { root, recursive: true, yes: true })).toThrow();
  expect(existsSync(file)).toBe(true);
  expect(existsSync(outside.file)).toBe(true);
});

test("refuses working directory and ancestors", () => {
  const { root } = fixture();
  const cwd = process.cwd();
  const work = join(root, "work");
  mkdirSync(work);
  try {
    process.chdir(work);
    expect(() => guardedRemove([work], { root, recursive: true, yes: true })).toThrow(
      "working directory",
    );
  } finally {
    process.chdir(cwd);
  }
});

test("requires recursive and inspects complete directories", () => {
  const { root } = fixture();
  const dir = join(root, "render");
  mkdirSync(dir);
  writeFileSync(join(dir, "frame.png"), "frame");
  expect(() => guardedRemove([dir], { root, yes: true })).toThrow("--recursive");
  expect(guardedRemove([dir], { root, recursive: true, yes: true }).entries).toBe(2);
  expect(existsSync(dir)).toBe(false);
});

test("refuses symlinks at target, ancestor and inside recursive tree", () => {
  const { root, file } = fixture();
  const outside = fixture();
  const alias = join(root, "alias");
  symlinkSync(outside.root, alias);
  for (const target of [alias, join(alias, "output.mp4")])
    expect(() => guardedRemove([target], { root, recursive: true, yes: true })).toThrow("symlink");
  const dir = join(root, "render");
  mkdirSync(dir);
  symlinkSync(file, join(dir, "link"));
  expect(() => guardedRemove([dir], { root, recursive: true, yes: true })).toThrow("Symlink");
  expect(existsSync(outside.file)).toBe(true);
});

test("protects state and nested repository metadata", () => {
  const { root, file } = fixture();
  for (const name of [".git", ".harnery", ".credentials", ".ssh", ".gnupg"]) {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "data"), "important");
    expect(() => guardedRemove([join(dir, "data")], { root, yes: true })).toThrow("Protected");
  }
  const nested = join(root, "nested");
  mkdirSync(nested);
  writeFileSync(join(nested, ".git"), "gitdir: elsewhere");
  expect(() => guardedRemove([nested], { root, recursive: true, yes: true })).toThrow("Protected");
  expect(existsSync(file)).toBe(true);
});

test("protects bare repositories and case variants of metadata", () => {
  const { root } = fixture();
  const bare = join(root, "bare");
  expect(spawnSync("git", ["init", "--bare", "-q", bare]).status).toBe(0);
  expect(() => guardedRemove([bare], { root, recursive: true, yes: true })).toThrow(
    "Repository metadata",
  );
  const dir = join(root, "output");
  mkdirSync(dir);
  mkdirSync(join(dir, ".GIT"));
  expect(() => guardedRemove([dir], { root, recursive: true, yes: true })).toThrow("Protected");
});

test("protects tracked files and directories that contain them, including deleted staged paths", () => {
  const { root, file } = fixture();
  expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "add", "--", file]).status).toBe(0);
  const dir = join(root, "source");
  mkdirSync(dir);
  writeFileSync(join(dir, "index.ts"), "source");
  expect(spawnSync("git", ["-C", root, "add", "source"]).status).toBe(0);
  for (const path of [file, dir])
    expect(() => guardedRemove([path], { root, recursive: true, yes: true })).toThrow(
      "Tracked files",
    );
  const output = join(root, "render.tmp");
  writeFileSync(output, "generated");
  expect(guardedRemove([output], { root, yes: true }).applied).toBe(true);
});

test("preflights all targets before mutation", () => {
  const { root, file } = fixture();
  expect(() => guardedRemove([file, join(root, "missing")], { root, yes: true })).toThrow();
  expect(existsSync(file)).toBe(true);
});

test("rechecks file changes and peer claims before applying", () => {
  const { root, file } = fixture();
  expect(() =>
    guardedRemove([file], { root, yes: true }, () => writeFileSync(file, "changed")),
  ).toThrow("changed");
  let calls = 0;
  expect(() =>
    guardedRemove([file], { root, yes: true }, () => {
      if (++calls === 2) throw new Error("peer claimed it");
    }),
  ).toThrow("peer claimed");
  expect(existsSync(file)).toBe(true);
});

test("refuses entries added after inspection", () => {
  const { root } = fixture();
  const dir = join(root, "render");
  mkdirSync(dir);
  expect(() =>
    guardedRemove([dir], { root, recursive: true, yes: true }, () =>
      writeFileSync(join(dir, "late"), "retain"),
    ),
  ).toThrow("changed");
  expect(existsSync(join(dir, "late"))).toBe(true);
});
