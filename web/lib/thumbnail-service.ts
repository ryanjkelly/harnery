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
import { noteThumbnailFolder } from "./thumbnail-activity";
import { readThumbnailDisk, writeThumbnailDisk } from "./thumbnail-disk-cache";
import {
  awaitThumbnail,
  createThumbnailQueue,
  type ThumbnailCost,
  type ThumbnailPriority,
} from "./thumbnail-queue";
import {
  canRenderThumbnail,
  renderThumbnail,
  thumbnailDescriptorPath,
} from "./thumbnail-renderers";
import { thumbnailDependencyKey } from "./thumbnail-renderers/dependencies";
import { resolveThumbnailReuse, type ThumbnailReuse } from "./thumbnail-reuse";

// Bump when rendering rules change; disk entries are disposable derivatives.
const VERSION = "v3";
const MAX_OUTPUT = 512 * 1024;
const MEMORY_BYTES = 16 * 1024 * 1024;

const OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;
type Source = { file: ResolvedFile; identity: string; reuse?: ThumbnailReuse | null };
type Result = { bytes?: Buffer; error?: string; ms: number };
function createState() {
  return {
    memory: new Map<string, Buffer>(),
    failures: new Map<string, { error: string; until: number }>(),
    queue: createThumbnailQueue<Result>(),
    persisting: new Set<Promise<void>>(),
    memoryBytes: 0,
  };
}
// Instrumentation and route bundles must share one process-wide queue and cache.
const globalState = globalThis as typeof globalThis & {
  __harneryThumbnailsV3?: ReturnType<typeof createState>;
};
globalState.__harneryThumbnailsV3 ??= createState();
const state = globalState.__harneryThumbnailsV3;
const { memory, failures, queue } = state;

export interface ThumbnailOptions extends ResolveOptions {
  /** Offline tests/benchmarks may wait; HTTP requests always return promptly. */
  wait?: boolean;
  waitMs?: number;
  priority?: ThumbnailPriority;
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
  for (const { file, reuse } of sources) {
    closeSync(file.fd);
    if (reuse?.kind === "file") closeSync(reuse.file.fd);
  }
}
function remember(key: string, bytes: Buffer) {
  const old = memory.get(key);
  if (old) state.memoryBytes -= old.length;
  memory.delete(key);
  memory.set(key, bytes);
  state.memoryBytes += bytes.length;
  while (memory.size > 128 || state.memoryBytes > MEMORY_BYTES) {
    const oldest = memory.keys().next().value!;
    state.memoryBytes -= memory.get(oldest)!.length;
    memory.delete(oldest);
  }
}
/** Media borrows a checked descriptor; other converters receive a private snapshot. */
async function renderSource(
  source: Source,
  root: string,
  temporary: string,
  index: number,
): Promise<Buffer> {
  if (identity(source.file) !== source.identity) throw new Error("source_changed");
  if (source.reuse?.kind === "bytes") {
    return sharp(source.reuse.bytes, { limitInputPixels: 32_000_000 })
      .rotate()
      .resize(360, 240, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 72 })
      .timeout({ seconds: 5 })
      .toBuffer();
  }
  const file = source.reuse?.kind === "file" ? source.reuse.file : source.file;
  const expectedIdentity = source.reuse?.kind === "file" ? source.reuse.identity : source.identity;
  if (identity(file) !== expectedIdentity) throw new Error("source_changed");
  if ((file.category === "audio" || file.category === "video") && thumbnailDescriptorPath()) {
    const bytes = await renderThumbnail({
      inputPath: "",
      inputFd: file.fd,
      relPath: file.relPath,
      category: file.category,
      root,
    });
    // A descriptor survives renames, but in-place writes must invalidate the result before caching.
    if (identity(file) !== expectedIdentity) throw new Error("source_changed");
    return bytes;
  }
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
  if (identity(file) !== expectedIdentity) throw new Error("source_changed");
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

/** Serve cached images or wait briefly for queued work; unfinished requests return 202. */
export async function serveFileThumbnail(
  req: Request,
  opts: ThumbnailOptions = {},
): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const rel = params.get("path");
  const requestedPriority = opts.priority ?? params.get("priority");
  const priority: ThumbnailPriority =
    requestedPriority === "background" || requestedPriority === "prefetch"
      ? requestedPriority
      : "visible";
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
    if (priority === "visible") noteThumbnailFolder(root, folder ? rel : path.posix.dirname(rel));
    // Assign each successful reuse immediately so partial failures still close every returned fd.
    for (const source of sources) source.reuse = await resolveThumbnailReuse(source.file, root);
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
          sources.map((s) => [
            s.file.relPath,
            s.identity,
            s.reuse && [
              s.reuse.provenance,
              s.reuse.identity,
              s.reuse.kind === "file" ? s.reuse.file.relPath : "embedded",
            ],
          ]),
        ]),
      )
      .digest("hex");
    const headers: Record<string, string> = {
      "content-type": "image/webp",
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      etag: `W/"${key}"`,
      "x-thumbnail-source": sources.some((source) => source.reuse)
        ? sources.map((source) => source.reuse?.provenance ?? "rendered").join(",")
        : "rendered",
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
    const cost: ThumbnailCost = sources.some(
      ({ file, reuse }) =>
        !reuse &&
        (["html", "pdf", "audio", "video"].includes(file.category) || OFFICE.test(file.relPath)),
    )
      ? "expensive"
      : "fast";
    const submitted = queue.submit(key, priority, cost, async () => {
      const start = performance.now();
      try {
        const bytes = await generate(sources, root, folder);
        if (bytes.length > MAX_OUTPUT) throw new Error("thumbnail_output_limit");
        remember(key, bytes);
        // Cache maintenance is bounded separately and must not delay visible pixels.
        const persistence = writeThumbnailDisk(root, key, bytes);
        state.persisting.add(persistence);
        void persistence.finally(() => state.persisting.delete(persistence));
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
    });
    if (!submitted) return problem("thumbnail_busy", 503);
    transferred = submitted.created;
    const requestedWait =
      opts.waitMs ??
      (params.has("wait")
        ? Number(params.get("wait"))
        : cost === "fast" && priority === "visible"
          ? 40
          : 0);
    const waitMs = Number.isFinite(requestedWait) ? Math.max(0, Math.min(1000, requestedWait)) : 0;
    const result = opts.wait
      ? await submitted.promise
      : await awaitThumbnail(submitted.promise, waitMs, req.signal);
    if (result) {
      // A bounded HTTP wait can span a file replacement or access-policy change.
      for (const source of sources) {
        const current = resolveFile(source.file.relPath, { root });
        if (!current.ok) return fileErrorResponse(current);
        try {
          if (identity(current) !== source.identity) return problem("source_changed", 409);
        } finally {
          closeSync(current.fd);
        }
        if (source.reuse?.kind === "file") {
          const preview = resolveFile(source.reuse.file.relPath, { root });
          if (!preview.ok) return fileErrorResponse(preview);
          try {
            if (identity(preview) !== source.reuse.identity) return problem("source_changed", 409);
          } finally {
            closeSync(preview.fd);
          }
        }
      }
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
  await queue.idle();
  await Promise.all(state.persisting);
  memory.clear();
  state.memoryBytes = 0;
  failures.clear();
}

export function thumbnailQueueStatus() {
  return { pending: queue.size, visible: queue.hasVisibleWork };
}
