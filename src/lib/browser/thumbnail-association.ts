import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

const MAX_HTML = 2 * 1024 * 1024;
const MAX_PNG = 32 * 1024 * 1024;
export interface CaptureFingerprint {
  version: string;
  sha256: string;
}
export interface CaptureThumbnailAssociation {
  schema_version: 2;
  producer: "browser-standalone-capture";
  source: CaptureFingerprint & { path: string };
  preview: CaptureFingerprint & { path: string };
}
function version(fd: number): string {
  const s = fstatSync(fd);
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}
function fingerprint(filename: string, maxBytes: number): CaptureFingerprint | null {
  const canonical = realpathSync(filename);
  const before = statSync(canonical);
  if (!before.isFile() || before.size > maxBytes) return null;
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return null;
    const initial = version(fd);
    const hash = createHash("sha256");
    const bytes = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(fd, bytes, 0, Math.min(bytes.length, before.size - offset), offset);
      if (!count) return null;
      hash.update(bytes.subarray(0, count));
      offset += count;
    }
    if (version(fd) !== initial || realpathSync(filename) !== canonical) return null;
    return { version: initial, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

/** Take immediately after the screenshot writer completes, before asynchronous
 * HTML serialization. A later writer cannot silently substitute its PNG. */
export function captureThumbnailFingerprint(pngPath: string): CaptureFingerprint | null {
  try {
    return fingerprint(pngPath, MAX_PNG);
  } catch {
    return null;
  }
}
function workspaceFor(filename: string): { root: string; workspace: string } | null {
  for (
    let current = path.dirname(filename);
    path.dirname(current) !== current;
    current = path.dirname(current)
  ) {
    const artifacts = path.dirname(current);
    const state = path.dirname(artifacts);
    if (path.basename(artifacts) === "artifacts" && path.basename(state) === ".harnery")
      return { root: path.dirname(state), workspace: current };
  }
  return null;
}
function inside(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Associate only the full-document, standalone HTML and exact PNG produced by
 * this capture operation. No basename inference and no reads of source pages.
 * A linked asset, selector fragment, changed output, oversize file or output
 * outside a managed artifact workspace safely skips registration.
 * The hidden sidecar binds canonical repository paths, checked file versions
 * and SHA256 receipts. Web readers also require an empty local asset graph;
 * manual registrations bind their own complete dependency graph instead. */
export function registerCaptureThumbnail(input: {
  htmlPath: string;
  pngPath: string;
  html: string;
  preview: CaptureFingerprint;
  fullDocument: boolean;
  stylesheetsLinked: number;
  resourcesLinked: number;
}): string | null {
  if (!input.fullDocument || input.stylesheetsLinked !== 0 || input.resourcesLinked !== 0)
    return null;
  try {
    const htmlPath = realpathSync(input.htmlPath);
    const pngPath = realpathSync(input.pngPath);
    if (!/\.html?$/i.test(htmlPath) || !/\.png$/i.test(pngPath)) return null;
    const owner = workspaceFor(htmlPath);
    if (!owner || !inside(owner.workspace, pngPath)) return null;
    const source = fingerprint(htmlPath, MAX_HTML);
    const preview = fingerprint(pngPath, MAX_PNG);
    if (
      !source ||
      !preview ||
      source.sha256 !== createHash("sha256").update(input.html).digest("hex") ||
      preview.version !== input.preview.version ||
      preview.sha256 !== input.preview.sha256
    )
      return null;
    const sourceRelative = path.relative(owner.root, htmlPath).split(path.sep).join("/");
    const previewRelative = path.relative(owner.root, pngPath).split(path.sep).join("/");
    const association: CaptureThumbnailAssociation = {
      schema_version: 2,
      producer: "browser-standalone-capture",
      source: { path: sourceRelative, ...source },
      preview: { path: previewRelative, ...preview },
    };
    const name = `.thumbnail-preview-${createHash("sha256").update(sourceRelative).digest("hex").slice(0, 24)}.json`;
    const directoryFd = openSync(
      owner.workspace,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      let anchor: string | undefined;
      for (const prefix of ["/proc/self/fd", "/dev/fd"]) {
        const candidate = `${prefix}/${directoryFd}`;
        try {
          if (realpathSync(candidate) === owner.workspace) {
            anchor = candidate;
            break;
          }
        } catch {
          /* unsupported descriptor namespace */
        }
      }
      if (!anchor) return null;
      const target = path.join(anchor, name);
      const temporary = `${target}.${randomUUID()}.tmp`;
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const bytes = Buffer.from(`${JSON.stringify(association)}\n`);
        if (bytes.length > 16 * 1024) return null;
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
        if (
          realpathSync(anchor) !== owner.workspace ||
          realpathSync(owner.workspace) !== owner.workspace
        )
          return null;
        // Stat again after the write, without reading another potentially large
        // image. ctime detects same-size edits with a restored mtime.
        const matches = (filename: string, expected: string) => {
          const s = statSync(filename);
          return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` === expected;
        };
        if (!matches(htmlPath, source.version) || !matches(pngPath, preview.version)) return null;
        renameSync(temporary, target);
      } finally {
        closeSync(fd);
        try {
          unlinkSync(temporary);
        } catch {
          /* renamed */
        }
      }
    } finally {
      closeSync(directoryFd);
    }
    return path.relative(owner.root, path.join(owner.workspace, name)).split(path.sep).join("/");
  } catch {
    return null;
  }
}
