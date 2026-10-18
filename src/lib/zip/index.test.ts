import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import {
  buildZip,
  createZip,
  extractZip,
  listZip,
  readZipEntry,
  readZipText,
  safeEntryPath,
} from "./index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zip-test-"));
  roots.push(root);
  return root;
}
function archive(files: Record<string, string>) {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])),
  );
}

test("create/list/read/extract round-trip preserves bytes and sorted names", () => {
  const root = fixture();
  mkdirSync(join(root, "input"));
  writeFileSync(join(root, "input", "b.txt"), "second");
  writeFileSync(join(root, "input", "a.txt"), "first");
  const zip = join(root, "result.zip");
  expect(createZip(zip, ["input"], { base: root })).toEqual(["input/a.txt", "input/b.txt"]);
  expect(listZip(zip).map((entry) => entry.name)).toEqual(["input/a.txt", "input/b.txt"]);
  expect(readZipText(zip, "input/a.txt")).toBe("first");
  expect(readZipEntry(zip, "absent")).toBeUndefined();
  expect(extractZip(zip, join(root, "out"))).toHaveLength(2);
  expect(readFileSync(join(root, "out", "input", "b.txt"), "utf8")).toBe("second");
});

test("rejects existing symlink ancestors, targets, dangling links and destination roots before writing", () => {
  for (const kind of ["ancestor", "target", "dangling", "root"]) {
    const root = fixture();
    const dest = join(root, "out");
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "protected.txt"), "original");
    if (kind === "root") symlinkSync(outside, dest, "dir");
    else mkdirSync(dest);
    let name = "protected.txt";
    if (kind === "ancestor") {
      symlinkSync(outside, join(dest, "link"), "dir");
      name = "link/protected.txt";
    }
    if (kind === "target") symlinkSync(join(outside, "protected.txt"), join(dest, name));
    if (kind === "dangling") symlinkSync(join(outside, "missing.txt"), join(dest, name));
    const zip = archive({ "first.txt": "must not write", [name]: "changed" });
    expect(() => extractZip(zip, dest, { overwrite: true })).toThrow("symbolic link");
    expect(existsSync(join(dest, "first.txt"))).toBe(false);
    expect(readFileSync(join(outside, "protected.txt"), "utf8")).toBe("original");
    expect(existsSync(join(outside, "missing.txt"))).toBe(false);
  }
});

test("overwriting replaces a hard link without changing its other names", () => {
  const root = fixture();
  const outside = join(root, "original.txt");
  const dest = join(root, "out");
  mkdirSync(dest);
  writeFileSync(outside, "original");
  linkSync(outside, join(dest, "file.txt"));
  const zip = archive({ "file.txt": "replacement" });
  expect(() => extractZip(zip, dest)).toThrow("already exists");
  extractZip(zip, dest, { overwrite: true });
  expect(readFileSync(join(dest, "file.txt"), "utf8")).toBe("replacement");
  expect(readFileSync(outside, "utf8")).toBe("original");
});

test("traversal and cross-platform ambiguous names are rejected", () => {
  const root = fixture();
  for (const name of [
    "../escape",
    "a/../escape",
    "/absolute",
    "C:\\escape",
    "a\\..\\escape",
    "a//b",
    "file:stream",
    "CON.txt",
    "file.",
    "file ",
    "./file",
    "a\0b",
    "",
  ]) {
    expect(() => safeEntryPath(root, name)).toThrow("Unsafe");
  }
  expect(safeEntryPath(root, "folder/file.txt")).toBe(join(root, "folder", "file.txt"));
});

test("case collisions and file/directory conflicts fail before any output", () => {
  const cases: Record<string, string>[] = [
    { A: "one", a: "two" },
    { a: "one", "a/b": "two" },
  ];
  for (const files of cases) {
    const root = fixture();
    const dest = join(root, "out");
    expect(() => extractZip(archive(files), dest)).toThrow(/collision|Colliding/);
    expect(existsSync(dest)).toBe(false);
  }
  const root = fixture();
  const dest = join(root, "out");
  mkdirSync(dest);
  writeFileSync(join(dest, "folder"), "file");
  expect(() => extractZip(archive({ first: "untouched", "folder/child": "bad" }), dest)).toThrow(
    "not a directory",
  );
  expect(existsSync(join(dest, "first"))).toBe(false);
});

test("compressed, entry, total and count limits are enforced before extraction", () => {
  const root = fixture();
  const bytes = archive({ a: "1234", b: "1234" });
  const dest = join(root, "out");
  for (const limits of [
    { archiveBytes: 1 },
    { entryBytes: 3 },
    { totalBytes: 7 },
    { entries: 1 },
  ]) {
    expect(() => extractZip(bytes, dest, { limits })).toThrow(/limit/);
    expect(existsSync(dest)).toBe(false);
  }
  expect(() => listZip(bytes, { limits: { entries: 0 } })).toThrow("Invalid ZIP limit");
});

