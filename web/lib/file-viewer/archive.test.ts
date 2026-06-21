/**
 * Locks the server-side archive listing: zip via fflate, the in-house tar
 * header iterator (incl. the two-zero-block EOF + 512-padding advance), and the
 * gzip/tar-vs-plain-gz heuristic. Fixtures are built in-test with fflate so
 * there's no binary blob to check in.
 */

import { describe, expect, test } from "bun:test";
import { gzipSync, strToU8, zipSync } from "fflate";
import { listArchive } from "./archive.ts";

/** Build a minimal POSIX-ish tar with the given {name → bytes} entries. */
function makeTar(files: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = strToU8(content);
    const header = new Uint8Array(512);
    const enc = new TextEncoder();
    header.set(enc.encode(name).subarray(0, 100), 0);
    // octal size in bytes 124..135, NUL-terminated
    const octal = data.length.toString(8).padStart(11, "0");
    header.set(enc.encode(octal), 124);
    header[135] = 0;
    header[156] = 0x30; // typeflag '0' = regular file
    header.set(enc.encode("ustar\0"), 257);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data, 0);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(512)); // two zero blocks = EOF
  blocks.push(new Uint8Array(512));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

describe("listArchive", () => {
  test("zip: lists entries with sizes", () => {
    const zip = zipSync({
      "a.txt": strToU8("hello"),
      "dir/b.json": strToU8('{"x":1}'),
    });
    const r = listArchive(zip, "zip");
    expect(r.kind).toBe("zip");
    const names = r.entries.map((e) => e.name).sort();
    expect(names).toEqual(["a.txt", "dir/b.json"]);
    expect(r.entries.find((e) => e.name === "a.txt")?.size).toBe(5);
  });

  test("tar: header iterator parses names + octal sizes + 512 padding", () => {
    const tar = makeTar({ "one.txt": "abc", "two.md": "x".repeat(600) });
    const r = listArchive(tar, "tar");
    expect(r.kind).toBe("tar");
    expect(r.entries.map((e) => e.name).sort()).toEqual(["one.txt", "two.md"]);
    expect(r.entries.find((e) => e.name === "one.txt")?.size).toBe(3);
    expect(r.entries.find((e) => e.name === "two.md")?.size).toBe(600);
  });

  test("tgz: gunzip then tar-iterate", () => {
    const tar = makeTar({ "inner/file.txt": "content" });
    const tgz = gzipSync(tar);
    const r = listArchive(tgz, "tgz");
    expect(r.kind).toBe("tar");
    expect(r.entries.map((e) => e.name)).toEqual(["inner/file.txt"]);
  });

  test("plain gz (single file, not a tar) → one (decompressed) entry", () => {
    const gz = gzipSync(strToU8("just some text, definitely not a tar archive\n"));
    const r = listArchive(gz, "gz");
    expect(r.kind).toBe("gzip");
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.name).toBe("(decompressed)");
  });

  test("corrupt zip throws (caller maps to a download card)", () => {
    expect(() => listArchive(new Uint8Array([1, 2, 3, 4]), "zip")).toThrow();
  });
});
