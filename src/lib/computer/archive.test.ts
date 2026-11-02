import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import { gzipSync } from "node:zlib";
import { buildTarGz } from "../../../tests/helpers/tar-fixture.ts";
import { INSTALL_MARKER, installPinnedArchive, listTarGz } from "./archive.ts";
import type { PinnedArtifact } from "./types.ts";

const { join } = posix;

function artifact(bytes: Uint8Array, extra: Partial<PinnedArtifact> = {}): PinnedArtifact {
  return {
    version: "9.9.9",
    fileName: "tool.tar.gz",
    url: "https://example.invalid/tool.tar.gz",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    format: "tar.gz",
    executableEntry: "tool",
    ...extra,
  };
}

let root: string;
beforeEach(() => {
  // These tests simulate POSIX hosts, whose plans join paths with posix syntax.
  // Forward slashes keep a Windows temp dir valid for both that and the file system.
  root = mkdtempSync(join(tmpdir(), "archive-test-")).replace(/\\/g, "/");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("listTarGz", () => {
  test("lists files and directories with modes", () => {
    const { entries } = listTarGz(
      buildTarGz([
        { name: "top/", type: "5", mode: 0o755 },
        { name: "top/tool", body: "bin", mode: 0o755 },
      ]),
    );
    expect(entries.map((e) => [e.name, e.type, e.mode])).toEqual([
      ["top", "directory", 0o755],
      ["top/tool", "file", 0o755],
    ]);
  });

  test("refuses links", () => {
    expect(() => listTarGz(buildTarGz([{ name: "link", type: "2" }]))).toThrow("not a file");
  });

  test("refuses a corrupt header", () => {
    const tar = buildTarGz([{ name: "tool", body: "x" }]);
    expect(() => listTarGz(gzipSync(Buffer.alloc(512, 7)))).toThrow("Corrupt");
    expect(listTarGz(tar).entries).toHaveLength(1);
  });
});

describe("installPinnedArchive", () => {
  const fetchOf = (bytes: Uint8Array) => async () => new Response(bytes as BodyInit);

  test("installs a flat tar.gz, keeps exec bits, writes the marker, and is idempotent", async () => {
    const bytes = buildTarGz([
      { name: "tool", body: "bin", mode: 0o755 },
      { name: "helper", body: "h", mode: 0o755 },
    ]);
    const installDir = join(root, "tools", "tool", "9.9.9");
    const art = artifact(bytes, { requiredEntries: ["helper"] });
    expect(
      await installPinnedArchive({ artifact: art, installDir, p: posix, fetch: fetchOf(bytes) }),
    ).toBe(true);
    expect(readFileSync(join(installDir, "tool"), "utf8")).toBe("bin");
    if (process.platform !== "win32")
      expect(statSync(join(installDir, "tool")).mode & 0o111).not.toBe(0);
    expect(JSON.parse(readFileSync(join(installDir, INSTALL_MARKER), "utf8")).sha256).toBe(
      art.sha256,
    );
    let fetched = false;
    const again = await installPinnedArchive({
      artifact: art,
      installDir,
      p: posix,
      fetch: async () => {
        fetched = true;
        return new Response(bytes as BodyInit);
      },
    });
    expect(again).toBe(false);
    expect(fetched).toBe(false);
  });

  test("a topDir archive installs that directory and rejects strays", async () => {
    const good = buildTarGz([
      { name: "top/", type: "5" },
      { name: "top/tool", body: "bin" },
    ]);
    const installDir = join(root, "a");
    await installPinnedArchive({
      artifact: artifact(good, { topDir: "top", executableEntry: "top/tool" }),
      installDir,
      p: posix,
      fetch: fetchOf(good),
    });
    expect(readFileSync(join(installDir, "tool"), "utf8")).toBe("bin");

    const stray = buildTarGz([
      { name: "top/tool", body: "bin" },
      { name: "other", body: "x" },
    ]);
    await expect(
      installPinnedArchive({
        artifact: artifact(stray, { topDir: "top", executableEntry: "top/tool" }),
        installDir: join(root, "b"),
        p: posix,
        fetch: fetchOf(stray),
      }),
    ).rejects.toThrow("outside top/");
    expect(existsSync(join(root, "b"))).toBe(false);
  });

  test("refuses a hash mismatch, a missing executable, and traversal", async () => {
    const bytes = buildTarGz([{ name: "tool", body: "bin" }]);
    await expect(
      installPinnedArchive({
        artifact: { ...artifact(bytes), sha256: "00".repeat(32) },
        installDir: join(root, "x"),
        p: posix,
        fetch: fetchOf(bytes),
      }),
    ).rejects.toThrow("does not match the pinned");
    await expect(
      installPinnedArchive({
        artifact: artifact(bytes, { executableEntry: "missing" }),
        installDir: join(root, "y"),
        p: posix,
        fetch: fetchOf(bytes),
      }),
    ).rejects.toThrow("lacks missing");
    const evil = buildTarGz([
      { name: "tool", body: "bin" },
      { name: "../evil", body: "x" },
    ]);
    await expect(
      installPinnedArchive({
        artifact: artifact(evil),
        installDir: join(root, "z"),
        p: posix,
        fetch: fetchOf(evil),
      }),
    ).rejects.toThrow("Unsafe");
    expect(existsSync(join(root, "evil"))).toBe(false);
  });
});