test("malformed and checksum-damaged archives fail without partial output", () => {
  const root = fixture();
  const dest = join(root, "out");
  expect(() => extractZip(strToU8("not a zip"), dest)).toThrow("Unreadable");
  const bytes = archive({ file: "payload" });
  const damaged = bytes.slice();
  const view = new DataView(damaged.buffer);
  const central = view.getUint32(damaged.length - 6, true);
  view.setUint32(central + 16, 0, true);
  view.setUint32(14, 0, true);
  expect(() => extractZip(damaged, dest)).toThrow("checksum mismatch");
  expect(() => extractZip(bytes.subarray(0, bytes.length - 4), dest)).toThrow("Unreadable");
  expect(existsSync(dest)).toBe(false);
});

test("forged short size and matching truncated CRC cannot bypass actual inflate limits", () => {
  const root = fixture();
  const bytes = zipSync({ "large.txt": new Uint8Array(8 * 1024 * 1024).fill(65) });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const central = view.getUint32(bytes.length - 6, true);
  view.setUint32(central + 24, 1, true);
  view.setUint32(22, 1, true);
  view.setUint32(central + 16, 0xd3d99e8b, true);
  view.setUint32(14, 0xd3d99e8b, true);
  expect(() =>
    extractZip(bytes, join(root, "out"), { limits: { entryBytes: 4, totalBytes: 4 } }),
  ).toThrow();
  expect(existsSync(join(root, "out"))).toBe(false);
});

test("local header names, sizes, methods and compressed ranges must match the directory", () => {
  for (const mutate of [
    (view: DataView) => view.setUint8(30, 88),
    (view: DataView) => view.setUint16(8, 99, true),
    (view: DataView) => view.setUint32(22, 99, true),
    (view: DataView, central: number) => view.setUint32(central + 20, 0xffffff, true),
    (view: DataView, central: number) => view.setUint32(central + 42, central, true),
  ]) {
    const bytes = archive({ file: "payload" });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    mutate(view, view.getUint32(bytes.length - 6, true));
    expect(() => listZip(bytes)).toThrow("Unreadable ZIP archive");
  }
});

test("a linked ancestor of the named archive, base or destination is followed", () => {
  // macOS reaches /tmp and /var through links like this one.
  const root = fixture();
  mkdirSync(join(root, "real", "work", "input"), { recursive: true });
  writeFileSync(join(root, "real", "work", "input", "a.txt"), "first");
  const alias = join(root, "alias");
  symlinkSync(join(root, "real"), alias, "dir");
  const base = join(alias, "work");
  const zip = join(base, "result.zip");
  expect(createZip(zip, [join(base, "input")], { base })).toEqual(["input/a.txt"]);
  expect(extractZip(zip, join(alias, "out", "nested"))).toEqual(["input/a.txt"]);
  expect(readFileSync(join(root, "real", "out", "nested", "input", "a.txt"), "utf8")).toBe("first");
  // The named path itself, and anything below it, may still not be a link.
  expect(() => createZip(join(root, "other.zip"), ["work"], { base: alias })).toThrow(
    "symbolic link",
  );
  symlinkSync(join(root, "real", "work"), join(alias, "out", "nested", "planted"), "dir");
  expect(() =>
    extractZip(archive({ "planted/input/a.txt": "changed" }), join(alias, "out", "nested"), {
      overwrite: true,
    }),
  ).toThrow("symbolic link");
  expect(readFileSync(join(root, "real", "work", "input", "a.txt"), "utf8")).toBe("first");
});

test("creation refuses symlink inputs, symlink output and overwrite by default", () => {
  const root = fixture();
  writeFileSync(join(root, "file.txt"), "original");
  symlinkSync(join(root, "file.txt"), join(root, "link.txt"));
  expect(() => buildZip(["link.txt"], { base: root })).toThrow("symbolic link");
  const zip = join(root, "file.zip");
  createZip(zip, ["file.txt"], { base: root });
  expect(() => createZip(zip, ["file.txt"], { base: root })).toThrow("already exists");
  createZip(zip, ["file.txt"], { base: root, overwrite: true });
  const link = join(root, "link.zip");
  symlinkSync(zip, link);
  expect(() => createZip(link, ["file.txt"], { base: root, overwrite: true })).toThrow(
    "symbolic link",
  );
});

test("entry filters preserve unselected existing files and empty files", () => {
  const root = fixture();
  writeFileSync(join(root, "keep.txt"), "original");
  const zip = archive({ "keep.txt": "new", "empty.txt": "" });
  expect(extractZip(zip, root, { filter: (name) => name === "empty.txt" })).toEqual(["empty.txt"]);
  expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("original");
  expect(readZipText(zip, "empty.txt")).toBe("");
});
