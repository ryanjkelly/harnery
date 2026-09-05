import { afterAll, describe, expect, test } from "bun:test";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import {
  captureThumbnailFingerprint,
  registerCaptureThumbnail,
} from "../../src/lib/browser/thumbnail-association.ts";
import { resolveFile } from "./files";
import {
  registerThumbnailPreview,
  resolveThumbnailReuse,
  type ThumbnailReuse,
} from "./thumbnail-reuse";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0l8AAAAASUVORK5CYII=",
  "base64",
);
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "thumbnail-reuse-"));
  roots.push(root);
  const workspace = ".harnery/artifacts/example";
  const source = `${workspace}/page.html`;
  const preview = `${workspace}/capture.png`;
  const write = (relative: string, bytes: string | Uint8Array) => {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes);
  };
  write(source, '<html><link rel="stylesheet" href="style.css"><p>Example</p></html>');
  write(`${workspace}/style.css`, "p { color: blue }");
  write(preview, PNG);
  return { root, workspace, source, preview, write };
}
async function reuse(root: string, relative: string) {
  const source = resolveFile(relative, { root });
  if (!source.ok) return null;
  try {
    return await resolveThumbnailReuse(source, root);
  } finally {
    closeSync(source.fd);
  }
}
function dispose(value: ThumbnailReuse | null) {
  if (value?.kind === "file") closeSync(value.file.fd);
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("explicit thumbnail associations", () => {
  test("does not guess matching filenames and reuses only registered raster captures", async () => {
    const f = fixture();
    f.write(`${f.workspace}/page.png`, PNG);
    expect(await reuse(f.root, f.source)).toBeNull();
    const manifest = await registerThumbnailPreview(f.source, f.preview, { root: f.root });
    expect(manifest).toMatch(/\.thumbnail-preview-[a-f0-9]{24}\.json$/);
    const result = await reuse(f.root, f.source);
    try {
      expect(result).toMatchObject({
        kind: "file",
        provenance: "registered-preview",
        file: { relPath: f.preview },
      });
    } finally {
      dispose(result);
    }
    expect(
      JSON.parse(readFileSync(path.join(f.root, manifest), "utf8")).source.dependencies,
    ).toHaveLength(64);
  });

  test("source edits invalidate reuse even when size and modification time are restored", async () => {
    const f = fixture();
    await registerThumbnailPreview(f.source, f.preview, { root: f.root });
    const absolute = path.join(f.root, f.source);
    const original = statSync(absolute);
    const bytes = readFileSync(absolute, "utf8").replace("Example", "Changed");
    f.write(f.source, bytes);
    utimesSync(absolute, original.atime, original.mtime);
    expect(await reuse(f.root, f.source)).toBeNull();
  });

  test("preview edits invalidate reuse and explicit registration can replace a stale association", async () => {
    const f = fixture();
    await registerThumbnailPreview(f.source, f.preview, { root: f.root });
    f.write(f.preview, Buffer.concat([PNG, Buffer.from("updated")]));
    expect(await reuse(f.root, f.source)).toBeNull();
    await registerThumbnailPreview(f.source, f.preview, { root: f.root });
    const result = await reuse(f.root, f.source);
    try {
      expect(result?.kind).toBe("file");
    } finally {
      dispose(result);
    }
  });

  test("local HTML asset changes invalidate an otherwise unchanged source and screenshot", async () => {
    const f = fixture();
    await registerThumbnailPreview(f.source, f.preview, { root: f.root });
    f.write(`${f.workspace}/style.css`, "p { color: orange }");
    expect(await reuse(f.root, f.source)).toBeNull();
  });

  test("current deny policy applies to previews and dependencies after registration", async () => {
    const f = fixture();
    await registerThumbnailPreview(f.source, f.preview, { root: f.root });
    f.write(".harnery/config.jsonc", JSON.stringify({ files: { deny_globs: ["**/capture.png"] } }));
    expect(await reuse(f.root, f.source)).toBeNull();
    f.write(".harnery/config.jsonc", JSON.stringify({ files: { deny_globs: ["**/style.css"] } }));
    expect(await reuse(f.root, f.source)).toBeNull();
  });

  test("refuses cross-workspace, symlink escape, and vector registrations", async () => {
    const f = fixture();
    f.write(".harnery/artifacts/other/capture.png", PNG);
    await expect(
      registerThumbnailPreview(f.source, ".harnery/artifacts/other/capture.png", { root: f.root }),
    ).rejects.toThrow("workspace_mismatch");
    f.write(`${f.workspace}/image.svg`, "<svg></svg>");
    await expect(
      registerThumbnailPreview(f.source, `${f.workspace}/image.svg`, { root: f.root }),
    ).rejects.toThrow("requires_raster");
    symlinkSync(
      path.join(f.root, ".harnery/artifacts/other/capture.png"),
      path.join(f.root, f.workspace, "alias.png"),
    );
    await expect(
      registerThumbnailPreview(f.source, `${f.workspace}/alias.png`, { root: f.root }),
    ).rejects.toThrow("workspace_mismatch");
  });

  test("rejects tampered, oversized and secret-bearing manifests", async () => {
    const f = fixture();
    const manifest = await registerThumbnailPreview(f.source, f.preview, { root: f.root });
    const value = JSON.parse(readFileSync(path.join(f.root, manifest), "utf8"));
    f.write(
      manifest,
      JSON.stringify({ ...value, preview: { ...value.preview, path: "../capture.png" } }),
    );
    expect(await reuse(f.root, f.source)).toBeNull();
    f.write(manifest, " ".repeat(17000) + JSON.stringify(value));
    expect(await reuse(f.root, f.source)).toBeNull();
    f.write(
      manifest,
      JSON.stringify({ padding: " ".repeat(5000), ...value, note: "-----BEGIN PRIVATE KEY-----" }),
    );
    expect(await reuse(f.root, f.source)).toBeNull();
  });
});

describe("embedded Office thumbnails", () => {
  test("extracts only a recognized embedded raster without inflating other document entries", async () => {
    const f = fixture();
    const document = `${f.workspace}/deck.pptx`;
    f.write(
      document,
      zipSync({
        "docProps/thumbnail.png": PNG,
        "ppt/slides/slide1.xml": Buffer.from("<slide/>"),
        unused: new Uint8Array(2_000_000),
      }),
    );
    const result = await reuse(f.root, document);
    expect(result?.kind).toBe("bytes");
    if (result?.kind === "bytes") {
      expect(result.bytes).toEqual(PNG);
      expect(result.provenance).toBe("office-embedded");
    }
  });

  test("supports stored ODF thumbnails", async () => {
    const f = fixture();
    const document = `${f.workspace}/document.odt`;
    f.write(document, zipSync({ "Thumbnails/thumbnail.png": [PNG, { level: 0 }] }));
    const result = await reuse(f.root, document);
    expect(result?.kind === "bytes" && result.bytes.equals(PNG)).toBe(true);
  });

  test("ignores vector masquerades, traversal names, duplicate thumbnails, and corrupt archives", async () => {
    const f = fixture();
    const document = `${f.workspace}/document.docx`;
    const cases: Record<string, Uint8Array>[] = [
      { "docProps/thumbnail.png": Buffer.from("<svg><script>alert(1)</script></svg>") },
      { "../docProps/thumbnail.png": PNG },
      { "docProps/thumbnail.png": PNG, "docProps/thumbnail.jpeg": PNG },
    ];
    for (const entries of cases) {
      f.write(document, zipSync(entries));
      expect(await reuse(f.root, document)).toBeNull();
    }
    f.write(document, Buffer.from("PK corrupt archive"));
    expect(await reuse(f.root, document)).toBeNull();
  });

  test("rejects forged decompressed sizes before retaining an oversized expansion", async () => {
    const f = fixture();
    const document = `${f.workspace}/document.xlsx`;
    const bytes = Buffer.from(
      zipSync({ "docProps/thumbnail.png": Buffer.concat([PNG, Buffer.alloc(2_000_000)]) }),
    );
    const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(4096, directory + 24);
    f.write(document, bytes);
    expect(await reuse(f.root, document)).toBeNull();
  });

  test("rejects an embedded payload whose CRC no longer matches its directory", async () => {
    const f = fixture();
    const document = `${f.workspace}/document.docx`;
    const bytes = Buffer.from(zipSync({ "docProps/thumbnail.png": [PNG, { level: 0 }] }));
    const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(0, directory + 16);
    f.write(document, bytes);
    expect(await reuse(f.root, document)).toBeNull();
  });
});

describe("automatic capture reuse", () => {
  test("reads producer registration and invalidates changed source, preview and file policy", async () => {
    for (const change of ["source", "preview", "policy"]) {
      const f = fixture();
      const html = "<!doctype html><html><style>p{color:blue}</style><p>Capture</p></html>";
      f.write(f.source, html);
      const result = registerCaptureThumbnail({
        htmlPath: path.join(f.root, f.source),
        pngPath: path.join(f.root, f.preview),
        html,
        preview: captureThumbnailFingerprint(path.join(f.root, f.preview))!,
        fullDocument: true,
        stylesheetsLinked: 0,
        resourcesLinked: 0,
      });
      expect(result).not.toBeNull();
      const reused = await reuse(f.root, f.source);
      try {
        expect(reused?.kind).toBe("file");
      } finally {
        dispose(reused);
      }
      if (change === "source") f.write(f.source, html.replace("blue", "pink"));
      if (change === "preview") f.write(f.preview, Buffer.concat([PNG, Buffer.from("changed")]));
      if (change === "policy")
        f.write(
          ".harnery/config.jsonc",
          JSON.stringify({ files: { deny_globs: ["**/capture.png"] } }),
        );
      expect(await reuse(f.root, f.source)).toBeNull();
    }
  });

  test("refuses automatic reuse for a saved capture that still has a local CSS dependency", async () => {
    const f = fixture();
    const html = readFileSync(path.join(f.root, f.source), "utf8");
    // Defensive case: an incorrect producer claims zero linked assets. The
    // viewer independently discovers the stylesheet and refuses capture reuse.
    expect(
      registerCaptureThumbnail({
        htmlPath: path.join(f.root, f.source),
        pngPath: path.join(f.root, f.preview),
        html,
        preview: captureThumbnailFingerprint(path.join(f.root, f.preview))!,
        fullDocument: true,
        stylesheetsLinked: 0,
        resourcesLinked: 0,
      }),
    ).not.toBeNull();
    expect(await reuse(f.root, f.source)).toBeNull();
    f.write(`${f.workspace}/style.css`, "p { color: orange }");
    expect(await reuse(f.root, f.source)).toBeNull();
  });
});
