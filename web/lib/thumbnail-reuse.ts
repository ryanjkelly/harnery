import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  read,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { Inflate } from "fflate";
import type { CaptureThumbnailAssociation } from "../../src/lib/browser/thumbnail-association.ts";
import { resolveDir } from "./file-tree";
import { evaluateDeny, type ResolvedFile, resolveFile, scanChunk } from "./files";
import { thumbnailDependencyKey } from "./thumbnail-renderers/dependencies";

const MANIFEST_LIMIT = 16 * 1024;
const IMAGE_LIMIT = 32 * 1024 * 1024;
const EMBEDDED_IMAGE_LIMIT = 4 * 1024 * 1024;
const EMPTY_DEPENDENCIES = createHash("sha256").update("html-dependencies-v1").digest("hex");
const ZIP_DIRECTORY_LIMIT = 4 * 1024 * 1024;
const OFFICE = /\.(docx|xlsx|pptx|odt|ods|odp)$/i;
const EMBEDDED_NAMES = new Set([
  "docProps/thumbnail.png",
  "docProps/thumbnail.jpeg",
  "docProps/thumbnail.jpg",
  "Thumbnails/thumbnail.png",
]);

export type ThumbnailReuse =
  | { kind: "file"; file: ResolvedFile; identity: string; provenance: "registered-preview" }
  | { kind: "bytes"; bytes: Buffer; identity: string; provenance: "office-embedded" };

/** Local file version: an edit, replacement, or restored modification time
 * changes at least one of these descriptor-derived fields. */
