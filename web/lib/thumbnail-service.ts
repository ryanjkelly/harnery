import { createHash } from "node:crypto";
import { closeSync, createReadStream, fstatSync, realpathSync } from "node:fs";
import { mkdtemp, open, opendir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { coordRoot } from "./coord-reader";
import { fileErrorResponse } from "./file-routes";
import { resolveDir } from "./file-tree";
import { type ResolvedFile, type ResolveOptions, resolveFile } from "./files";
import { readThumbnailDisk, writeThumbnailDisk } from "./thumbnail-disk-cache";
import { canRenderThumbnail, renderThumbnail } from "./thumbnail-renderers";
import { thumbnailDependencyKey } from "./thumbnail-renderers/dependencies";

// Bump when rendering rules change; disk entries are disposable derivatives.
const VERSION = "v2";
const MAX_OUTPUT = 512 * 1024;
const MEMORY_BYTES = 16 * 1024 * 1024;

const OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;
type Source = { file: ResolvedFile; identity: string };
type Result = { bytes?: Buffer; error?: string; ms: number };
type Job = { key: string; run: () => Promise<Result>; finish: (result: Result) => void };
const memory = new Map<string, Buffer>();
const pending = new Map<string, Promise<Result>>();
const failures = new Map<string, { error: string; until: number }>();
const queue: Job[] = [];
let memoryBytes = 0;
let active = 0;

export interface ThumbnailOptions extends ResolveOptions {
  /** Offline tests/benchmarks may wait; HTTP requests always return promptly. */
  wait?: boolean;
}
function problem(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
function identity(file: ResolvedFile): string {
  const s = fstatSync(file.fd);
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}
function limit(file: ResolvedFile): number {
  if (file.category === "audio" || file.category === "video") return 512 * 1024 * 1024;
  if (file.category === "image" || file.category === "svg") return 32 * 1024 * 1024;
  if (file.category === "pdf" || OFFICE.test(file.relPath)) return 128 * 1024 * 1024;
  if (file.category === "html") return 2 * 1024 * 1024;
  return Number.POSITIVE_INFINITY; // Text thumbnails stage only the first 256 KiB.
}
function closeSources(sources: Source[]) {
  for (const { file } of sources) closeSync(file.fd);
}
function remember(key: string, bytes: Buffer) {
  const old = memory.get(key);
  if (old) memoryBytes -= old.length;
  memory.delete(key);
  memory.set(key, bytes);
  memoryBytes += bytes.length;
  while (memory.size > 128 || memoryBytes > MEMORY_BYTES) {
    const oldest = memory.keys().next().value!;
    memoryBytes -= memory.get(oldest)!.length;
    memory.delete(oldest);
  }
}
function drain() {
  while (active < 2 && queue.length) {
    const job = queue.shift()!;
    active++;
    void job
      .run()
      .then(job.finish, () => job.finish({ error: "thumbnail_unavailable", ms: 0 }))
      .finally(() => {
        pending.delete(job.key);
        active--;
        drain();
      });
  }
}
/** Snapshot only the checked descriptor, verifying no edits occurred during copy. */
async function renderSource(
  source: Source,
  root: string,
  temporary: string,
  index: number,
): Promise<Buffer> {
  const { file } = source;
  if (identity(file) !== source.identity) throw new Error("source_changed");
  const inputPath = path.join(temporary, `${index}${path.extname(file.relPath)}`);
  const output = await open(inputPath, "wx", 0o600);
  try {
    const sourceBytes = ["text", "code", "json", "yaml", "csv", "markdown"].includes(file.category)
      ? Math.min(file.size, 256 * 1024)
      : file.size;
    if (sourceBytes) {
      const stream = createReadStream("", {
        fd: file.fd,
        autoClose: false,
        start: 0,
        end: sourceBytes - 1,
      });
      for await (const chunk of stream) await output.writeFile(chunk);
    }
  } finally {
    await output.close();
  }
  if (identity(file) !== source.identity) throw new Error("source_changed");
  return renderThumbnail({ inputPath, relPath: file.relPath, category: file.category, root });
}
async function generate(sources: Source[], root: string, folder: boolean): Promise<Buffer> {
  const temporary = await mkdtemp(path.join(tmpdir(), "harn-thumbnail-"));
  try {
    const images: Buffer[] = [];
    for (const [index, source] of sources.entries()) {
      try {
        images.push(await renderSource(source, root, temporary, index));
      } catch (error) {
        if (!folder) throw error;
      }
    }
    if (!images.length) throw new Error("thumbnail_unavailable");
    if (!folder) return images[0];
    const tiles = await Promise.all(
      images.map((image) =>
        sharp(image).resize(174, 110, { fit: "contain", background: "#101820" }).toBuffer(),
      ),
    );
    return sharp({ create: { width: 360, height: 240, channels: 3, background: "#18232f" } })
      .composite(
        tiles.map((input, index) => ({
          input,
          left: 4 + (index % 2) * 178,
          top: 6 + Math.floor(index / 2) * 116,
        })),
      )
      .webp({ quality: 72 })
      .toBuffer();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
/** Sample at most 64 entries across two levels, never a recursive repository scan. */
async function folderSources(relative: string, root: string): Promise<Source[]> {
  const dirs = [{ relative, depth: 0 }];
  const candidates: string[] = [];
  let seen = 0;
  for (let i = 0; i < dirs.length && seen < 64; i++) {
    const next = dirs[i];
    const checked = resolveDir(next.relative, { root });
    if (!checked.ok) continue;
    try {
      const directory = await opendir(checked.real);
      for await (const entry of directory) {
        if (++seen > 64) break;
        if (entry.name.startsWith(".")) continue;
        const rel = `${checked.baseRel ? `${checked.baseRel}/` : ""}${entry.name}`;
        if (entry.isDirectory() && next.depth < 1)
          dirs.push({ relative: rel, depth: next.depth + 1 });
        else if (entry.isFile()) candidates.push(rel);
      }
    } catch {
      /* Disappearing folders leave remaining candidates usable. */
    }
  }
  const preferred = /\.(png|jpe?g|webp|gif|avif|svg)$/i;
  candidates.sort(
    (a, b) => Number(preferred.test(b)) - Number(preferred.test(a)) || a.localeCompare(b),
  );
  const sources: Source[] = [];
  for (const candidate of candidates) {
    const file = resolveFile(candidate, { root });
    if (!file.ok) continue;
    if (!canRenderThumbnail(file.category, file.relPath) || file.size > limit(file)) {
      closeSync(file.fd);
      continue;
    }
    sources.push({ file, identity: identity(file) });
    if (sources.length === 4) break;
  }
  return sources;
}

/** A cold HTTP request queues work and returns 202. Cache hits serve an image. */
export async function serveFileThumbnail(
  req: Request,
  opts: ThumbnailOptions = {},
): Promise<Response> {
  const rel = new URL(req.url).searchParams.get("path");
  if (rel === null) return problem("invalid_path", 400);
  const started = performance.now();
  let root: string;
  try {
    root = realpathSync(opts.root ?? coordRoot());
  } catch {
    return problem("config_error", 500);
  }
  let sources: Source[] = [];
  let transferred = false;
  let folder = false;
  const file = resolveFile(rel, { root });
  if (file.ok) {
    sources = [{ file, identity: identity(file) }];
    if (!canRenderThumbnail(file.category, file.relPath)) {
      closeSources(sources);
      return problem("unsupported", 415);
    }
    if (file.size > limit(file)) {
      closeSources(sources);
      return problem("too_large", 413);
    }
  } else {
    if (file.code !== "not_file" && rel !== "") return fileErrorResponse(file);
    const dir = resolveDir(rel, { root });
    if (!dir.ok) return fileErrorResponse(dir);
    sources = await folderSources(rel, root);
    folder = true;
    if (!sources.length) return problem("unsupported", 415);
  }
  try {
    const dependencies = await Promise.all(
      sources.map(({ file }) => thumbnailDependencyKey(file, root)),
    );
    if (sources.some((source) => identity(source.file) !== source.identity))
      return problem("source_changed", 409);
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          VERSION,
          root,
          rel,
          folder,
          dependencies,
          sources.map((s) => [s.file.relPath, s.identity]),
        ]),
      )
      .digest("hex");
    const headers: Record<string, string> = {
      "content-type": "image/webp",
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      etag: `W/"${key}"`,
    };
    const respond = (bytes: Buffer, hit: string, generation = 0) => {
      headers["x-thumbnail-cache"] = hit;
      headers["server-timing"] =
        `thumbnail;dur=${(performance.now() - started).toFixed(1)}, render;dur=${generation.toFixed(1)}`;
      if (req.headers.get("if-none-match") === headers.etag)
        return new Response(null, { status: 304, headers });
      return new Response(new Uint8Array(bytes), { headers });
    };
    const cached = memory.get(key);
    if (cached) {
      remember(key, cached);
      return respond(cached, "memory");
    }

    const stored = await readThumbnailDisk(root, key);
    if (stored) {
      remember(key, stored);
      return respond(stored, "disk");
    }
    const failure = failures.get(key);
    if (failure && failure.until > Date.now()) return problem(failure.error, 422);
    let work = pending.get(key);
    if (!work) {
      if (pending.size >= 32) return problem("thumbnail_busy", 503);
      let finish!: (result: Result) => void;
      work = new Promise<Result>((resolve) => {
        finish = resolve;
      });
      pending.set(key, work);
      transferred = true;
      queue.push({
        key,
        finish,
        run: async () => {
          const start = performance.now();
          try {
            const bytes = await generate(sources, root, folder);
            if (bytes.length > MAX_OUTPUT) throw new Error("thumbnail_output_limit");
            remember(key, bytes);
            await writeThumbnailDisk(root, key, bytes);
            return { bytes, ms: performance.now() - start };
          } catch (error) {
            const reason = (error as Error).message.startsWith("converter_missing:")
              ? "converter_missing"
              : "thumbnail_unavailable";
            failures.set(key, { error: reason, until: Date.now() + 60_000 });
            if (failures.size > 128) failures.delete(failures.keys().next().value!);
            return { error: reason, ms: performance.now() - start };
          } finally {
            closeSources(sources);
          }
        },
      });
      drain();
    }
    if (opts.wait) {
      const result = await work;
      return result.bytes
        ? respond(result.bytes, "generated", result.ms)
        : problem(result.error!, 422);
    }
    return Response.json(
      { status: "pending" },
      {
        status: 202,
        headers: {
          "cache-control": "no-store",
          "retry-after": "0",
          "server-timing": `thumbnail;dur=${(performance.now() - started).toFixed(1)}`,
        },
      },
    );
  } catch {
    return problem("thumbnail_unavailable", 422);
  } finally {
    if (!transferred) closeSources(sources);
  }
}
/** Clear process-local state after jobs finish; persisted images remain reusable. */
export async function __resetThumbnailMemory(): Promise<void> {
  await Promise.all(pending.values());
  memory.clear();
  memoryBytes = 0;
  failures.clear();
}