export function thumbnailReuseFileVersion(file: ResolvedFile): string {
  const s = fstatSync(file.fd);
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}
function workspaceOf(relative: string): string | null {
  const segments = relative.split("/");
  return segments[0] === ".harnery" && segments[1] === "artifacts" && segments.length >= 4
    ? segments.slice(0, 3).join("/")
    : null;
}
function sidecarPath(source: string, workspace: string): string {
  const id = createHash("sha256").update(source).digest("hex").slice(0, 24);
  return `${workspace}/.thumbnail-preview-${id}.json`;
}
async function readBytes(file: ResolvedFile, offset: number, length: number): Promise<Buffer> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > file.size
  )
    throw new Error("invalid_read");
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const count = await new Promise<number>((resolve, reject) => {
      read(file.fd, buffer, done, length - done, offset + done, (error, bytes) =>
        error ? reject(error) : resolve(bytes),
      );
    });
    if (!count) throw new Error("source_changed");
    done += count;
  }
  return buffer;
}
function raster(bytes: Buffer): boolean {
  return (
    (bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
    (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) ||
    (bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP")
  );
}
function validRelative(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
  );
}
interface Association {
  schema_version: 1;
  source: { path: string; version: string; dependencies: string };
  preview: { path: string; version: string };
}

async function registered(source: ResolvedFile, root: string): Promise<ThumbnailReuse | null> {
  const workspace = workspaceOf(source.relPath);
  if (!workspace) return null;
  const manifestPath = sidecarPath(source.relPath, workspace);
  const manifest = resolveFile(manifestPath, { root });
  if (!manifest.ok) return null;
  try {
    if (manifest.relPath !== manifestPath || manifest.size > MANIFEST_LIMIT) return null;
    const before = thumbnailReuseFileVersion(manifest);
    const bytes = await readBytes(manifest, 0, manifest.size);
    if (scanChunk(bytes).secret || thumbnailReuseFileVersion(manifest) !== before) return null;
    const value = JSON.parse(bytes.toString("utf8")) as Association | CaptureThumbnailAssociation;
    if (
      (value?.schema_version !== 1 && value?.schema_version !== 2) ||
      value.source?.path !== source.relPath ||
      value.source?.version !== thumbnailReuseFileVersion(source)
    )
      return null;
    if (
      value.schema_version === 2 &&
      (value.producer !== "browser-standalone-capture" ||
        !/^[a-f0-9]{64}$/.test(value.source.sha256) ||
        !/^[a-f0-9]{64}$/.test(value.preview?.sha256))
    )
      return null;
    if (value.schema_version === 2) {
      // Fast producers can rewrite equal-length HTML inside one filesystem
      // timestamp tick. Verify this bounded capture receipt before reuse.
      if (source.size > 2 * 1024 * 1024) return null;
      const bytes = await readBytes(source, 0, source.size);
      if (createHash("sha256").update(bytes).digest("hex") !== value.source.sha256) return null;
    }
    // Captures are self-contained. Any local dependency, including a missing
    // file, produces a different graph key and invalidates automatic reuse.
    const dependencies =
      value.schema_version === 1 ? value.source.dependencies : EMPTY_DEPENDENCIES;
    if (dependencies !== (await thumbnailDependencyKey(source, root))) return null;
    if (
      !validRelative(value.preview?.path) ||
      workspaceOf(value.preview.path) !== workspace ||
      value.preview.path === source.relPath
    )
      return null;
    const preview = resolveFile(value.preview.path, { root });
    if (!preview.ok) return null;
    let transfer = false;
    try {
      const version = thumbnailReuseFileVersion(preview);
      if (
        preview.relPath !== value.preview.path ||
        preview.category !== "image" ||
        preview.size > IMAGE_LIMIT ||
        version !== value.preview.version
      )
        return null;
      if (
        !raster(await readBytes(preview, 0, Math.min(12, preview.size))) ||
        thumbnailReuseFileVersion(preview) !== version
      )
        return null;
      if (thumbnailReuseFileVersion(source) !== value.source.version) return null;
      transfer = true;
      return { kind: "file", file: preview, identity: version, provenance: "registered-preview" };
    } finally {
      if (!transfer) closeSync(preview.fd);
    }
  } catch {
    return null;
  } finally {
    closeSync(manifest.fd);
  }
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Inflate in small compressed chunks so a forged size cannot allocate the
 * complete expansion before our actual-output cap is checked. */
function inflateBounded(input: Buffer, expected: number): Buffer {
  const chunks: Buffer[] = [];
  let size = 0;
  const stream = new Inflate((chunk) => {
    size += chunk.length;
    if (size > expected || size > EMBEDDED_IMAGE_LIMIT) throw new Error("thumbnail_zip_bomb");
    chunks.push(Buffer.from(chunk));
  });
  for (let offset = 0; offset < input.length; offset += 1024) {
    stream.push(input.subarray(offset, offset + 1024), offset + 1024 >= input.length);
  }
  if (size !== expected) throw new Error("thumbnail_size_mismatch");
  return Buffer.concat(chunks, size);
}

async function embedded(source: ResolvedFile): Promise<ThumbnailReuse | null> {
  if (!OFFICE.test(source.relPath) || source.size < 22 || source.size > 128 * 1024 * 1024)
    return null;
  const version = thumbnailReuseFileVersion(source);
  const tail = await readBytes(
    source,
    Math.max(0, source.size - 65557),
    Math.min(source.size, 65557),
  );
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (
      tail.readUInt32LE(at) === 0x06054b50 &&
      at + 22 + tail.readUInt16LE(at + 20) === tail.length
    ) {
      end = at;
      break;
    }
  }
  if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) return null;
  const count = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (
    count > 10000 ||
    count !== tail.readUInt16LE(end + 8) ||
    directorySize > ZIP_DIRECTORY_LIMIT ||
    directoryOffset + directorySize > source.size - tail.length + end
  )
    return null;
  const directory = await readBytes(source, directoryOffset, directorySize);
  let candidate: {
    name: string;
    method: number;
    flags: number;
    crc: number;
    compressed: number;
    size: number;
    offset: number;
  } | null = null;
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) return null;
    const nameSize = directory.readUInt16LE(at + 28);
    const recordSize =
      46 + nameSize + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
    if (at + recordSize > directory.length || nameSize > 1024) return null;
    const name = directory.toString("utf8", at + 46, at + 46 + nameSize);
    if (EMBEDDED_NAMES.has(name)) {
      if (candidate) return null;
      candidate = {
        name,
        flags: directory.readUInt16LE(at + 8),
        method: directory.readUInt16LE(at + 10),
        crc: directory.readUInt32LE(at + 16),
        compressed: directory.readUInt32LE(at + 20),
        size: directory.readUInt32LE(at + 24),
        offset: directory.readUInt32LE(at + 42),
      };
    }
    at += recordSize;
  }
  if (
    !candidate ||
    at !== directory.length ||
    candidate.flags & 1 ||
    ![0, 8].includes(candidate.method) ||
    candidate.size < 8 ||
    candidate.size > EMBEDDED_IMAGE_LIMIT ||
    candidate.compressed > EMBEDDED_IMAGE_LIMIT ||
    candidate.compressed === 0 ||
    candidate.size > candidate.compressed * 200
  )
    return null;
  const local = await readBytes(source, candidate.offset, 30);
  if (
    local.readUInt32LE(0) !== 0x04034b50 ||
    local.readUInt16LE(6) !== candidate.flags ||
    local.readUInt16LE(8) !== candidate.method
  )
    return null;
  const nameSize = local.readUInt16LE(26);
  const extraSize = local.readUInt16LE(28);
  if (nameSize > 1024) return null;
  const name = await readBytes(source, candidate.offset + 30, nameSize);
  if (name.toString("utf8") !== candidate.name) return null;
  const dataOffset = candidate.offset + 30 + nameSize + extraSize;
  if (dataOffset + candidate.compressed > directoryOffset) return null;
  const compressed = await readBytes(source, dataOffset, candidate.compressed);
  const bytes = candidate.method === 0 ? compressed : inflateBounded(compressed, candidate.size);
  if (
    bytes.length !== candidate.size ||
    !raster(bytes) ||
    crc32(bytes) !== candidate.crc ||
    thumbnailReuseFileVersion(source) !== version
  )
    return null;
  return {
    kind: "bytes",
    bytes,
    identity: `${version}:${candidate.name}:${createHash("sha256").update(bytes).digest("hex")}`,
    provenance: "office-embedded",
  };
}

/** Caller retains source.fd and owns any returned file.fd. Every call checks
 * current policy and file versions; no persistent association-result cache. */
export async function resolveThumbnailReuse(
  source: ResolvedFile,
  root: string,
): Promise<ThumbnailReuse | null> {
  const checked = resolveFile(source.relPath, { root });
  if (!checked.ok) return null;
  try {
    if (
      checked.relPath !== source.relPath ||
      thumbnailReuseFileVersion(checked) !== thumbnailReuseFileVersion(source)
    )
      return null;
    return (await registered(source, root)) ?? (await embedded(source));
  } catch {
    return null;
  } finally {
    closeSync(checked.fd);
  }
}

/** Explicitly associate a known captured raster preview with its source.
 * Both files must be in the same artifact workspace. Call only after the
 * pipeline has finished writing both files and verified the captured result.
 * The hidden sidecar is schema_version:1 with source/preview {path,version};
 * paths are canonical repository-relative and versions bind checked inodes,
 * sizes, modification times and change times. source.dependencies binds the
 * current HTML/CSS asset graph. No basename inference occurs.
 * Re-registration replaces only this source's generated association sidecar. */
export async function registerThumbnailPreview(
  sourcePath: string,
  previewPath: string,
  opts: { root: string },
): Promise<string> {
  const source = resolveFile(sourcePath, opts);
  if (!source.ok) throw new Error(`source_${source.code}`);
  let preview: ResolvedFile | undefined;
  try {
    const resolved = resolveFile(previewPath, opts);
    if (!resolved.ok) throw new Error(`preview_${resolved.code}`);
    preview = resolved;
    const workspace = workspaceOf(source.relPath);
    if (
      !workspace ||
      workspaceOf(preview.relPath) !== workspace ||
      preview.relPath === source.relPath
    )
      throw new Error("preview_workspace_mismatch");
    if (
      preview.category !== "image" ||
      preview.size > IMAGE_LIMIT ||
      !raster(await readBytes(preview, 0, Math.min(preview.size, 12)))
    )
      throw new Error("preview_requires_raster");
    const sourceVersion = thumbnailReuseFileVersion(source);
    const previewVersion = thumbnailReuseFileVersion(preview);
    const manifest: Association = {
      schema_version: 1,
      source: {
        path: source.relPath,
        version: sourceVersion,
        dependencies: await thumbnailDependencyKey(source, opts.root),
      },
      preview: { path: preview.relPath, version: previewVersion },
    };
    const relative = sidecarPath(source.relPath, workspace);
    const dir = resolveDir(workspace, opts);
    if (!dir.ok || dir.baseRel !== workspace) throw new Error("preview_workspace_unavailable");
    if (evaluateDeny(relative, dir.cfg).denied) throw new Error("preview_manifest_denied");
    const directoryFd = openSync(
      dir.real,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      // Descriptor-relative writes cannot be redirected when the workspace's
      // pathname is replaced during registration. Refuse platforms that expose
      // no usable descriptor directory instead of weakening this boundary.
      let anchor: string | undefined;
      for (const prefix of ["/proc/self/fd", "/dev/fd"]) {
        const candidate = `${prefix}/${directoryFd}`;
        try {
          if (realpathSync(candidate) === dir.real) {
            anchor = candidate;
            break;
          }
        } catch {
          /* try the other descriptor namespace */
        }
      }
      if (!anchor) throw new Error("preview_registration_descriptor_unavailable");
      const target = path.join(anchor, path.posix.basename(relative));
      const temporary = `${target}.${randomUUID()}.tmp`;
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const contents = Buffer.from(`${JSON.stringify(manifest)}\n`);
        if (contents.length > MANIFEST_LIMIT) throw new Error("preview_manifest_limit");
        let written = 0;
        while (written < contents.length)
          written += writeSync(fd, contents, written, contents.length - written);
        if (
          thumbnailReuseFileVersion(source) !== sourceVersion ||
          thumbnailReuseFileVersion(preview) !== previewVersion
        )
          throw new Error("preview_source_changed");
        if (realpathSync(anchor) !== dir.real || realpathSync(dir.real) !== dir.real)
          throw new Error("preview_workspace_changed");
        renameSync(temporary, target);
      } finally {
        closeSync(fd);
        try {
          unlinkSync(temporary);
        } catch {
          /* renamed or removed */
        }
      }
    } finally {
      closeSync(directoryFd);
    }
    return relative;
  } finally {
    closeSync(source.fd);
    if (preview) closeSync(preview.fd);
  }
}
